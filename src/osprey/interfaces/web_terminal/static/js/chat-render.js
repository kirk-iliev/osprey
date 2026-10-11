// @ts-check
/**
 * OSPREY Web Terminal — Simple-mode operator chat: message-list renderer.
 *
 * View-model for the operator chat log (the `op-*` console styled in
 * operator.css). A {@link createChatRenderer} instance owns the message-list
 * state a single stream of SSE-style events would otherwise scatter across the
 * controller: the agent turn being written (its text, thinking, tool calls,
 * plan and cards), the live loader, and the first-turn bookkeeping that decides
 * whether a `session_reset` is worth a divider. The blocks are built in
 * chat-blocks.js.
 *
 * Trust boundary: chat renders *model* output — including verbatim tool
 * results from outside the trust boundary — so every markdown-to-HTML path
 * runs through {@link renderMarkdownInto}, which sanitises with DOMPurify
 * before anything reaches the DOM and degrades to inert `textContent` when the
 * vendored libraries are absent. The scaffold Preview renders agent-writable
 * `.claude/` files through the same function rather than a second copy.
 *
 * The libraries (`marked`, `DOMPurify`, `hljs`) are vendored classic-script
 * globals loaded before this module; `DOMPurify` has no ambient declaration,
 * and any of the three can be missing under a partial load, so they are read
 * off `globalThis` behind an `any` cast and every use is guarded.
 *
 * @module chat-render
 */

import {
  createAgentEntry,
  createApprovalCard,
  createErrorBlock,
  createLoader,
  createQuestionCard,
  createSessionDivider,
  createTaskCard,
  createTextBlock,
  createThinkingBlock,
  createToolGroup,
  createTurnFooter,
  createUserEntry,
  PLAN_TOOL_KEY,
  QUESTION_TOOL_KEY,
  toolKey,
} from './chat-blocks.js';

export { elem } from './chat-blocks.js';

/** @typedef {import('./chat-blocks.js').LoaderHandle} LoaderHandle */
/** @typedef {import('./chat-blocks.js').ThinkingBlock} ThinkingBlock */
/** @typedef {import('./chat-blocks.js').ToolGroup} ToolGroup */
/** @typedef {import('./chat-blocks.js').TaskCard} TaskCard */
/** @typedef {import('./chat-blocks.js').PermissionBody} PermissionBody */

/**
 * A chat event, post server-side stripping (see routes/chat.py
 * `_strip_for_chat`). Only the fields this renderer reads are typed; the
 * stripped wire objects carry a few more (`tool_use_id`, `error_type`, …).
 *
 * @typedef {object} ChatEvent
 * @property {string} type - discriminator: `text` | `thinking` | `tool_use`
 *   | `tool_result` | `result` | `session_reset` | `error` | `system` | …
 * @property {string} [content] - incremental text (`text` events)
 * @property {string} [tool_name] - display name, prefix-stripped (`tool_use`)
 * @property {string} [tool_name_raw] - the SDK's own tool name, prefix intact
 *   (`tool_use`); the preferred {@link TOOL_PHRASES} key
 * @property {string} [message] - human-readable error text (`error` events)
 * @property {boolean} [is_error] - turn/tool errored (`result`, `tool_result`)
 */

/**
 * One conversation turn as served by `GET /api/session-chat` (see
 * workspace/transcript_reader.py `read_chat_history`, which emits text turns
 * only — tool calls and their results never appear).
 *
 * @typedef {object} ChatTurn
 * @property {string} role - `user` or `assistant`
 * @property {string} content - the turn's text; markdown for an agent turn
 * @property {string} [timestamp] - transcript timestamp; not rendered here
 */

/**
 * @returns {{ DOMPurify: any, hljs: any, katex: any }} the vendored
 *   sanitiser/highlighter/math globals, each possibly `undefined`. (`marked` is
 *   reached via {@link chatMarkedParse}, which isolates chat from the shared
 *   singleton.)
 */
function markdownGlobals() {
  const g = /** @type {any} */ (globalThis);
  return { DOMPurify: g.DOMPurify, hljs: g.hljs, katex: g.katex };
}

// ---- Math ---- //

/**
 * Math delimiters, in extraction order, each with whether it is display math.
 * Inline `$…$` follows the pandoc rule — no space just inside either dollar,
 * no digit just outside — so prices like "$5 and $10" stay text; `\$` is a
 * literal dollar.
 * @type {Array<[RegExp, boolean]>}
 */
