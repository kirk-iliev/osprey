"""Session diagnostics routes — agent hierarchy, logs, summaries, and chat."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict
from datetime import datetime
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request

from osprey.interfaces.web_terminal import transcript_map
from osprey.interfaces.web_terminal.session_discovery import SessionDiscovery

if TYPE_CHECKING:
    from pathlib import Path

    from osprey.mcp_server.workspace.transcript_reader import TranscriptReader

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/sessions")
async def list_sessions(request: Request):
    """Return Claude Code sessions registered for this project."""
    discovery = SessionDiscovery(request.app.state.project_cwd)
    sessions = discovery.list_sessions()
    return {"sessions": [asdict(s) for s in sessions]}


def _read_session_events(request: Request, reader: TranscriptReader) -> list[dict]:
    """Read session events, scoped to a session_id if provided.

    A session key is mapped to the transcript it points at now, as
    ``session_chat`` does.
    """
    session_id = request.query_params.get("session_id")
    if session_id:
        return reader.read_session_by_id(transcript_map.get(request.app, session_id))
    return reader.read_current_session()


@router.get("/api/session-agents")
async def session_agents(request: Request):
    """Return agent hierarchy and tool call breakdown for the current session."""
    try:
        from osprey.mcp_server.workspace.tools.session_log import _build_agent_summary
        from osprey.mcp_server.workspace.transcript_reader import TranscriptReader

        reader = TranscriptReader(request.app.state.project_cwd)
        events = _read_session_events(request, reader)
        agents = _build_agent_summary(events)

        # Group tool_call events by agent_id
        tool_calls_by_agent: dict[str, list[dict]] = {}
        for ev in events:
            if ev.get("type") != "tool_call":
                continue
            aid = ev.get("agent_id") or "main"
            tool_calls_by_agent.setdefault(aid, []).append(ev)

        return {
            "agents": agents,
            "tool_calls_by_agent": tool_calls_by_agent,
            "total_events": len(events),
        }
    except Exception:
        logger.debug("session-agents: no transcript available", exc_info=True)
        return {"agents": [], "tool_calls_by_agent": {}, "total_events": 0}


@router.get("/api/session-agent-timeline")
async def session_agent_timeline(request: Request):
    """Return the full internal timeline of a subagent."""
    agent_id = request.query_params.get("agent_id", "")
    if not agent_id:
        return {"timeline": [], "error": "agent_id required"}
    try:
        from osprey.mcp_server.workspace.transcript_reader import TranscriptReader

        reader = TranscriptReader(request.app.state.project_cwd)
        session_id = request.query_params.get("session_id")
        if session_id:
            session_id = transcript_map.get(request.app, session_id)
        timeline = reader.read_agent_timeline(agent_id, session_id=session_id)
        return {"agent_id": agent_id, "timeline": timeline, "count": len(timeline)}
    except Exception:
        logger.debug("session-agent-timeline: failed", exc_info=True)
        return {"agent_id": agent_id, "timeline": [], "count": 0}


@router.get("/api/session-log")
async def session_log(request: Request):
    """Return filtered tool call events from the current session."""
    try:
        from osprey.mcp_server.workspace.transcript_reader import TranscriptReader

        reader = TranscriptReader(request.app.state.project_cwd)
        events = _read_session_events(request, reader)

        # Parse query filters
        agent_filter = request.query_params.get("agent")
        agent_id_filter = request.query_params.get("agent_id")
        tool_filter = request.query_params.get("tool")
        errors_only = request.query_params.get("errors_only", "").lower() == "true"
        since = request.query_params.get("since")
        before = request.query_params.get("before")
        last_n = min(int(request.query_params.get("last_n", "100")), 500)

        # Filter to tool_call events
        filtered = [e for e in events if e.get("type") == "tool_call"]

        if agent_filter:
            filtered = [e for e in filtered if e.get("agent_type") == agent_filter]
        if agent_id_filter:
            filtered = [e for e in filtered if (e.get("agent_id") or "main") == agent_id_filter]
        if tool_filter:
            filtered = [
                e
                for e in filtered
                if tool_filter.lower() in (e.get("tool_name") or e.get("tool") or "").lower()
            ]
        if errors_only:
            filtered = [e for e in filtered if e.get("is_error")]
        if since:
            filtered = [e for e in filtered if e.get("timestamp", "") >= since]
        if before:
            filtered = [e for e in filtered if e.get("timestamp", "") < before]

        total = len(filtered)
        filtered = filtered[-last_n:]

        return {"events": filtered, "total_events": total, "showing": len(filtered)}
    except Exception:
        logger.debug("session-log: no transcript available", exc_info=True)
        return {"events": [], "total_events": 0, "showing": 0}


@router.get("/api/session-summary")
async def session_summary(request: Request):
    """Return artifact inventory with channel extraction for the current session."""
    try:
        from osprey.mcp_server.workspace.tools.session_summary import _extract_channels
        from osprey.stores.artifact_store import ArtifactStore

        store = ArtifactStore(request.app.state.workspace_dir)
        session_id = request.query_params.get("session_id")
        entries = store.list_entries(
            session_filter=session_id if session_id else None,
            # Session material, not a shipped example.
            exclude_examples=True,
        )

        total_bytes = 0
        categories: dict[str, int] = {}
        tools_used: set[str] = set()
        artifact_types: dict[str, int] = {}
        entry_dicts = []

        for entry in entries:
            total_bytes += entry.size_bytes
            cat = entry.category or "uncategorized"
            categories[cat] = categories.get(cat, 0) + 1
            if entry.tool_source:
                tools_used.add(entry.tool_source)
            artifact_types[entry.artifact_type] = artifact_types.get(entry.artifact_type, 0) + 1
            d = entry.to_dict()
            d["channels"] = _extract_channels(entry)
            entry_dicts.append(d)

        return {
            "entries": entry_dicts,
            "totals": {
                "entry_count": len(entries),
                "total_bytes": total_bytes,
                "categories": categories,
                "tools_used": sorted(tools_used),
                "artifact_types": artifact_types,
            },
        }
    except Exception:
        logger.debug("session-summary: no artifacts available", exc_info=True)
        return {
            "entries": [],
            "totals": {
                "entry_count": 0,
                "total_bytes": 0,
                "categories": {},
                "tools_used": [],
                "artifact_types": {},
            },
        }


#: Values of the ``full`` flag that lift the per-message cap. The browser sends
#: ``1``; the other spellings are accepted so an operator calling the endpoint
#: by hand is not handed a silently shortened conversation.
_FULL_HISTORY_VALUES = frozenset({"1", "true", "yes", "on"})

#: How the CLI opens the user message it injects when a background agent reports.
_TASK_NOTIFICATION_MARK = "<task-notification>"


def _notification_field(text: str, tag: str) -> str:
    """The contents of ``<tag>…</tag>`` in a task notification, or an empty string."""
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return match.group(1).strip() if match else ""


def _agent_done_event(text: str) -> dict[str, Any]:
    """The ``agent_done`` frame the live chat drew for this background agent's report."""
    status = _notification_field(text, "status")
    return {
        "type": "system",
        "subtype": "agent_done",
        "tool_use_id": _notification_field(text, "tool-use-id"),
        "status": "stopped" if status == "killed" else status,
        "summary": _notification_field(text, "summary"),
    }


