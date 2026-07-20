# Harness Phase 1: Runtime Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `osprey/harness/` (neutral types + `AgentHarness` protocol + registry + `harness:` config key) with a `ClaudeCodeHarness` that delegates to the existing `agent_runner` code, and route `osprey query` through it — behavior identical, all existing tests green.

**Architecture:** Strangler pattern. No Claude code moves in this phase; the adapter calls `osprey.agent_runner.runner.run_query` in place. The protocol has exactly the members Phase 1 consumes (`name`, `available`, `run_query`); later phases add members when their consumers migrate. See `docs/superpowers/specs/2026-07-20-harness-abstraction-design.md`.

**Tech Stack:** Python 3.11+, dataclasses, ABC, PyYAML, pytest (existing repo conventions; no new deps).

## Global Constraints

- `harness:` absent from `config.yml` MUST default to `claude_code` (zero breakage for existing projects).
- Unknown harness name MUST hard-error listing supported names — never silently fall back.
- No new runtime dependency; no import of `claude_agent_sdk` from any new `harness/` module (delegate to `agent_runner`, which already guards with `HAS_SDK`).
- All modules importable when `claude_agent_sdk` is absent (repo convention).
- Commit style: conventional commits (`feat(harness): …`), matching `git log`.
- Do not run formatters or the full project test suite per-task; the repo's pre-commit handles style. Verification phase runs the affected suites once.

---

### Task 1: Neutral types + protocol (`types.py`, `base.py`)

**Files:**
- Create: `src/osprey/harness/__init__.py` (stub for imports; finalized in Task 3)
- Create: `src/osprey/harness/types.py`
- Create: `src/osprey/harness/base.py`
- Create: `tests/harness/__init__.py` (empty, mirrors `tests/agent_runner/__init__.py`)
- Test: `tests/harness/test_base.py`

**Interfaces:**
- Produces: `RunOptions(disallowed_tools: tuple[str, ...] = (), max_turns: int = 25, max_budget_usd: float = 2.0, model: str | None = None)` frozen dataclass; `AgentRunResult`/`ToolTrace` aliases; `AgentHarness` ABC with `name: ClassVar[str]`, `available() -> tuple[bool, str]`, `async run_query(project_dir, prompt, *, options) -> AgentRunResult`; exceptions `HarnessError(RuntimeError)`, `HarnessConfigError(HarnessError)`.
- Consumes: `osprey.agent_runner.primitives.{SDKWorkflowResult, ToolTrace}` (aliased, not modified).

- [ ] **Step 1: Write the failing test**

```python
# tests/harness/test_base.py
"""Contract tests for the harness-neutral types and protocol."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from osprey.harness.base import AgentHarness, HarnessConfigError, HarnessError
from osprey.harness.types import AgentRunResult, RunOptions


class TestRunOptions:
    def test_defaults(self) -> None:
        opts = RunOptions()
        assert opts.disallowed_tools == ()
        assert opts.max_turns == 25
        assert opts.max_budget_usd == 2.0
        assert opts.model is None

    def test_frozen(self) -> None:
        opts = RunOptions()
        with pytest.raises(dataclasses.FrozenInstanceError):
            opts.max_turns = 1  # type: ignore[misc]


class TestAgentRunResult:
    def test_is_the_canonical_workflow_result(self) -> None:
        # Strangler invariant: one result type, no parallel convention.
        from osprey.agent_runner.primitives import SDKWorkflowResult

        assert AgentRunResult is SDKWorkflowResult


class TestAgentHarness:
    def test_is_abstract(self) -> None:
        with pytest.raises(TypeError):
            AgentHarness()  # type: ignore[abstract]

    def test_subclass_contract(self) -> None:
        class Fake(AgentHarness):
            name = "fake"

            def available(self) -> tuple[bool, str]:
                return True, ""

            async def run_query(
                self, project_dir: Path, prompt: str, *, options: RunOptions
            ) -> AgentRunResult:
                return AgentRunResult()

        assert Fake().available() == (True, "")


class TestErrors:
    def test_config_error_is_runtime_error(self) -> None:
        # osprey query catches RuntimeError -> EXIT_USAGE; config errors must ride that path.
        assert issubclass(HarnessConfigError, HarnessError)
        assert issubclass(HarnessError, RuntimeError)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/harness/test_base.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'osprey.harness'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/osprey/harness/__init__.py  (stub; Task 3 finalizes the public surface)
"""Harness abstraction layer — see docs/superpowers/specs/2026-07-20-harness-abstraction-design.md."""
```