const MATH_PATTERNS = [
  [/\$\$([\s\S]+?)\$\$/g, true],
  [/\\\[([\s\S]+?)\\\]/g, true],
  [/\\\(([\s\S]+?)\\\)/g, false],
  [/(?<![$\d\\])\$(?![\s$])([^\n$]+?)(?<![\s\\])\$(?!\d)/g, false],
];

/** Fenced blocks and code spans; split on it, odd parts are code and stay literal. */
const CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/;

/** The placeholder a math expression rides through marked and DOMPurify as. */
const MATH_TOKEN = /OSPREYMATH(\d+)Z/g;

/**
 * Swap every math expression outside code for a plain-text placeholder, so
 * marked never sees (and mangles) its `_`, `^` and `\`.
 * @param {string} text
 * @param {Array<{expr: string, display: boolean, raw: string}>} found - filled in
 * @returns {string}
 */
function extractMath(text, found) {
  return text
    .split(CODE_SPLIT)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      for (const [re, display] of MATH_PATTERNS) {
        part = part.replace(re, (raw, expr) => {
          found.push({ expr, display, raw });
          return `OSPREYMATH${found.length - 1}Z`;
        });
      }
      return part;
    })
    .join('');
}

/**
 * Typeset the placeholders left in `el`'s text nodes. Done on the DOM after
 * sanitising, so KaTeX output never passes through, or around, the HTML string.
 * @param {HTMLElement} el
 * @param {Array<{expr: string, display: boolean, raw: string}>} found
 * @param {any} katex
 */
function mountMath(el, found, katex) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.includes('OSPREYMATH')) nodes.push(/** @type {Text} */ (n));
  }
  for (const node of nodes) {
    const s = node.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of s.matchAll(MATH_TOKEN)) {
      frag.append(s.slice(last, m.index));
      const item = found[Number(m[1])];
      const span = document.createElement('span');
      try {
        katex.render(item.expr.trim(), span, {
          displayMode: item.display,
          throwOnError: false,
          strict: false,
        });
      } catch {
        span.textContent = item ? item.raw : m[0];
      }
      frag.append(span);
      last = (m.index ?? 0) + m[0].length;
    }
    frag.append(s.slice(last));
    node.replaceWith(frag);
  }
}

/**
 * Identity of the global `marked` the memoised {@link chatMarkedParse} was
 * last built against, and the parse function derived from it. Kept module-level
 * so the (stable) production singleton yields exactly one isolated instance,
 * while per-test global swaps — which change the identity — force a rebuild.
 * @type {any}
 */
let lastMarked = null;
/** @type {((text: string) => string) | null} */
let chatParse = null;

/**
 * A `parse(markdown) -> html` function isolated from the shared `marked`
 * singleton, or `null` when `marked` is absent.
 *
 * The global `marked` is a page-wide singleton that any script may
 * reconfigure with `marked.use(...)`. marked v12 exposes its `Marked` class
 * on the UMD global, so this module builds its own instance with a plain
 * config and parses through that, immune to whatever the rest of the page
 * does to the singleton. When the constructor is absent (an older or partial
 * vendored build) it falls back to the global `marked.parse`.
 *
 * Resolved lazily rather than at module load: the vendored global loads before
 * this module in the browser, but tests stub `globalThis.marked` per case, so
 * the instance is (re)built whenever the observed global changes identity.
 *
 * @returns {((text: string) => string) | null}
 */
function chatMarkedParse() {
  const marked = /** @type {any} */ (globalThis).marked;
  if (marked === lastMarked) return chatParse;
  lastMarked = marked;

  if (!marked) {
    chatParse = null;
  } else if (typeof marked.Marked === 'function') {
    try {
      const instance = new marked.Marked({ gfm: true, breaks: false });
      chatParse = (text) => instance.parse(text);
    } catch {
      chatParse =
        typeof marked.parse === 'function' ? (text) => marked.parse(text) : null;
    }
  } else {
    chatParse =
      typeof marked.parse === 'function' ? (text) => marked.parse(text) : null;
  }
  return chatParse;
}