def _wants_full_messages(request: Request) -> bool:
    """Whether the caller asked for whole messages via the ``full`` flag."""
    return request.query_params.get("full", "").strip().lower() in _FULL_HISTORY_VALUES


def _wants_events(request: Request) -> bool:
    """Whether the caller asked for agent turns as replayable chat events."""
    return request.query_params.get("events", "").strip().lower() in _FULL_HISTORY_VALUES


def _ts(value: Any) -> datetime | None:
    """A transcript timestamp as a datetime, or ``None`` when it is unreadable."""
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _chat_timeline(path: Path) -> list[dict[str, Any]]:
    """Read a transcript as the Simple chat's turns, agent turns carrying their events.

    A user turn is ``{role, content, timestamp}``. Everything the agent did up
    to the next user prompt is one assistant turn whose ``events`` are the
    frames a live stream would have carried — ``text``, ``thinking``,
    ``tool_use``, ``tool_result`` — closed by a ``result`` whose duration is
    read off the transcript's timestamps. ``content`` holds the turn's joined
    text, so a client that ignores ``events`` still replays the words.
    """
    from osprey.interfaces.web_terminal.operator_session import (
        _TOOL_RESULT_PREVIEW_CHARS,
        _format_tool_name,
    )
    from osprey.interfaces.web_terminal.routes.chat import _clip_input
    from osprey.mcp_server.workspace.transcript_reader import (
        _extract_text,
        is_bookkeeping_entry,
    )

    turns: list[dict[str, Any]] = []
    agent: dict[str, Any] | None = None
    started: datetime | None = None
    last: datetime | None = None

    def close_agent() -> None:
        nonlocal agent
        if agent is None:
            return
        duration = (last - started).total_seconds() * 1000 if started and last else None
        agent["events"].append({"type": "result", "is_error": False, "duration_ms": duration})
        agent["content"] = "\n\n".join(e["content"] for e in agent["events"] if e["type"] == "text")
        turns.append(agent)
        agent = None

    for line in path.read_text().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        kind = entry.get("type")
        if kind not in ("user", "assistant") or entry.get("isSidechain"):
            continue
        if is_bookkeeping_entry(entry):
            continue
        blocks = entry.get("message", {}).get("content", [])
        if isinstance(blocks, str):
            blocks = [{"type": "text", "text": blocks}]
        stamp = _ts(entry.get("timestamp", ""))

        if kind == "user":
            text = "\n".join(
                b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"
            ).strip()
            # A background agent's report is injected as a user message; it
            # continues the agent's turn rather than starting an operator one.
            if text and not text.startswith(_TASK_NOTIFICATION_MARK):
                close_agent()
                turns.append(
                    {"role": "user", "content": text, "timestamp": entry.get("timestamp", "")}
                )
                started = stamp
                continue

        if agent is None:
            agent = {
                "role": "assistant",
                "content": "",
                "events": [],
                "timestamp": entry.get("timestamp", ""),
            }
        if stamp is not None:
            last = stamp
        if kind == "user" and text.startswith(_TASK_NOTIFICATION_MARK):
            agent["events"].append(_agent_done_event(text))
            continue
        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text" and kind == "assistant" and block.get("text", "").strip():
                agent["events"].append({"type": "text", "content": block["text"]})
            elif btype == "thinking":
                agent["events"].append({"type": "thinking", "content": block.get("thinking", "")})
            elif btype == "tool_use":
                name = block.get("name", "")
                agent["events"].append(
                    {
                        "type": "tool_use",
                        "tool_name": _format_tool_name(name),
                        "tool_name_raw": name,
                        "tool_use_id": block.get("id", ""),
                        "input": _clip_input(block.get("input", {})),
                    }
                )
            elif btype == "tool_result":
                content = block.get("content")
                text = content if isinstance(content, str) else _extract_text(content or [])
                agent["events"].append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.get("tool_use_id", ""),
                        "is_error": bool(block.get("is_error")),
                        "preview": text[:_TOOL_RESULT_PREVIEW_CHARS],
                        "truncated": len(text) > _TOOL_RESULT_PREVIEW_CHARS,
                    }
                )
    close_agent()
    return turns