```python
# src/osprey/harness/types.py
"""Harness-neutral option and result types.

``AgentRunResult`` and ``ToolTrace`` currently alias the structures in
``osprey.agent_runner.primitives``; they migrate here physically when the
Claude Code internals move under ``osprey.harness.claude_code`` (Phase 4+ of
the harness roadmap — see the design spec). Callers should import from HERE
so that move is a no-op for them.
"""

from __future__ import annotations

from dataclasses import dataclass

from osprey.agent_runner.primitives import SDKWorkflowResult as AgentRunResult
from osprey.agent_runner.primitives import ToolTrace

__all__ = ["AgentRunResult", "RunOptions", "ToolTrace"]


@dataclass(frozen=True)
class RunOptions:
    """Harness-neutral knobs for a headless agent run.

    Grows ``allowed_tools``/approval-callback/system-prompt fields as the
    dispatch and operator paths migrate (Phase 4); keep it minimal until a
    consumer exists.
    """

    disallowed_tools: tuple[str, ...] = ()
    max_turns: int = 25
    max_budget_usd: float = 2.0
    model: str | None = None
```

```python
# src/osprey/harness/base.py
"""The AgentHarness protocol every coding-agent harness adapter implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, ClassVar

if TYPE_CHECKING:
    from pathlib import Path

    from osprey.harness.types import AgentRunResult, RunOptions

__all__ = ["AgentHarness", "HarnessConfigError", "HarnessError"]


class HarnessError(RuntimeError):
    """Base error for harness selection/execution failures.

    Subclasses RuntimeError so existing CLI handlers (e.g. ``osprey query``'s
    usage-error path) treat harness failures as usage errors without new
    except clauses.
    """


class HarnessConfigError(HarnessError):
    """The project's ``harness:`` config key is unknown or malformed."""


class AgentHarness(ABC):
    """One coding-agent harness (Claude Code, pi, ...).

    Phase 1 exposes only the single-turn headless surface. Members are added
    when their consumers migrate (sessions/dispatch: Phase 4; launch and
    artifact rendering: Phase 5) — do not pre-declare unimplemented members.
    """

    name: ClassVar[str]

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """Return ``(True, "")`` when this harness can run on this host,
        else ``(False, reason)`` with an actionable install hint."""

    @abstractmethod
    async def run_query(
        self, project_dir: Path, prompt: str, *, options: RunOptions
    ) -> AgentRunResult:
        """Run a single-turn headless query against *project_dir*."""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/harness/test_base.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/osprey/harness tests/harness
git commit -m "feat(harness): add neutral RunOptions/AgentRunResult types and AgentHarness protocol"
```

---

### Task 2: Claude Code adapter (`claude_code.py`)

**Files:**
- Create: `src/osprey/harness/claude_code.py`
- Test: `tests/harness/test_claude_code.py`

**Interfaces:**
- Produces: `ClaudeCodeHarness(AgentHarness)` with `name = "claude_code"`; `available()` keyed off `osprey.agent_runner.runner.HAS_SDK`; `run_query` delegating 1:1 to `osprey.agent_runner.runner.run_query`.
- Consumes: `RunOptions`, `AgentHarness` from Task 1; `agent_runner.runner` module (imported as a module so tests patch `osprey.agent_runner.runner.run_query` — the same seam `tests/agent_runner/test_runner.py` already uses).

- [ ] **Step 1: Write the failing test**