/**
 * Render markdown text into `el` as sanitised HTML, then syntax-highlight any
 * code blocks. This is the web terminal's one trust boundary for markdown:
 * the chat log and the scaffold Preview both render through it.
 *
 * HTML is produced only when BOTH `marked` and `DOMPurify` are available: the
 * marked output is untrusted HTML, so it must never reach `innerHTML` without
 * passing through `DOMPurify.sanitize` first. If either library is missing (or
 * either step throws), the text is written as inert `textContent` — never as
 * markup. `hljs` is a purely additive enhancement and is skipped when absent.
 *
 * @param {HTMLElement} el - target element; its contents are replaced
 * @param {string} text - raw markdown (model output)
 * @param {{ math?: boolean }} [options] - `math` typesets `$…$`, `$$…$$`,
 *   `\(…\)` and `\[…\]` with KaTeX when it is loaded
 * @returns {void}
 */
export function renderMarkdownInto(el, text, { math = false } = {}) {
  const { DOMPurify, hljs, katex } = markdownGlobals();
  const parse = chatMarkedParse();

  // Fail safe: without a parser or a sanitiser we cannot emit HTML, so degrade
  // to text.
  if (!parse || !DOMPurify || typeof DOMPurify.sanitize !== 'function') {
    el.textContent = text;
    return;
  }

  /** @type {Array<{expr: string, display: boolean, raw: string}>} */
  const found = [];
  const withMath = math && katex && typeof katex.render === 'function';
  let clean;
  try {
    clean = DOMPurify.sanitize(parse(withMath ? extractMath(text, found) : text));
  } catch {
    // Any failure in parse/sanitise falls back to inert text rather than
    // risking unsanitised markup reaching the DOM.
    el.textContent = text;
    return;
  }
  el.innerHTML = clean;
  if (found.length) mountMath(el, found, katex);

  if (hljs && typeof hljs.highlightElement === 'function') {
    el.querySelectorAll('pre code').forEach((block) => {
      try {
        hljs.highlightElement(/** @type {HTMLElement} */ (block));
      } catch {
        // A single block failing to highlight must not break the message.
      }
    });
  }
}

// ---- Tool vocabulary ---- //

// The vocabulary below is exported for its own unit suite; the chat itself
// reaches it only through createChatRenderer's activity line.

