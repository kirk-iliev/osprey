# Harness Abstraction: Osprey on Any Coding-Agent Harness

**Date:** 2026-07-20
**Branch:** `harness-abstraction` (fork `kirk-iliev/osprey`, based on `als-apg/osprey` `origin/main` @ `933fc4bc`)
**Status:** Approved design (strangler strategy confirmed)
**Companion:** `~/Documents/coding/osprey-pi-migration-briefing.md` (audit briefing this design executes)

## 1. Goal

Make Osprey's README claim true in code: *"the agent harness … is swappable by configuration."*
Today there is exactly one harness (Claude Code) and the coupling is spread across ~15 modules.
Deliverable: a `harness:` abstraction such that

- `harness: claude_code` (default) behaves exactly as today,
- `harness: pi` runs the same project on [pi-coding-agent](https://github.com/earendil-works/pi),
- adding `codex`, `omp` (Oh My Pi), or any future harness is additive adapter work, not surgery.

**Definition of "testable state"** (from the briefing): `osprey build quickstart --preset hello-world`
can emit a `.pi/` project; `pi` launches it with MCP tools + safety gates live; `osprey query` runs
headlessly through a Python RPC client; existing unit/parity suites pass on both harness paths
(mock connector — no real EPICS, no CBORG).

## 2. Current coupling inventory (verified by source scan, 2026-07-20)

Three planes. Everything below is Claude-Code-coupled; everything *not* listed (connectors, MCP
servers ~16k LOC, services, dispatch core, stores, simulation, web UIs) is harness-neutral already.

### 2.1 Runtime plane — `claude_agent_sdk` importers

| File | SDK symbols used | Role |
|---|---|---|
| `agent_runner/primitives.py` | ClaudeAgentOptions, ClaudeSDKClient, message/block types | `build_agent_options`, `_drain_response`, `_await_mcp_ready`, `SDKWorkflowResult`, `sdk_env` |
| `agent_runner/runner.py` | ClaudeSDKClient | `run_query` (single-turn, `osprey query`) |
| `agent_runner/session.py` | ClaudeSDKClient | `AgentSession` / `agent_session` / `run_turns` (multi-turn) |
| `mcp_server/dispatch_worker/sdk_runner.py` | query, HookMatcher, ClaudeAgentOptions | dispatch worker: `can_use_tool` backstop + PreToolUse hook, inactivity watchdog |
| `mcp_server/dispatch_worker/tool_policy.py` | PermissionResultAllow/Deny | deny-only PreToolUse hook, CC hook-output JSON shape |
| `interfaces/web_terminal/sdk_context.py` | PermissionResult*, CanUseTool, SystemPromptPreset | `build_system_prompt` (preset `claude_code`), tool allowlist callback |
| `interfaces/web_terminal/operator_session.py` | ClaudeSDKClient + all message/block types | web operator chat; `client.interrupt()` cancel |
| `cli/audit_cmd.py` | query, ClaudeAgentOptions | `osprey audit` |
| `services/channel_finder/benchmarks/sdk.py` + `backends/sdk_backend.py` | query + message types | benchmark SDK backend |

**SDK surface contract** (what any replacement adapter must cover):
`ClaudeAgentOptions(model, cwd, permission_mode, max_turns, max_budget_usd, env, setting_sources,
disallowed_tools, allowed_tools, system_prompt, can_use_tool, hooks, stderr)`;
`ClaudeSDKClient` → `.query()`, `.receive_response()`, `.get_mcp_status()`, `.interrupt()`;
one-shot `query()`; messages `AssistantMessage/UserMessage/SystemMessage/ResultMessage`; blocks
`TextBlock/ThinkingBlock/ToolUseBlock/ToolResultBlock`; `ResultMessage.total_cost_usd/num_turns/usage`.

### 2.2 Artifact plane — project build

- `templates/claude_code/` → renders `.claude/` (settings.json, 12 hooks, agents, rules, skills,
  output-styles, statusline), `.mcp.json`, `CLAUDE.md`.
- `cli/templates/claude_code.py` (841 ln): `build_claude_code_context`, regen, user-ownership.
- `cli/claude_code_resolver.py` (543 ln): `CLAUDE_CODE_PROVIDERS`, `ClaudeCodeModelSpec`,
  `MANAGED_ENV_VARS` scrub, `inject_provider_env` — the ANTHROPIC_* env contract.
- `cli/validate_claude_artifacts.py`, `cli/templates/manifest.py` (artifact catalog).
- **No `harness` config key exists.** The section is `claude_code:` in `config.yml`
  (servers/agents/provider/models/permissions). Presets: `profiles/presets/*.yml`.

### 2.3 Launch plane

- `utils/claude_launcher.py`: argv factory, npx pin `@anthropic-ai/claude-code@<ver>`,
  mandatory `--setting-sources project` (issue #355).
- `cli/claude_cmd.py`: interactive chat (regen → conflict guard → env inject → proxy → subprocess.run).
- `interfaces/web_terminal/pty_manager.py` + `app.py`: PTY spawn of the same argv.
- `infrastructure/proxy/` (Anthropic→OpenAI translation, 758 ln): exists **only** because Claude
  Code speaks Anthropic protocol. Started from 4 sites; becomes claude_code-adapter-internal.
- `cli/project_utils.py` (`~/.claude` trust/session paths), `web_terminal/session_discovery.py`
  (CC JSONL transcript format).

### 2.4 Already harness-neutral (preserve, do not fork)

- `ToolTrace`; `SDKWorkflowResult`'s fields/properties except `result: ResultMessage` and
  `system_messages: list[SystemMessage]`; `mcp_servers` snapshot is dict-shaped already.
- `AgentSession` budget/turn logic (client-injected by design).
- All of `write_tools.py`'s policy computation (registry walk, destructive-name scan, hook_config
  read) — **except** `_BUILTIN_UNSAFE_TOOLS` which hardcodes CC builtin names
  (`Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch`). Pi's builtins are lowercase
  (`bash, edit, write, grep, find, ls, read`). → per-harness builtin floor.
- `mcp__<server>__<tool>` naming in every policy list — preserved verbatim on pi by the MCP bridge.
- `.mcp.json`, `CLAUDE.md`, skills (agentskills.io standard — pi discovers `.agents/skills` natively).

## 3. Target architecture

```
src/osprey/harness/
    __init__.py       # public API: get_harness, AgentHarness, RunOptions, errors
    types.py          # neutral types: RunOptions, AgentRunResult, ToolTrace (aliases at first)
    base.py           # AgentHarness ABC + HarnessError/HarnessConfigError/...
    registry.py       # name -> class map; harness_name_for_project(config.yml)
    claude_code.py    # adapter delegating to existing agent_runner/* (grows into a package
                      # as launch/artifact/proxy code physically migrates under it)
    pi/               # (Phase 3+) rpc.py JSONL client, launcher.py, artifacts
src/osprey/templates/pi/          # (Phase 2+) .pi/settings.json.j2, extensions/*.ts, SYSTEM.md.j2
```

**Strategy: strangler.** The protocol is introduced first with a `ClaudeCodeHarness` that
*delegates in place* to `agent_runner`. Callers switch to `get_harness(project_dir)`. Claude
internals physically migrate under `harness/claude_code/` only when a later phase touches them
anyway. Tests stay green at every commit.

### 3.1 Protocol (grows member-by-member, only when a second consumer exists)

Phase 1 (runtime, single-turn):

```python
class AgentHarness(ABC):
    name: ClassVar[str]
    def available(self) -> tuple[bool, str]: ...           # (ok, reason-if-not)
    async def run_query(self, project_dir: Path, prompt: str,
                        *, options: RunOptions) -> AgentRunResult: ...
```

Target (end state; add as phases land — do NOT pre-declare unimplemented members):

- `open_session(project_dir, *, options) -> AsyncContextManager[HarnessSession]` (Phase 4)
- `run_dispatch(...)` or a policy-callback hook surface for the dispatch worker (Phase 4)
- `build_launch_argv(project_dir, *, resume, print_mode, effort) -> (argv, env)` (Phase 5)
- `render_artifacts(project_dir, config) / regen / artifact_layout()` (Phase 5)
- `builtin_unsafe_tools() -> list[str]` (Phase 5; per-harness write floor)

### 3.2 Neutral types

- `RunOptions(disallowed_tools, max_turns, max_budget_usd, model)` — frozen dataclass; grows
  `allowed_tools`, `approval` (callback), `system_prompt_append`, `env` as dispatch/operator paths
  migrate.
- `AgentRunResult` — initially an alias of `SDKWorkflowResult` (its fields are already
  structurally neutral; consumers use properties/getattr). When claude internals move
  (Phase 4/7), the dataclass physically moves to `harness/types.py`, `result`/`system_messages`
  become neutral (`usage: dict`, `system_events: list[dict]`, `raw: Any` escape hatch), and the
  old name dies (clean cutover; mechanical rename across benchmarks/tests).
- `ToolTrace` — moves as-is (already neutral).

### 3.3 Config

```yaml
harness: claude_code   # top-level key; "claude_code" | "pi"; absent -> claude_code
claude_code: { ... }   # existing section, unchanged
pi:                    # pi-specific knobs (Phase 3+)
  cli_version: 0.80.7  # npx pin, mirrors claude_code.cli_version
```

- Missing key → `claude_code`: zero breakage for existing upstream projects.
- Unknown value → hard error listing supported harnesses (fail-closed, never silent fallback).
- Presets grow a `harness` field; `hello-world` gains a pi variant (or `--set harness=pi`).

### 3.4 Safety model (the invariant that must survive review)

One osprey-owned policy source of truth, per-harness enforcement bindings:

| Layer | Source of truth (shared) | Claude Code binding | Pi binding |
|---|---|---|---|
| Write kill-switch | `hook_config.json` `write_tools` + registry walk (`write_tools.py`) | PreToolUse `osprey_writes_check.py` + settings deny | `hook-bridge.ts` execs the *same* Python hook |
| Approval gate | `osprey_approval.py` | PreToolUse hook, ASK via CLI dialog | same script via hook-bridge; ASK → `ctx.ui.confirm()` (works over RPC) |
| Limits | `osprey_limits.py` | PreToolUse hook | same script via hook-bridge |
| Headless read-only floor | `read_only_disallowed_tools()` | SDK `disallowed_tools` (`--disallowedTools`) | fail-closed: bridge does not register write tools / `pi.setActiveTools` narrowing |
| Builtin write floor | per-harness list | `Bash, Write, Edit, …` | `bash, write, edit, …` |

Hook-bridge (option (b) from the briefing) keeps the 12 Python hooks and their parity/drift-guard
test suites intact — that is the safety regression anchor. Deny-dominates ordering:
writes_check → approval → limits; any deny short-circuits; a thrown error in a pi `tool_call`
handler blocks the tool (fail-closed by construction).

## 4. Pi adapter design (verified against pi v0.80.7 installed docs)

Pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
(extensions.md, rpc.md, sdk.md, settings.md, packages.md, custom-provider.md, models.md, skills.md);
examples in `…/examples/extensions/`. Node >= 22.19.0. Pre-1.0: **pin the version** (npx, same
pattern as the Claude CLI pin, issue #218 precedent).

### 4.1 TS extensions (live as real sources under `templates/pi/extensions/`, vitest-tested; pi
loads TS via jiti — no compile; npm deps work when a package.json sits next to the extension)

1. **`mcp-bridge.ts`** — MCP client (stdio + streamable-HTTP, via `@modelcontextprotocol/sdk`)
   → `pi.registerTool()` per tool, names `mcp__<server>__<tool>` (keeps every policy list and
   the `.mcp.json` template valid verbatim). Registration happens after the MCP handshake, so
   the cold-start readiness race and `_await_mcp_ready` die by construction. Tool execute
   signature: `execute(toolCallId, params, signal, onUpdate, ctx)`.
2. **`hook-bridge.ts`** — `pi.on("tool_call")` handler execing the existing Python hooks with the
   Claude hook stdin/stdout JSON protocol (`{tool_name, tool_input, …}` →
   `{hookSpecificOutput:{permissionDecision: allow|deny|ask, …}}`). deny → `return {block:true,
   reason}`; ask → `await ctx.ui.confirm(title, message)`; headless without UI → block.
   `pi.on("tool_result")` for PostToolUse hooks (notebook update, hook log, cf feedback).
3. **`policy.ts`** — allow/deny/ask config semantics (replaces settings.json permissions).
4. **`subagents.ts`** (Phase 6) — port of the 5 framework agents, following
   `examples/extensions/subagent/` (spawns `pi` subprocesses, `.pi/agents/*.md` frontmatter).
5. Footer/statusline (Phase 5, cosmetic): `ctx.ui.setStatus/setFooter`.

### 4.2 Python RPC client — `harness/pi/rpc.py`

`pi --mode rpc`: JSONL over stdio, **LF-only framing**, no init handshake.
Commands: `{"id","type":"prompt","message",…}` (response = accepted, not completed),
`steer`, `follow_up`, `abort`, `get_state`, `get_session_stats`
(→ tokens{input,output,cacheRead,cacheWrite}, cost, contextUsage), `get_messages`, `set_model`,
`bash`, `new_session`. Events: `agent_start/end`, `turn_start/end`, `message_update`
(`assistantMessageEvent.type: text_delta|…`), `tool_execution_start/update/end`
(`{toolCallId, toolName, args}` / `{result:{content,details}, isError}`),
`extension_error`. Usage/cost on `AssistantMessage.usage`.
**Approval over RPC:** `extension_ui_request {id, method:"confirm"|"select"|…}` →
respond `extension_ui_response {id, confirmed:bool}` (confirm) or `{value}` / `{cancelled:true}`.
This is how dispatch/e-mail/GChat approval bridges surface on pi.
Event mapping to neutral types: `tool_execution_start/end` ↔ `ToolTrace`,
`message_update text_delta` → text_blocks, `get_session_stats` → usage/cost, `agent_end` → result.
Inactivity watchdog, secret scrubbing, truncation logic port unchanged from `sdk_runner`.

### 4.3 Launch & trust

- Launcher: `pi` (or `npx -y @earendil-works/pi-coding-agent@<pin>`), project cwd.
- **Trust gotcha (hard requirement):** non-interactive modes (`rpc`, `json`, `-p`) NEVER prompt
  and default to ignoring project resources. `.pi/extensions/` (the MCP bridge — i.e. ALL tools)
  will not load headlessly unless: `--approve`/`-a` flag, pre-seeded `~/.pi/agent/trust.json`, or
  global `defaultProjectTrust: "always"`. Containers pre-seed; local headless runs pass `-a`.
- Providers: `~/.pi/agent/models.json` or a tiny extension calling `pi.registerProvider()` —
  pi speaks `openai-completions`/`anthropic-messages`/`google-generative-ai` natively, apiKey
  supports `$ENV_VAR` / `!command` expansion. **The translation proxy is not used on pi.**
  Tiers (haiku/sonnet/opus) map in osprey config → per-run `--model`/`set_model`.

### 4.4 Briefing corrections (verified against v0.80.7 docs — trust these over the briefing)

- Tool `execute` order is `(toolCallId, params, signal, onUpdate, ctx)` (examples/README is stale).
- `tool_call` mutation is **in-place on `event.input`**; the return value only carries
  `{block, reason}`.
- `tool_result` handlers return a **partial patch** `{content?, details?, isError?}`.
- Global extension dir is `~/.pi/agent/extensions/`, not `~/.pi/extensions/`.
- RPC image shape `{type:"image", data, mimeType}` differs from the TS-SDK shape.
- `pi.setActiveTools` REPLACES the active set (pass the full list).
- Headless trust behavior as in §4.3 — the single most likely silent-failure foot-gun.

## 5. Future harnesses (codex, omp)

The protocol requires only: (a) a headless JSON/JSONL driving mode, (b) a project artifact tree,
(c) an interactive launcher, (d) a tool-gating point for the safety bindings. Codex
(`codex exec --json`, `AGENTS.md`, `config.toml`) and omp fit; neither is in scope now, but no
protocol member may assume Anthropic message shapes, `.claude/` paths, or MCP-native support.
The neutral event vocabulary stays minimal: text, tool call/result, usage/cost, terminal result.

## 6. Roadmap

| Phase | Deliverable | Acceptance |
|---|---|---|
| **1. Runtime abstraction** | `osprey/harness/` pkg, `harness:` config key, `ClaudeCodeHarness`, `osprey query` routed through registry | existing `tests/agent_runner` + `tests/cli/test_query_cmd.py` green; new registry/adapter unit tests |
| **2. Pi spike (go/no-go)** | `mcp-bridge.ts` + `hook-bridge.ts` + minimal `.pi/` render | hello-world project boots in pi TUI: controls+python MCP tools visible, write tool deny/ask fires via existing hooks |
| **3. Pi headless** | `harness/pi/rpc.py` + `PiHarness.run_query` | `osprey query` passes on a pi hello-world project (mock connector), read-only fail-closed verified (write-tool leak test) |
| **4. Sessions & workers** | `open_session` on protocol; dispatch worker + operator session per-harness | dispatch tool-policy tests pass on both; approval round-trip over RPC demonstrated |
| **5. Build retarget** | `templates/pi/` complete, `harness` in presets, launcher/env per harness, per-harness builtin floors, trust pre-seed in compose/Dockerfiles | `osprey build --set harness=pi` emits working `.pi/` project; `validate` equivalents pass |
| **6. Subagents & providers** | `subagents.ts`, `models.json`/registerProvider generation | 5 framework agents callable on pi; CBORG-style OpenAI provider runs with NO proxy |
| **7. Convergence & cleanup** | test-suite convergence, `AgentRunResult` physical move + rename, docs, CHANGELOG | full suite green; no `SDKWorkflowResult` references; README claim accurate |

Each phase gets its own implementation plan in `docs/superpowers/plans/` when it starts.
Phase 1 plan: `2026-07-20-harness-phase1-runtime-abstraction.md`.

## 7. Risks

- **Pi churn (pre-1.0):** npx pin + this spec records the v0.80.7 API facts; bump deliberately.
- **We own MCP bridge/policy/subagents on pi:** first-class vitest coverage; hook-bridge keeps the
  Python safety suite authoritative.
- **Facility safety re-review:** out of scope for code; the per-harness binding table (§3.4) is
  written to be the seed of that document.
- **`bypassPermissions` semantics have no pi analogue:** pi's default is "everything allowed
  unless an extension blocks" — read-only paths therefore must be fail-closed by tool
  *non-registration*, never by deny-listing alone (mirrors briefing recommendation).

## 8. Key references

- Osprey: `src/osprey/agent_runner/{primitives,runner,session,write_tools}.py`,
  `src/osprey/cli/{query_cmd,claude_cmd,claude_code_resolver,build_cmd}.py`,
  `src/osprey/cli/templates/{manager,scaffolding,claude_code,manifest}.py`,
  `src/osprey/mcp_server/dispatch_worker/{sdk_runner,tool_policy}.py`,
  `src/osprey/interfaces/web_terminal/{operator_session,pty_manager,sdk_context,app}.py`,
  `src/osprey/infrastructure/proxy/`, `src/osprey/templates/claude_code/`,
  `src/osprey/profiles/presets/`.
- Pi: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/{docs,examples}/`, v0.80.7.
- Tests to keep green: `tests/agent_runner/`, `tests/cli/test_query_cmd.py`,
  `tests/agent_runner/test_write_tools.py` (drift guards), `tests/e2e/` (SDK-gated).