```python
# tests/harness/test_claude_code.py
"""ClaudeCodeHarness delegates to agent_runner without altering semantics."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from osprey.harness.claude_code import ClaudeCodeHarness
from osprey.harness.types import AgentRunResult, RunOptions


class TestAvailability:
    def test_available_with_sdk(self) -> None:
        with patch("osprey.agent_runner.runner.HAS_SDK", True):
            ok, reason = ClaudeCodeHarness().available()
        assert ok is True
        assert reason == ""

    def test_unavailable_names_the_package(self) -> None:
        with patch("osprey.agent_runner.runner.HAS_SDK", False):
            ok, reason = ClaudeCodeHarness().available()
        assert ok is False
        assert "claude-agent-sdk" in reason


class TestRunQueryDelegation:
    @pytest.mark.asyncio
    async def test_options_map_onto_run_query_kwargs(self, tmp_path: Path) -> None:
        expected = AgentRunResult()
        mock = AsyncMock(return_value=expected)
        options = RunOptions(
            disallowed_tools=("mcp__controls__channel_write", "Bash"),
            max_turns=7,
            max_budget_usd=1.25,
            model="claude-sonnet-4-6",
        )
        with patch("osprey.agent_runner.runner.run_query", mock):
            result = await ClaudeCodeHarness().run_query(tmp_path, "prompt", options=options)

        assert result is expected
        mock.assert_awaited_once_with(
            tmp_path,
            "prompt",
            disallowed_tools=["mcp__controls__channel_write", "Bash"],
            max_turns=7,
            max_budget_usd=1.25,
            model="claude-sonnet-4-6",
        )
```

Note: if `pytest.mark.asyncio` is not enabled repo-wide, mirror whatever async convention `tests/agent_runner/test_runner.py` uses (it runs async tests today — copy its marker/fixture style verbatim).

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/harness/test_claude_code.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'osprey.harness.claude_code'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/osprey/harness/claude_code.py
"""Claude Code harness adapter.

Strangler-phase adapter: delegates to the existing ``osprey.agent_runner``
implementation in place. The SDK wiring (options building, stream draining,
MCP readiness, proxy lifecycle) physically migrates under this module in
later phases; callers must depend on ``osprey.harness``, never on
``agent_runner`` internals.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from osprey.agent_runner import runner as _runner
from osprey.harness.base import AgentHarness

if TYPE_CHECKING:
    from pathlib import Path

    from osprey.harness.types import AgentRunResult, RunOptions

__all__ = ["ClaudeCodeHarness"]


class ClaudeCodeHarness(AgentHarness):
    """Osprey's original harness: Anthropic's Claude Code CLI + Python SDK."""

    name: ClassVar[str] = "claude_code"

    def available(self) -> tuple[bool, str]:
        if _runner.HAS_SDK:
            return True, ""
        return (
            False,
            "claude_agent_sdk is not installed (pip install claude-agent-sdk)",
        )

    async def run_query(
        self, project_dir: Path, prompt: str, *, options: RunOptions
    ) -> AgentRunResult:
        return await _runner.run_query(
            project_dir,
            prompt,
            disallowed_tools=list(options.disallowed_tools),
            max_turns=options.max_turns,
            max_budget_usd=options.max_budget_usd,
            model=options.model,
        )
```

Note: `available()` reads `_runner.HAS_SDK` at call time (module attribute, not a from-import), so the `patch("osprey.agent_runner.runner.HAS_SDK", …)` seam works. Same for `_runner.run_query`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/harness/test_claude_code.py -q`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/osprey/harness/claude_code.py tests/harness/test_claude_code.py
git commit -m "feat(harness): ClaudeCodeHarness adapter delegating to agent_runner"
```

---

### Task 3: Registry + `harness:` config key + public API

**Files:**
- Create: `src/osprey/harness/registry.py`
- Modify: `src/osprey/harness/__init__.py`
- Test: `tests/harness/test_registry.py`

**Interfaces:**
- Produces: `DEFAULT_HARNESS = "claude_code"`; `known_harnesses() -> list[str]`; `harness_name_for_project(project_dir: Path) -> str` (reads top-level `harness` key of `<project>/config.yml`); `get_harness(project_dir: Path) -> AgentHarness`. Public package surface: `from osprey.harness import AgentHarness, AgentRunResult, ClaudeCodeHarness, HarnessConfigError, HarnessError, RunOptions, ToolTrace, get_harness, harness_name_for_project, known_harnesses, DEFAULT_HARNESS`.
- Consumes: Tasks 1–2.

- [ ] **Step 1: Write the failing test**

```python
# tests/harness/test_registry.py
"""Harness selection from project config — fail closed on unknown names."""

from __future__ import annotations

from pathlib import Path

import pytest

from osprey.harness import (
    DEFAULT_HARNESS,
    HarnessConfigError,
    get_harness,
    harness_name_for_project,
    known_harnesses,
)
from osprey.harness.claude_code import ClaudeCodeHarness


def _project(tmp_path: Path, config_text: str | None) -> Path:
    if config_text is not None:
        (tmp_path / "config.yml").write_text(config_text)
    return tmp_path


class TestNameResolution:
    def test_no_config_file_defaults(self, tmp_path: Path) -> None:
        assert harness_name_for_project(_project(tmp_path, None)) == DEFAULT_HARNESS

    def test_missing_key_defaults(self, tmp_path: Path) -> None:
        project = _project(tmp_path, "control_system:\n  type: mock\n")
        assert harness_name_for_project(project) == DEFAULT_HARNESS

    def test_explicit_key_wins(self, tmp_path: Path) -> None:
        project = _project(tmp_path, "harness: claude_code\n")
        assert harness_name_for_project(project) == "claude_code"

    def test_malformed_yaml_raises_config_error(self, tmp_path: Path) -> None:
        project = _project(tmp_path, "harness: [unclosed\n")
        with pytest.raises(HarnessConfigError, match="config.yml"):
            harness_name_for_project(project)

    def test_non_string_value_raises(self, tmp_path: Path) -> None:
        project = _project(tmp_path, "harness: [a, b]\n")
        with pytest.raises(HarnessConfigError, match="harness"):
            harness_name_for_project(project)


class TestGetHarness:
    def test_default_is_claude_code(self, tmp_path: Path) -> None:
        harness = get_harness(_project(tmp_path, None))
        assert isinstance(harness, ClaudeCodeHarness)

    def test_unknown_name_fails_closed_listing_supported(self, tmp_path: Path) -> None:
        project = _project(tmp_path, "harness: codex\n")
        with pytest.raises(HarnessConfigError, match="claude_code"):
            get_harness(project)

    def test_known_harnesses_contains_claude_code(self) -> None:
        assert "claude_code" in known_harnesses()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/harness/test_registry.py -q`
Expected: FAIL — `ImportError: cannot import name 'DEFAULT_HARNESS' from 'osprey.harness'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/osprey/harness/registry.py
"""Harness selection: the ``harness:`` key in a project's ``config.yml``."""