/**
 * Operator phrases for the tools a turn is likely to use, keyed by normalised
 * tool name (see {@link normaliseToolName}).
 *
 * In Simple mode the chat is the whole interface, so this line is the only
 * account an operator gets of what the agent is doing. Phrases say it in
 * control-room terms and share the activity strip's vocabulary (open/close/
 * focus/arrange for panels, "wrote" for channels).
 *
 * They are lower-case gerunds — "writing control channels" — so a caller can
 * drop one mid-sentence; {@link activityLabel} capitalises for the activity
 * line. Coverage is deliberately partial: a tool whose formatted name already
 * reads as plain English ("List Panels", "Session Summary") falls through to
 * the raw-name fallback instead of earning a row. Adding one is a single line.
 *
 * Phrases cannot name the specific panel, channel, or file involved: the chat
 * route (`_strip_for_chat`) drops a `tool_use` event's `input` before it leaves
 * the server, so no arguments reach this module.
 *
 * The keyspace is server-agnostic by design: keys are short tool names with
 * the `mcp__<server>__` prefix stripped, so a name owned by two servers
 * (e.g. `capabilities` on both ariel and osprey_facility_knowledge) would
 * share one phrase. Keep phrases generic enough to be true for every owner.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TOOL_PHRASES = Object.freeze({
  // Control system — the writes an operator most needs to see coming.
  channel_write: 'writing control channels',
  channel_read: 'reading control channels',
  channel_limits: 'checking channel limits',
  archiver_read: 'reading archived data',
  archiver_downsample: 'thinning archived data',

  // Python executor.
  execute: 'running Python',
  execute_file: 'running Python',

  // Workspace panels. The synthetic panel activity uses these same names.
  add_panel_to_rail: 'making a panel available',
  remove_panel_from_rail: 'removing a panel',
  open_panel: 'opening a panel',
  close_panel: 'closing a panel',
  arrange_workspace: 'arranging the workspace',
  register_panel: 'adding a panel',
  manage_window: 'arranging a window',
  screenshot_capture: 'taking a screenshot',

  // Workspace artifacts (plots, documents and stored datasets alike).
  artifact_register: 'registering an artifact',
  artifact_get: 'opening an artifact',
  artifact_list: 'listing saved artifacts',
  artifact_read: 'reading a saved artifact',
  artifact_focus: 'showing an artifact',
  artifact_pin: 'pinning an artifact',
  artifact_export: 'exporting an artifact',
  artifact_delete: 'deleting an artifact',
  artifact_delete_all: 'deleting artifacts',
  create_static_plot: 'drawing a plot',
  create_interactive_plot: 'drawing an interactive plot',
  create_dashboard: 'building a dashboard',
  create_document: 'writing a document',

  // Workspace project setup and session record.
  setup_inspect: 'inspecting the project setup',
  setup_patch: 'changing the project setup',
  session_log: 'writing to the session log',

  // Plan queue (bluesky).
  queue_status: 'checking the plan queue',
  queue_list: 'listing the plan queue',
  queue_add: 'queueing a plan',
  queue_start: 'starting the plan queue',
  queue_stop: 'stopping the plan queue',
  stop_run: 'stopping the running plan',
  write_plan: 'drafting a plan',
  validate_plan: 'checking the plan',
  get_draft: 'reading the plan draft',
  set_draft: 'editing the plan draft',
  clear_draft: 'clearing the plan draft',
  get_run: 'reading a plan run',
  get_run_data: 'reading run data',
  get_run_figure: 'reading a run figure',

  // Phoebus displays.
  phoebus_open_panel: 'opening a Phoebus display',
  phoebus_open_databrowser: 'opening the data browser',
  phoebus_list_displays: 'listing Phoebus displays',
  phoebus_perceive: 'reading a Phoebus display',
  phoebus_perceive_region: 'reading part of a Phoebus display',
  phoebus_snapshot: 'capturing a Phoebus display',
  phoebus_drive: 'operating a Phoebus display',

  // Logbook (ARIEL).
  browse: 'browsing the logbook',
  keyword_search: 'searching the logbook',
  semantic_search: 'searching the logbook',
  hybrid_search: 'searching the logbook',
  sql_query: 'querying the logbook',
  filter_options: 'listing logbook filters',
  entry_get: 'reading a logbook entry',
  entries_by_ids: 'reading logbook entries',
  attachment_view: 'viewing a logbook picture',
  entry_open: 'showing a logbook entry',
  attachment_to_artifact: 'saving a logbook picture',
  entry_create: 'drafting a logbook entry',
  entry_publish: 'publishing a logbook entry',

  // Channel finder.
  list_channels: 'looking up channels',
  ask_channels: 'looking up channels',
  run_sql: 'querying the channel database',
  build_channels: 'building a channel list',
  list_families: 'looking up channel families',
  list_systems: 'looking up systems',
  get_common_names: 'looking up channel names',
  inspect_fields: 'inspecting channel fields',

  // Facility knowledge.
  list_concepts: 'browsing facility knowledge',
  read_concept: 'reading facility knowledge',
  draft_concept: 'drafting a facility note',

  // Lattice model. The mutators are phrased; the getters fall back.
  lattice_init: 'loading the lattice',
  lattice_state: 'reading the lattice',
  lattice_set_param: 'changing a lattice parameter',
  lattice_set_baseline: 'setting the lattice baseline',
  lattice_clear_baseline: 'clearing the lattice baseline',
  lattice_update_settings: 'changing lattice settings',
  lattice_refresh: 'refreshing the lattice view',

  // Health.
  health_check: 'checking system health',
  health_check_full: 'checking system health',

  // Built-in agent tools.
  read: 'reading a file',
  write: 'writing a file',
  edit: 'editing a file',
  bash: 'running a shell command',
  glob: 'looking for files',
  grep: 'searching files',
  task: 'delegating to a helper agent',
  todowrite: 'updating its plan',
  webfetch: 'fetching a web page',
  websearch: 'searching the web',
});

/**
 * Fold a tool name to a {@link TOOL_PHRASES} key: drop the `mcp__<server>__`
 * prefix, collapse whitespace and hyphens to underscores, lower-case.
 *
 * A `tool_use` event carries the name twice — `tool_name_raw`
 * (`mcp__osprey__channel_write`) and the server-formatted `tool_name`
 * (`Channel Write`, from operator_session `_format_tool_name`) — and both fold
 * to the same key, so the table works whichever spelling an event carries.
 * (Caveat: a tool name containing a literal `__` folds differently per
 * spelling — no framework tool is named that way.)
 *
 * @param {string} name
 * @returns {string}
 */