@router.get("/api/session-chat")
async def session_chat(request: Request):
    """Return conversation turns from a session's transcript.

    ``session_id`` names a session key, and a key stops naming its transcript
    the moment a ``/clear`` replaces the conversation, so the key is mapped
    through :mod:`osprey.interfaces.web_terminal.transcript_map` first: a caller
    that knows only its key still reads the conversation that key is on.

    ``full=1`` leaves each message whole, which is what replaying a conversation
    onto another surface needs. Without it the reader's own per-message cap
    stands, which is what the diagnostics view has always read.
    """
    try:
        from osprey.mcp_server.workspace.transcript_reader import TranscriptReader

        reader = TranscriptReader(request.app.state.project_cwd)
        session_id = request.query_params.get("session_id")
        if session_id:
            transcript_id = transcript_map.get(request.app, session_id)
            if _wants_events(request):
                path = reader.find_transcript_by_id(transcript_id)
                turns = _chat_timeline(path) if path else []
            elif _wants_full_messages(request):
                turns = reader.read_chat_history_by_id(transcript_id, max_chars=None)
            else:
                turns = reader.read_chat_history_by_id(transcript_id)
        else:
            turns = reader.read_current_chat_history()
        return {"turns": turns, "count": len(turns)}
    except Exception:
        logger.debug("session-chat: no transcript available", exc_info=True)
        return {"turns": [], "count": 0}