from __future__ import annotations

from typing import TYPE_CHECKING

import yaml  # type: ignore[import-untyped]

from osprey.harness.base import AgentHarness, HarnessConfigError
from osprey.harness.claude_code import ClaudeCodeHarness

if TYPE_CHECKING:
    from pathlib import Path

__all__ = ["DEFAULT_HARNESS", "get_harness", "harness_name_for_project", "known_harnesses"]

DEFAULT_HARNESS = "claude_code"

_HARNESSES: dict[str, type[AgentHarness]] = {
    ClaudeCodeHarness.name: ClaudeCodeHarness,
}


def known_harnesses() -> list[str]:
    """Sorted names of every registered harness."""
    return sorted(_HARNESSES)


def harness_name_for_project(project_dir: Path) -> str:
    """Resolve the harness name for *project_dir*.

    Reads the top-level ``harness`` key of ``config.yml``. Absent file or key
    defaults to ``claude_code`` (existing projects predate the key). A
    malformed file or non-string value raises: harness selection must never
    silently fall back on a config the user *did* write.
    """
    config_path = project_dir / "config.yml"
    if not config_path.is_file():
        return DEFAULT_HARNESS
    try:
        data = yaml.safe_load(config_path.read_text()) or {}
    except yaml.YAMLError as exc:
        raise HarnessConfigError(f"could not parse {config_path}: {exc}") from exc
    name = data.get("harness", DEFAULT_HARNESS)
    if not isinstance(name, str) or not name:
        raise HarnessConfigError(
            f"config key 'harness' must be a string, got {name!r} in {config_path}"
        )
    return name