export function normaliseToolName(name) {
  return name
    // Non-greedy: the FIRST `__` after the server name ends the prefix — the
    // server name may itself contain single underscores (osprey_workspace,
    // osprey_facility_knowledge, or a facility-declared server named that way).
    .replace(/^mcp__.+?__/, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

/**
 * The operator phrase for a `tool_use` event, or null when the tool has no
 * table entry. Lower-case and sentence-fragment shaped; capitalise at the
 * point of display.
 * @param {ChatEvent} event
 * @returns {string | null}
 */
export function toolPhrase(event) {
  for (const name of [event.tool_name_raw, event.tool_name]) {
    if (!name) continue;
    const phrase = TOOL_PHRASES[normaliseToolName(name)];
    if (phrase) return phrase;
  }
  return null;
}

/**
 * The activity-line label for a `tool_use` event. A mapped tool reads as a
 * sentence ("Writing control channels…"); anything unmapped keeps its raw name
 * ("Using Queue Reorder…"), so a tool added elsewhere in the codebase is never
 * invisible here — only terse until it earns a phrase.
 * @param {ChatEvent} event
 * @returns {string}
 */
export function activityLabel(event) {
  const phrase = toolPhrase(event);
  if (phrase !== null) return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}…`;
  return `Using ${event.tool_name ?? event.tool_name_raw ?? 'tool'}…`;
}

// ---- Stateful renderer ---- //

/**
 * @typedef {object} ChatRenderer
 * @property {(text: string) => HTMLElement} addUserMessage - append an
 *   operator bubble and return it
 * @property {(markdown: string) => HTMLElement} addAgentMessage - append a
 *   finished agent entry rendered from markdown and return it
 * @property {(turns: ChatTurn[] | null | undefined) => number} replay - render
 *   prior conversation turns, leaving the session-reset divider state
 *   untouched; returns the number of entries rendered
 * @property {() => void} beginTurn - start a turn: shows the live loader
 * @property {(event: ChatEvent) => void} handleEvent - dispatch one SSE event
 * @property {() => void} endTurn - finish the turn: hides the loader and marks
 *   any card still waiting on the operator as cancelled
 * @property {() => void} reset - clear the list and all per-conversation state
 * @property {() => number} messageCount - rendered message entries so far
 *   (excludes dividers and the loader); primarily for tests
 */

/**
 * @typedef {object} RendererOptions
 * @property {(requestId: string, body: PermissionBody) => Promise<unknown>} [answerPermission]
 *   delivers a card's answer; rejects with `status` 404 once the request is gone
 */

/**
 * The agent entry of the turn in flight, and the block it is writing into.
 * @typedef {object} AgentTurn
 * @property {HTMLElement} entry
 * @property {HTMLElement | null} body - the open text block's body, or null
 * @property {string[]} texts - raw markdown of each text block, in order (the copy source)
 * @property {ThinkingBlock | null} thinking - the open thinking block, or null
 * @property {ToolGroup | null} group - the open tool group, or null
 * @property {TaskCard | null} tasks - the turn's one plan card, once it has one
 */

/**
 * Create a chat renderer bound to a message-list container (the `op-messages`
 * element). The renderer appends entries in arrival order, keeps the loader
 * pinned to the bottom of the log while a turn runs, and routes each event to
 * the block it belongs in.
 *
 * @param {HTMLElement} container - the `op-messages` scroll region
 * @param {RendererOptions} [options]
 * @returns {ChatRenderer}
 */
export function createChatRenderer(container, options = {}) {
  /**
   * Count of rendered *message* entries (operator / agent / error) in the
   * current conversation. Dividers and the loader don't count. Reported by
   * {@link messageCount} (primarily for tests).
   */
  let count = 0;

  /**
   * Whether a prior agent exchange — an agent message or a finished turn — has
   * been rendered in this conversation. Gates the session-reset divider.
   *
   * The real turn sequence is: the controller appends the operator's bubble,
   * *then* opens the stream, and a fresh server session emits `session_reset`
   * as frame 0. So a plain message count is already ≥ 1 by the time the first
   * reset arrives and can't distinguish a genuine first turn from a later one.
   * A reset is only worth a divider when a completed exchange sits above it, so
   * we track that explicitly and never let the current turn's own just-added
   * user bubble count as prior history.
   */
  let hasPriorExchange = false;

  /** Whether a turn is in flight: from beginTurn until endTurn. */
  let running = false;
  /** When the turn in flight began (epoch ms); the loader and footer count from here. */
  let startedAt = 0;
  /** The loader's label: the current activity. */
  let activity = 'Working…';
  /** Whether text is streaming now; the loader steps aside while it does. */
  let streamingText = false;
  /** The live loader, created on first use and then reused. */
  let loader = /** @type {LoaderHandle | null} */ (null);
  /** The agent entry of the turn in flight, or null before its first block. */
  let turn = /** @type {AgentTurn | null} */ (null);
  /** Tool chips of the turn in flight, keyed by `tool_use_id`. */
  const chips = new Map();
  /** Permission cards of the turn in flight, keyed by `request_id`. */
  const cards = new Map();
  /** Subagent chips of the turn in flight, keyed by the call's `tool_use_id`. */
  const agents = new Map();

  /**
   * The agent chip a record belongs to, when it is a subagent's own. A record
   * whose parent is not a chip here (a subagent of a subagent) has no place
   * in the operator log and is dropped rather than shown as the main agent's.
   * @param {Record<string, any>} event
   * @returns {{ agent: any, nested: boolean }}
   */
  function ownerOf(event) {
    const parent = event.parent_tool_use_id;
    if (!parent) return { agent: null, nested: false };
    return { agent: agents.get(String(parent)) ?? null, nested: true };
  }

  const answer =
    options.answerPermission ??
    (async () => {
      throw new Error('Permission answers are not wired up.');
    });

  /**
   * Append a node to the log, keeping the loader (when it is showing) last so
   * it always reads as the current status beneath the latest message.
   * @param {Node} node
   */
  function append(node) {
    container.appendChild(node);
    if (loader?.el.isConnected) container.appendChild(loader.el);
  }

  /**
   * The current turn's agent entry, created with the turn's first block.
   * @returns {AgentTurn}
   */
  function ensureTurn() {
    if (turn) return turn;
    const entry = createAgentEntry();
    count += 1;
    hasPriorExchange = true;
    turn = { entry, body: null, texts: [], thinking: null, group: null, tasks: null };
    append(entry);
    return turn;
  }

  /** @param {AgentTurn} t */
  function closeText(t) {
    t.body = null;
  }

  /** @param {AgentTurn} t */
  function closeThinking(t) {
    if (t.thinking) {
      t.thinking.finish();
      t.thinking = null;
    }
  }

  /** @param {AgentTurn} t */
  function closeGroup(t) {
    if (t.group) {
      t.group.settle();
      t.group = null;
    }
  }

  /** @param {AgentTurn} t */
  function closeAll(t) {
    closeText(t);
    closeThinking(t);
    closeGroup(t);
  }

  /** @param {string} chunk */
  function appendText(chunk) {
    const t = ensureTurn();
    closeThinking(t);
    closeGroup(t);
    let body = t.body;
    if (!body) {
      body = createTextBlock();
      t.body = body;
      t.texts.push('');
      t.entry.appendChild(body);
    }
    const i = t.texts.length - 1;
    t.texts[i] += chunk;
    renderMarkdownInto(body, t.texts[i], { math: true });
  }

  /** @param {string} chunk */
  function appendThinking(chunk) {
    const t = ensureTurn();
    closeText(t);
    closeGroup(t);
    if (!t.thinking) {
      t.thinking = createThinkingBlock();
      t.entry.appendChild(t.thinking.el);
    }
    t.thinking.add(chunk);
  }

  /** @param {Record<string, any>} event - a `tool_use` event */
  function appendToolUse(event) {
    const t = ensureTurn();
    closeText(t);
    closeThinking(t);
    if (!t.group) {
      t.group = createToolGroup();
      t.entry.appendChild(t.group.el);
    }
    const raw = String(event.tool_name_raw ?? '');
    const id = String(event.tool_use_id ?? '');
    if (raw === 'Agent' || raw === 'Task') {
      const agent = t.group.addAgent(event, (el, text) =>
        renderMarkdownInto(el, text, { math: true }),
      );
      if (id) {
        agents.set(id, agent);
        chips.set(id, agent);
      }
      return;
    }
    const chip = t.group.addTool(event);
    if (id) chips.set(id, chip);
  }

  /** @param {Record<string, any>} event - a `tool_use` event for TodoWrite */
  function upsertPlan(event) {
    const todos = event.input?.todos;
    const items = Array.isArray(todos) ? todos.filter((item) => item && typeof item === 'object') : [];
    const t = ensureTurn();
    if (!t.tasks) {
      closeAll(t);
      t.tasks = createTaskCard();
      t.entry.appendChild(t.tasks.el);
    }
    t.tasks.update(items);
  }

  /** @param {Record<string, any>} request - a `permission_request` event */
  function appendPermission(request) {
    const t = ensureTurn();
    closeAll(t);
    const id = String(request.request_id ?? '');
    const hooks = {
      answer: (/** @type {PermissionBody} */ body) => answer(id, body),
      onSettled: () => syncLoader(),
    };
    const card =
      request.kind === 'question'
        ? createQuestionCard(request, hooks)
        : createApprovalCard(request, hooks);
    cards.set(id, card);
    t.entry.appendChild(card.el);
    card.focus();
  }

  /** @param {Record<string, any>} event - the `result` event */
  function appendFooter(event) {
    if (!turn) return;
    const text = turn.texts.filter((part) => part.trim()).join('\n\n');
    const durationMs =
      typeof event.duration_ms === 'number' ? event.duration_ms : Date.now() - startedAt;
    turn.entry.appendChild(
      createTurnFooter({ durationMs, text, isError: Boolean(event.is_error) }),
    );
  }

  /**
   * Show the loader while a turn runs and nothing is streaming or waiting on
   * the operator. Otherwise stop its clock and take it out of the log.
   */
  function syncLoader() {
    const waiting = [...cards.values()].some((card) => card.pending);
    if (!running || streamingText || waiting) {
      loader?.stop();
      loader?.el.remove();
      return;
    }
    if (!loader) loader = createLoader();
    loader.setLabel(activity);
    loader.start(startedAt);
    if (container.lastElementChild !== loader.el) container.appendChild(loader.el);
  }

  /**
   * Close the turn in flight: settle its open blocks, cancel every card still
   * waiting (the server has moved on without those answers), and forget its
   * chips. The running state is left alone — see {@link endTurn}.
   */
  function dropTurn() {
    if (turn) closeAll(turn);
    turn = null;
    for (const card of cards.values()) card.cancel();
    cards.clear();
    for (const agent of agents.values()) agent.finish({ status: 'stopped' });
    agents.clear();
    chips.clear();
    streamingText = false;
  }

  /** The turn is over: a result, a terminal error, or a closed stream. */
  function endTurn() {
    dropTurn();
    running = false;
    syncLoader();
  }

  /** @param {string} text */
  function addUserMessage(text) {
    // A new operator message starts a new turn; abandon any dangling one.
    endTurn();
    const entry = createUserEntry(text);
    count += 1;
    append(entry);
    return entry;
  }

  /**
   * Append a finished agent entry rendered from `markdown` in one go — the
   * whole-message counterpart to the streamed text path, through the same
   * sanitising {@link renderMarkdownInto} boundary.
   * @param {string} markdown
   * @returns {HTMLElement}
   */
  function addAgentMessage(markdown) {
    dropTurn();
    const entry = createAgentEntry();
    const body = createTextBlock();
    renderMarkdownInto(body, markdown, { math: true });
    entry.appendChild(body);
    count += 1;
    hasPriorExchange = true;
    append(entry);
    syncLoader();
    return entry;
  }

  /**
   * Render prior conversation turns into the log, oldest first.
   *
   * Replayed turns are the same conversation continued in another window, not
   * a completed exchange in this one, so the divider bookkeeping is restored
   * afterwards: the next stream's frame-0 `session_reset` still draws no
   * divider above replayed history. Entries are appended — a caller wanting a
   * clean log calls {@link reset} first.
   *
   * @param {ChatTurn[] | null | undefined} turns - as served by
   *   `GET /api/session-chat`; a missing list renders nothing
   * @returns {number} entries rendered; a turn with no content is skipped
   */
  function replay(turns) {
    const priorExchange = hasPriorExchange;
    let rendered = 0;
    for (const turnItem of turns ?? []) {
      const content = turnItem?.content ?? '';
      const events = Array.isArray(turnItem?.events) ? turnItem.events : null;
      if ((turnItem.role ?? '').toLowerCase() === 'user') {
        if (!content) continue;
        addUserMessage(content);
      } else if (events?.length) {
        // The same path a live stream takes, so thinking, tool chips and the
        // plan come back exactly as they were drawn; `result` closes the turn.
        for (const event of events) handleEvent(event);
        endTurn();
      } else if (content) {
        addAgentMessage(content);
      } else {
        continue;
      }
      rendered += 1;
    }
    hasPriorExchange = priorExchange;
    return rendered;
  }

  function beginTurn() {
    running = true;
    startedAt = Date.now();
    activity = 'Working…';
    streamingText = false;
    syncLoader();
  }

  /** @param {ChatEvent} event */
  function handleEvent(event) {
    switch (event.type) {
      case 'text': {
        const { agent, nested } = ownerOf(event);
        if (nested) {
          agent?.addText(event.content ?? '');
          break;
        }
        streamingText = true;
        appendText(event.content ?? '');
        break;
      }
      case 'thinking':
        // A subagent's reasoning stays inside it; its chip shows its work.
        if (ownerOf(event).nested) break;
        streamingText = false;
        activity = 'Thinking…';
        appendThinking(event.content ?? '');
        break;
      case 'tool_use': {
        const { agent, nested } = ownerOf(event);
        if (nested) {
          if (agent) {
            const chip = agent.addTool(event);
            if (event.tool_use_id) chips.set(String(event.tool_use_id), chip);
            activity = `${agent.name} · ${activityLabel(event)}`;
          }
          break;
        }
        streamingText = false;
        const key = toolKey(event.tool_name_raw ?? event.tool_name);
        activity = key === QUESTION_TOOL_KEY ? 'Preparing a question…' : activityLabel(event);
        if (key === PLAN_TOOL_KEY) upsertPlan(event);
        else if (key !== QUESTION_TOOL_KEY) appendToolUse(event);
        break;
      }
      case 'tool_result':
        streamingText = false;
        chips.get(String(event.tool_use_id ?? ''))?.finish(event);
        break;
      case 'permission_request':
        streamingText = false;
        appendPermission(event);
        break;
      case 'result':
        // Turn boundary. A result finalises the turn and earns the footer; it
        // also marks a completed exchange, so a later reset earns its divider.
        streamingText = false;
        hasPriorExchange = true;
        appendFooter(event);
        endTurn();
        break;
      case 'session_reset':
        // The divider shows only when a completed exchange already sits above
        // this reset; the current turn's own user bubble is not enough (that is
        // the fresh-session first turn). The divider is not a message.
        if (hasPriorExchange) {
          dropTurn();
          append(createSessionDivider());
        }
        break;
      case 'error': {
        streamingText = false;
        count += 1;
        hasPriorExchange = true;
        const block = createErrorBlock(event.message ?? 'An error occurred.');
        if (turn) turn.entry.appendChild(block);
        else append(block);
        // An assistant-message error leaves the turn streaming; anything else ends it.
        if (event.error_type !== 'AssistantMessageError') endTurn();
        break;
      }
      case 'system':
        // `background_wait`: the agent handed work to a background agent; the
        // turn stays open until it reports, and the loader says what it is
        // waiting on. `agent_done`: that report, which settles its chip. Other
        // `system` frames are not rendered in the operator log.
        if (event.subtype === 'background_wait') {
          streamingText = false;
          activity = 'Waiting for the background agent…';
          // What the agent says once the report lands is a new paragraph.
          if (turn) closeText(turn);
        } else if (event.subtype === 'agent_done') {
          if (turn) closeText(turn);
          agents.get(String(event.tool_use_id ?? ''))?.finish({
            status: event.status,
            summary: event.summary,
            is_error: event.status === 'failed',
          });
        }
        break;
      default:
        // Unknown types are not rendered in the operator log.
        break;
    }
    syncLoader();
  }

  function reset() {
    dropTurn();
    running = false;
    loader?.stop();
    loader = null;
    container.replaceChildren();
    count = 0;
    hasPriorExchange = false;
  }

  return {
    addUserMessage,
    addAgentMessage,
    replay,
    beginTurn,
    handleEvent,
    endTurn,
    reset,
    messageCount: () => count,
  };
}