def get_harness(project_dir: Path) -> AgentHarness:
    """Instantiate the harness configured for *project_dir* (fail-closed)."""
    name = harness_name_for_project(project_dir)
    try:
        harness_cls = _HARNESSES[name]
    except KeyError:
        raise HarnessConfigError(
            f"unknown harness {name!r} in {project_dir / 'config.yml'} "
            f"(supported: {', '.join(known_harnesses())})"
        ) from None
    return harness_cls()
```

```python
# src/osprey/harness/__init__.py  (replace stub)
"""Harness abstraction layer.

Selects and drives a coding-agent harness (Claude Code today; pi next) behind
one protocol so the rest of Osprey never imports harness-specific SDKs.
Design: docs/superpowers/specs/2026-07-20-harness-abstraction-design.md.
"""

from osprey.harness.base import AgentHarness, HarnessConfigError, HarnessError
from osprey.harness.claude_code import ClaudeCodeHarness
from osprey.harness.registry import (
    DEFAULT_HARNESS,
    get_harness,
    harness_name_for_project,
    known_harnesses,
)
from osprey.harness.types import AgentRunResult, RunOptions, ToolTrace

__all__ = [
    "DEFAULT_HARNESS",
    "AgentHarness",
    "AgentRunResult",
    "ClaudeCodeHarness",
    "HarnessConfigError",
    "HarnessError",
    "RunOptions",
    "ToolTrace",
    "get_harness",
    "harness_name_for_project",
    "known_harnesses",
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/harness -q`
Expected: PASS (all harness tests)

- [ ] **Step 5: Commit**

```bash
git add src/osprey/harness tests/harness
git commit -m "feat(harness): registry with fail-closed 'harness:' config key resolution"
```

---

### Task 4: Route `osprey query` through the registry

**Files:**
- Modify: `src/osprey/cli/query_cmd.py` (imports block lines ~33–40; call site line ~135)
- Modify: `tests/cli/test_query_cmd.py` (every `patch("osprey.cli.query_cmd.run_query", …)` site)

**Interfaces:**
- Consumes: `get_harness`, `RunOptions` from Task 3.
- Produces: `osprey query` behavior unchanged (same exit codes, same JSON, same error messages for missing SDK); `HarnessConfigError` surfaces as exit 2 (usage error) via the existing `except (ImportError, RuntimeError)` clause.

- [ ] **Step 1: Update the tests first (they define the new seam)**

In `tests/cli/test_query_cmd.py`, add near the other helpers:

```python
from osprey.harness import AgentRunResult, RunOptions  # noqa: F401  (RunOptions used in captures)


class _FakeHarness:
    """Stands in for get_harness(); records run_query calls."""

    name = "fake"

    def __init__(self, result=None, side_effect: Exception | None = None) -> None:
        self._result = result
        self._side_effect = side_effect
        self.calls: list[tuple[Path, str, RunOptions]] = []

    def available(self) -> tuple[bool, str]:
        return True, ""

    async def run_query(self, project_dir, prompt, *, options):
        self.calls.append((project_dir, prompt, options))
        if self._side_effect is not None:
            raise self._side_effect
        return self._result
```

Then mechanically replace every `patch("osprey.cli.query_cmd.run_query", new=AsyncMock(return_value=mock_result))` with:

```python
patch("osprey.cli.query_cmd.get_harness", return_value=_FakeHarness(mock_result)),
```

and error-path patches (`side_effect=ImportError(...)` etc.) with `_FakeHarness(side_effect=ImportError(...))`. For `TestWriteToolSafety.test_disallowed_tools_cover_mcp_and_builtin_writes` (line ~180), capture through the fake instead of `capturing_run_query`:

```python
        fake = _FakeHarness(mock_result)
        with (
            patch("osprey.cli.query_cmd.get_harness", return_value=fake),
            patch("osprey.cli.query_cmd._expected_mcp_servers", return_value={"controls"}),
        ):
            runner.invoke(query, ["--project", str(project_with_mcp), "safe query"])

        assert fake.calls, "run_query was never called"
        disallowed = list(fake.calls[0][2].disallowed_tools)
```

(keep the existing assertions on `disallowed` unchanged — they are the write-guard contract).

Enumerate patch sites first: `grep -n 'query_cmd.run_query' tests/cli/test_query_cmd.py` and update every one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/cli/test_query_cmd.py -q`
Expected: FAIL — `AttributeError: <module 'osprey.cli.query_cmd'> does not have the attribute 'get_harness'`

- [ ] **Step 3: Implement the routing**

In `src/osprey/cli/query_cmd.py`:

1. Imports — remove `run_query` from the `osprey.agent_runner` import block (keep `EXIT_USAGE`, `SDKWorkflowResult`, `_expected_mcp_servers`, `evaluate_verdict`, `read_only_disallowed_tools`) and add:

```python
from osprey.harness import RunOptions, get_harness
```

2. Call site (currently `result = asyncio.run(run_query(project_dir, prompt, disallowed_tools=disallowed_tools))` inside the first `try:`):

```python
    try:
        harness = get_harness(project_dir)
        result = asyncio.run(
            harness.run_query(
                project_dir,
                prompt,
                options=RunOptions(disallowed_tools=tuple(disallowed_tools)),
            )
        )
```

No new `except` clause needed: `HarnessConfigError` subclasses `RuntimeError`, which the existing handler maps to `EXIT_USAGE`.

3. Update the module docstring's "blocked at the SDK level" phrasing to "blocked at the harness level" where it names the mechanism (keep the exit-code documentation as is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/cli/test_query_cmd.py tests/harness -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/osprey/cli/query_cmd.py tests/cli/test_query_cmd.py
git commit -m "feat(harness): route osprey query through the harness registry"
```

---

### Task 5: Verification + changelog

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1: Run the affected suites**

Run: `pytest tests/harness tests/cli/test_query_cmd.py tests/agent_runner -q`
Expected: PASS, zero failures. (`tests/e2e/` remains SDK/CLI-gated and unaffected — spot-check nothing imports `query_cmd.run_query`: `grep -rn "query_cmd.run_query" tests/ src/` → no hits.)

- [ ] **Step 2: Smoke test the CLI path end-to-end (no SDK call needed)**

Run in a throwaway dir: `mkdir -p /tmp/hx && printf 'harness: nope\n' > /tmp/hx/config.yml && osprey query --project /tmp/hx "hi"; echo "exit=$?"`
Expected: `Error: unknown harness 'nope' … (supported: claude_code)` and `exit=2`.
Then: `printf 'harness: claude_code\n' > /tmp/hx/config.yml && osprey query --project /tmp/hx "hi"; echo "exit=$?"` — proceeds into config resolution exactly as an unconfigured project does today (provider error or SDK error, exit 2; the point is it selects the harness and reaches the pre-existing failure mode, not a harness error).

- [ ] **Step 3: Changelog entry**

Under `## [Unreleased]` / `### Added`:

```markdown
- **Harness abstraction (phase 1)** — a new top-level `harness:` config key selects the coding-agent harness for a project (`claude_code`, the default and only built-in for now; unknown names fail closed listing the supported set). `osprey query` now routes through the `osprey.harness` registry instead of calling the Claude Agent SDK path directly. No behavior change for existing projects; groundwork for running Osprey projects on additional harnesses.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): harness abstraction phase 1"
```

---

## Out of scope for this plan (tracked in the spec roadmap)

- Phase 2 spike (`mcp-bridge.ts`, `hook-bridge.ts`, `.pi/` render) — next plan; go/no-go gate.
- `open_session`/dispatch/operator migration (Phase 4), launch/artifact protocol members (Phase 5).
- `AgentRunResult` physical move + `SDKWorkflowResult` rename (Phase 7 cleanup).
- Documenting `harness:` in app-template `config.yml.j2` comments and presets (Phase 5, when a second value exists).

## Self-review notes

- Spec coverage: Phase 1 row of the roadmap fully covered by Tasks 1–5; no other spec section promises Phase-1 work.
- Type consistency: `RunOptions.disallowed_tools` is `tuple[str, ...]` end-to-end; adapter converts to `list` at the `run_query` boundary (existing signature).
- The `_FakeHarness` seam replaces `patch(...run_query)` at exactly the sites `grep 'query_cmd.run_query'` reports — Task 4 Step 1 requires enumerating them before editing.
