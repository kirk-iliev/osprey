// @ts-check
/* OSPREY Web Terminal — Simple-view chat: turn blocks.
 *
 * DOM builders for the pieces an agent turn is made of: the live loader, the
 * thinking row, the tool-call group and its chips, the plan card, the approval
 * and question cards, the turn footer, and the error and divider notices. Each
 * builder returns its element together with the small handle the renderer
 * drives it through. None of them reads the event stream or touches the
 * network: a card's answer leaves through the `answer` hook the renderer
 * supplies, and the renderer tells the card when its turn has ended.
 *
 * Everything that came over the wire (tool inputs, previews, questions) is
 * written with textContent. Nothing here reaches innerHTML.
 *
 * @module chat-blocks
 */

import { chatIcon } from './chat-icons.js';

/** @typedef {import('./chat-icons.js').ChatIconName} ChatIconName */
/** An SSE event as decoded off the wire; the builders read fields by name. @typedef {Record<string, any>} WireEvent */

/** The tool whose todo list becomes the turn's plan card instead of a chip. */
export const PLAN_TOOL_KEY = 'todowrite';

/** The tool behind a question card. It gets no chip: the card stands in for it. */
export const QUESTION_TOOL_KEY = 'askuserquestion';

/**
 * The body a card posts to `POST /api/chat/{chat_id}/permission`. The renderer
 * adds the request id.
 * @typedef {{ allow: boolean, answers?: Record<string, string>, message?: string }} PermissionBody
 */

/**
 * What a card needs from the renderer. `answer` delivers the body and rejects
 * with a `status` of 404 once the request is gone. `onSettled` tells the
 * renderer that the card's pending state changed, so the loader can return.
 * @typedef {{ answer: (body: PermissionBody) => Promise<unknown>, onSettled: () => void }} CardHooks
 */

/**
 * An approval or question card.
 * @typedef {object} PermissionCard
 * @property {HTMLElement} el
 * @property {boolean} pending - awaiting the operator, or mid-delivery
 * @property {() => void} cancel - make inert: the turn ended without an answer
 * @property {() => void} focus - move focus to the card's primary control
 * @property {(outcome: RemoteAnswer) => void} resolved - another tab answered it
 */

/**
 * How a request was answered, as the `permission_resolved` frame reports it.
 * @typedef {{ allow?: boolean, for_session?: boolean, answers?: Record<string, string> | null }} RemoteAnswer
 */

/**
 * @typedef {object} LoaderHandle
 * @property {HTMLElement} el
 * @property {(text: string) => void} setLabel
 * @property {(startedAt: number) => void} start - tick from *startedAt* (epoch ms)
 * @property {() => void} stop
 */

/**
 * @typedef {object} ThinkingBlock
 * @property {HTMLElement} el
 * @property {(text: string) => void} add
 * @property {(text: string) => void} set - replace the reasoning with its final copy
 * @property {() => void} finish
 */

/**
 * @typedef {{ is_error?: boolean, preview?: string, truncated?: boolean }} ToolOutcome
 */

/**
 * @typedef {object} ToolChip
 * @property {(outcome: ToolOutcome) => void} finish
 */

/**
 * How a subagent call ends: its own tool result (a foreground agent), or the
 * report a background agent sends later (`status`, `summary`).
 * @typedef {ToolOutcome & { status?: string, summary?: string }} AgentOutcome
 */

/**
 * @typedef {object} AgentChip
 * @property {string} name - the subagent type, e.g. `facility-knowledge`
 * @property {(event: WireEvent) => ToolChip} addTool - file one of its tool calls
 * @property {(text: string) => void} addText - file one of its messages
 * @property {(outcome: AgentOutcome) => void} finish
 * @property {() => boolean} running
 */

/**
 * @typedef {object} ToolGroup
 * @property {HTMLElement} el
 * @property {(event: WireEvent) => ToolChip} addTool
 * @property {(event: WireEvent, renderText: (el: HTMLElement, text: string) => void) => AgentChip} addAgent
 * @property {() => void} settle - fold away, unless the operator chose its state
 *   or an agent in it is still working (it folds when the last one finishes)
 */

/**
 * @typedef {{ content?: string, activeForm?: string, status?: string }} PlanItem
 */

/**
 * @typedef {object} TaskCard
 * @property {HTMLElement} el
 * @property {(todos: PlanItem[]) => void} update
 */

/**
 * @param {string | undefined} tag
 * @param {string} className
 * @param {string} [text] - assigned via textContent (never innerHTML)
 * @returns {HTMLElement}
 */
export function elem(tag, className, text) {
  const node = document.createElement(tag ?? 'div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLButtonElement}
 */
function button(className, text) {
  const node = /** @type {HTMLButtonElement} */ (elem('button', className, text));
  node.type = 'button';
  return node;
}

/** @returns {HTMLElement} */
function spinner() {
  return elem('span', 'op-spin');
}

// ---- Vocabulary: tool inputs, categories, durations ---- //

/** Keys read first for a one-line input summary, in order of preference. */
const SUMMARY_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'channels',
  'channel',
  'pvs',
  'names',
  'description',
  'prompt',
];

/** Longest one-line summary before it is cut. */
const SUMMARY_MAX = 160;

/** @param {string} text */
function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/**
 * The one-line summary of a tool input: the first of the keys an operator reads
 * as "what this touches" (a path, a command, a pattern, a URL, channel names),
 * else the first non-empty string. Empty when there is nothing to show.
 * @param {unknown} input
 * @returns {string}
 */
export function summarizeInput(input) {
  if (typeof input === 'string') return oneLine(input);
  if (!input || typeof input !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (input);
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      return oneLine(value.join(', '));
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return '';
}

/**
 * The bare, lower-case key a tool is recognised by, whichever spelling the
 * event carries: `TodoWrite`, `Todo Write` and `todo_write` all fold to
 * `todowrite`.
 * @param {string | undefined} name
 * @returns {string}
 */
export function toolKey(name) {
  return (name ?? '').replace(/^mcp__.+?__/, '').replace(/[\s_-]+/g, '').toLowerCase();
}

/**
 * @typedef {'read' | 'search' | 'edit' | 'bash' | 'mcp-control' | 'web' | 'other'} ToolCategory
 */

/** @type {Readonly<Record<ToolCategory, ChatIconName>>} */
const CATEGORY_ICON = Object.freeze({
  read: 'read',
  search: 'search',
  edit: 'edit',
  bash: 'bash',
  'mcp-control': 'control',
  web: 'web',
  other: 'tool',
});

/**
 * The icon family for a tool, inferred from its SDK name. MCP tools are the
 * facility's own control surface and share one family; built-ins map by what
 * they do to the workspace.
 * @param {string | undefined} rawName
 * @returns {ToolCategory}
 */
export function toolCategory(rawName) {
  const raw = rawName ?? '';
  if (raw.startsWith('mcp__')) return 'mcp-control';
  switch (toolKey(raw)) {
    case 'webfetch':
    case 'websearch':
      return 'web';
    case 'bash':
    case 'shell':
      return 'bash';
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'notebookedit':
      return 'edit';
    case 'read':
    case 'notebookread':
      return 'read';
    case 'grep':
    case 'glob':
    case 'ls':
      return 'search';
    default:
      return 'other';
  }
}

/**
 * A duration as the chat states it: `12s` in the footer, one decimal on the
 * live loader, and minutes once past a minute.
 * @param {number} ms
 * @param {boolean} [precise]
 * @returns {string}
 */
export function formatElapsed(ms, precise = false) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return precise ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

// ---- Live status ---- //

/**
 * The turn's live status line: a 3×3 pixel grid, the current activity in a
 * shimmer, and the elapsed time. The renderer decides when it shows; the loader
 * owns its label and its clock.
 * @returns {LoaderHandle}
 */
export function createLoader() {
  const el = elem('div', 'op-loader');
  el.setAttribute('role', 'status');
  const grid = elem('span', 'op-loader-grid');
  grid.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 9; i += 1) grid.append(elem('span', 'op-loader-cell'));
  const label = elem('span', 'op-loader-label op-shimmer', 'Working…');
  const sep = elem('span', 'op-loader-sep', '·');
  sep.setAttribute('aria-hidden', 'true');
  // Off the live region: the label is the announcement; the clock is for the eye.
  const time = elem('span', 'op-loader-time', '0.0s');
  time.setAttribute('aria-live', 'off');
  el.append(grid, label, sep, time);

  let since = 0;
  /** @type {number | null} */
  let timer = null;
  const tick = () => {
    time.textContent = formatElapsed(Date.now() - since, true);
  };

  return {
    el,
    setLabel(text) {
      if (label.textContent !== text) label.textContent = text;
    },
    start(startedAt) {
      since = startedAt;
      if (timer === null) {
        tick();
        timer = window.setInterval(tick, 100);
      }
    },
    stop() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ---- Reasoning ---- //

/**
 * A collapsible reasoning row, collapsed by default. Its label shimmers while
 * the reasoning is still arriving, then reads how long it took.
 * @returns {ThinkingBlock}
 */
export function createThinkingBlock() {
  const startedAt = Date.now();
  const el = elem('div', 'op-thinking live');
  const head = button('op-thinking-head');
  head.setAttribute('aria-expanded', 'false');
  const glyph = chatIcon('spark');
  glyph.classList.add('op-thinking-glyph');
  const label = elem('span', 'op-thinking-label op-shimmer', 'Thinking');
  const chevron = chatIcon('chevron');
  chevron.classList.add('op-thinking-chevron');
  head.append(glyph, label, chevron);
  const body = elem('div', 'op-thinking-body');
  body.hidden = true;
  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  el.append(head, body);

  return {
    el,
    add(text) {
      body.append(text);
    },
    set(text) {
      body.textContent = text;
    },
    finish() {
      el.classList.remove('live');
      label.classList.remove('op-shimmer');
      const elapsed = Date.now() - startedAt;
      label.textContent = elapsed >= 1000 ? `Thought for ${formatElapsed(elapsed)}` : 'Thought';
      // Models that return redacted reasoning send empty blocks: nothing to open.
      if (!body.textContent?.trim()) {
        el.classList.add('empty');
        head.disabled = true;
      }
    },
  };
}

// ---- Tool calls ---- //

/**
 * One tool call: category icon, display name, a one-line input summary, and a
 * status that is a spinner until its result lands and then a check or a red x.
 * A click opens the full input and the result preview.
 * @param {WireEvent} event
 * @returns {{ el: HTMLElement, finish: (outcome: ToolOutcome) => void }}
 */
function createToolChip(event) {
  const name = String(event.tool_name || event.tool_name_raw || 'tool');
  const el = elem('div', 'op-tool');
  el.dataset.state = 'running';

  const head = button('op-tool-head');
  head.setAttribute('aria-expanded', 'false');
  const icon = chatIcon(CATEGORY_ICON[toolCategory(event.tool_name_raw ?? event.tool_name)]);
  icon.classList.add('op-tool-icon');
  const status = elem('span', 'op-tool-status');
  status.append(spinner());
  head.append(
    icon,
    elem('span', 'op-tool-name', name),
    elem('span', 'op-tool-input', summarizeInput(event.input)),
    status,
  );

  const detail = elem('div', 'op-tool-detail');
  detail.hidden = true;
  const resultPre = elem('pre', 'op-tool-pre', 'Waiting for the result…');
  detail.append(
    section('Input', elem('pre', 'op-tool-pre', prettyJson(event.input))),
    section('Result', resultPre),
  );
  head.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  el.append(head, detail);

  return {
    el,
    finish(outcome) {
      el.dataset.state = outcome.is_error ? 'error' : 'done';
      status.replaceChildren(chatIcon(outcome.is_error ? 'x' : 'check'));
      const preview = outcome.preview ?? '';
      resultPre.textContent = preview ? `${preview}${outcome.truncated ? '\n…' : ''}` : '(no output)';
      resultPre.classList.toggle('op-tool-error', Boolean(outcome.is_error));
    },
  };
}

/**
 * A labelled block inside an expanded chip.
 * @param {string} title
 * @param {HTMLElement} content
 * @returns {HTMLElement}
 */
function section(title, content) {
  const node = elem('div', 'op-tool-section');
  node.append(elem('span', 'op-tool-label', title), content);
  return node;
}

/** The text a subagent call's result opens with when the agent went to the background. */
const ASYNC_LAUNCH_MARK = 'Async agent launched';

/**
 * One subagent call as a chip: the agent type, its task, and a live note of
 * what it is doing. Opened, it shows the agent's own tool calls and messages,
 * nested, so they never read as the main agent's. A background agent stays
 * running past its launch result until its report lands.
 * @param {WireEvent} event - the `Agent`/`Task` tool_use
 * @param {(el: HTMLElement, text: string) => void} renderText - markdown renderer
 * @param {() => void} onSettled - called once, when the agent finishes
 * @returns {{ el: HTMLElement } & AgentChip}
 */
function createAgentChip(event, renderText, onSettled) {
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const name = String(input.subagent_type || 'agent');
  const el = elem('div', 'op-tool op-agent');
  el.dataset.state = 'running';

  const head = button('op-tool-head');
  head.setAttribute('aria-expanded', 'false');
  const icon = chatIcon('agent');
  icon.classList.add('op-tool-icon');
  const note = elem('span', 'op-agent-note');
  const status = elem('span', 'op-tool-status');
  status.append(spinner());
  head.append(
    icon,
    elem('span', 'op-tool-name', name),
    elem('span', 'op-tool-input', oneLine(String(input.description || ''))),
    note,
    status,
  );

  const trace = elem('div', 'op-agent-trace');
  const empty = elem('span', 'op-agent-empty', 'Nothing yet.');
  trace.append(empty);
  const resultPre = elem('pre', 'op-tool-pre', 'Waiting for the agent…');
  const detail = elem('div', 'op-tool-detail');
  detail.hidden = true;
  detail.append(section('Activity', trace), section('Result', resultPre));
  head.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  el.append(head, detail);

  /** The agent's own last message: its report, when the outcome carries none. */
  let lastText = '';
  let tools = 0;
  let latest = '';
  let phase = 'Working';
  let settled = false;

  function renderNote() {
    const count = tools > 0 ? `${tools} tool call${tools === 1 ? '' : 's'}` : '';
    const live = settled ? '' : latest;
    note.textContent = [settled ? '' : phase, count, live].filter(Boolean).join(' · ');
  }
  renderNote();

  /** @param {AgentOutcome} outcome */
  function settle(outcome) {
    settled = true;
    const failed = Boolean(outcome.is_error) || outcome.status === 'failed';
    const stopped = outcome.status === 'stopped';
    el.dataset.state = failed ? 'error' : stopped ? 'stopped' : 'done';
    status.replaceChildren(chatIcon(failed ? 'x' : stopped ? 'stop' : 'check'));
    const text = outcome.summary || outcome.preview || lastText;
    resultPre.textContent = text || (stopped ? 'Stopped.' : '(no report)');
    resultPre.classList.toggle('op-tool-error', failed);
    renderNote();
    onSettled();
  }

  return {
    el,
    name,
    addTool(toolEvent) {
      empty.remove();
      tools += 1;
      latest = String(toolEvent.tool_name || toolEvent.tool_name_raw || '');
      renderNote();
      const chip = createToolChip(toolEvent);
      trace.append(chip.el);
      return chip;
    },
    addText(text) {
      if (!text.trim()) return;
      empty.remove();
      lastText = text;
      const block = elem('div', 'op-agent-text osprey-md-rendered');
      renderText(block, text);
      trace.append(block);
    },
    finish(outcome) {
      if (settled) return;
      // A background agent's launch result is not its end: it reports later.
      if (!outcome.status && (outcome.preview ?? '').includes(ASYNC_LAUNCH_MARK)) {
        phase = 'In background';
        el.dataset.state = 'background';
        renderNote();
        return;
      }
      settle(outcome);
    },
    running: () => !settled,
  };
}

/**
 * A run of consecutive tool calls as one collapsible row. It stays open while
 * the turn works through it and folds itself away once the agent moves on —
 * unless the operator opened or closed it, and then the state is theirs. A
 * subagent counts on its own, so the folded row still says what it did:
 * "1 agent finished · 3 tool calls".
 * @returns {ToolGroup}
 */
export function createToolGroup() {
  const el = elem('div', 'op-tools open');
  const head = button('op-tools-head');
  head.setAttribute('aria-expanded', 'true');
  const chevron = chatIcon('chevron');
  chevron.classList.add('op-tools-chevron');
  const label = elem('span', 'op-tools-label');
  const status = elem('span', 'op-tools-status');
  head.append(chevron, label, status);
  const list = elem('div', 'op-tools-list');
  el.append(head, list);

  let total = 0;
  let running = 0;
  let failed = 0;
  let agents = 0;
  let agentsRunning = 0;
  let open = true;
  let operatorChose = false;
  let foldWhenIdle = false;

  function render() {
    const parts = [];
    if (agents > 0) {
      const noun = `agent${agents === 1 ? '' : 's'}`;
      parts.push(agentsRunning > 0 ? `${agents} ${noun} working` : `${agents} ${noun} finished`);
    }
    if (total > 0 || agents === 0) parts.push(`${total} tool call${total === 1 ? '' : 's'}`);
    if (failed > 0) parts.push(`${failed} failed`);
    label.textContent = parts.join(' · ');
    const busy = running + agentsRunning > 0;
    status.dataset.state = busy ? 'running' : failed > 0 ? 'failed' : 'done';
    status.replaceChildren(busy ? spinner() : chatIcon(failed > 0 ? 'x' : 'check'));
  }

  /** @param {boolean} on */
  function setOpen(on) {
    open = on;
    el.classList.toggle('open', on);
    head.setAttribute('aria-expanded', String(on));
    list.hidden = !on;
  }

  head.addEventListener('click', () => {
    operatorChose = true;
    setOpen(!open);
  });
  render();

  return {
    el,
    addTool(event) {
      total += 1;
      running += 1;
      render();
      const chip = createToolChip(event);
      list.append(chip.el);
      let settled = false;
      return {
        finish(outcome) {
          if (settled) return;
          settled = true;
          running -= 1;
          if (outcome.is_error) failed += 1;
          chip.finish(outcome);
          render();
        },
      };
    },
    addAgent(event, renderText) {
      agents += 1;
      agentsRunning += 1;
      render();
      const chip = createAgentChip(event, renderText, () => {
        agentsRunning -= 1;
        if (chip.el.dataset.state === 'error') failed += 1;
        render();
        if (agentsRunning === 0 && foldWhenIdle && !operatorChose) setOpen(false);
      });
      list.append(chip.el);
      return chip;
    },
    settle() {
      // An agent still working keeps its row in view; it folds once it reports.
      if (agentsRunning > 0) foldWhenIdle = true;
      else if (!operatorChose) setOpen(false);
    },
  };
}

// ---- Plan ---- //

/**
 * The turn's plan: one card, rewritten in place each time the agent updates its
 * todo list. A k/n counter sits in the header.
 * @returns {TaskCard}
 */
export function createTaskCard() {
  const el = elem('section', 'op-tasks');
  el.setAttribute('aria-label', 'Tasks');
  const head = elem('header', 'op-tasks-head');
  head.append(elem('span', 'op-tasks-title', 'Tasks'), elem('span', 'op-tasks-count'));
  const count = /** @type {HTMLElement} */ (head.querySelector('.op-tasks-count'));
  const list = elem('ul', 'op-task-list');
  el.append(head, list);

  return {
    el,
    update(todos) {
      let done = 0;
      const rows = todos.map((item) => {
        const status = normaliseStatus(item.status);
        if (status === 'completed') done += 1;
        const row = elem('li', 'op-task');
        row.dataset.status = status;
        const glyph = elem('span', 'op-task-glyph');
        if (status === 'completed') glyph.append(chatIcon('check'));
        const text =
          status === 'in_progress'
            ? item.activeForm || item.content || ''
            : item.content || item.activeForm || '';
        row.append(glyph, elem('span', 'op-task-text', text));
        return row;
      });
      list.replaceChildren(...rows);
      count.textContent = `${done}/${todos.length}`;
    },
  };
}

/**
 * @param {string | undefined} status
 * @returns {'pending' | 'in_progress' | 'completed'}
 */
function normaliseStatus(status) {
  return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

// ---- Permission cards ---- //

/**
 * Hand one answer to the renderer's hook and classify the outcome.
 * @param {CardHooks} hooks
 * @param {PermissionBody} body
 * @returns {Promise<'answered' | 'stale' | 'failed'>}
 */
async function deliver(hooks, body) {
  try {
    await hooks.answer(body);
    return 'answered';
  } catch (err) {
    return /** @type {{ status?: number } | undefined} */ (err)?.status === 404 ? 'stale' : 'failed';
  }
}

/**
 * The approval card for a tool call the operator must allow or deny, or — for
 * kind `plan` — the plan the agent wants to carry out. Enter allows and Escape
 * denies while the card has focus. Where the request offers it, "Allow for this
 * session" also lets the tool run without asking until the session ends. Once
 * answered it folds to one line stating the outcome.
 * @param {WireEvent} request - a `permission_request` event of kind `tool` or `plan`
 * @param {CardHooks & { renderText?: (el: HTMLElement, text: string) => void }} hooks
 * @returns {PermissionCard}
 */
export function createApprovalCard(request, hooks) {
  const isPlan = request.kind === 'plan';
  const toolName = String(request.tool_name || request.tool_name_raw || 'this tool');
  const el = elem('section', `op-card op-approval${isPlan ? ' op-plan' : ''}`);
  el.dataset.state = 'pending';
  el.tabIndex = -1;
  el.setAttribute('aria-label', isPlan ? 'Plan to approve' : `Approval needed for ${toolName}`);

  const head = elem('div', 'op-card-head');
  const toolIcon = chatIcon(
    isPlan ? 'read' : CATEGORY_ICON[toolCategory(request.tool_name_raw ?? request.tool_name)],
  );
  toolIcon.classList.add('op-card-icon');
  head.append(
    toolIcon,
    elem('span', 'op-card-title', isPlan ? 'Ready to start on this plan?' : `Allow ${toolName}?`),
  );

  const body = elem('div', 'op-card-body');
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (reason && !isPlan) body.append(elem('p', 'op-card-reason', reason));

  if (isPlan) {
    const plan = elem('div', 'op-card-plan osprey-md-rendered');
    const text = String(request.input?.plan ?? '');
    if (hooks.renderText) hooks.renderText(plan, text);
    else plan.textContent = text;
    body.append(plan);
  } else {
    const summary = elem('div', 'op-card-summary');
    summary.append(elem('code', 'op-card-input', summarizeInput(request.input)));
    const toggle = button('op-card-toggle', 'Details');
    toggle.setAttribute('aria-expanded', 'false');
    summary.append(toggle);
    const detail = elem('pre', 'op-card-detail', prettyJson(request.input));
    detail.hidden = true;
    toggle.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide' : 'Details';
    });
    body.append(summary, detail);
  }

  const error = elem('p', 'op-card-error');
  error.hidden = true;
  const deny = button('op-btn', isPlan ? 'Keep planning' : 'Deny');
  const allow = button('op-btn op-btn-primary', isPlan ? 'Approve plan' : 'Allow');
  const session = request.can_allow_session && !isPlan ? button('op-btn', 'Allow for this session') : null;
  const actions = elem('div', 'op-card-actions');
  actions.append(deny, ...(session ? [session] : []), allow);
  body.append(error, actions);
  el.append(head, body);
  let state = 'pending';
  const isPending = () => state === 'pending' || state === 'sending';

  /**
   * Fold the card to its one-line resolved state.
   * @param {string} tone - the state, also the `data-state` CSS hook
   * @param {ChatIconName} iconName
   * @param {string} text
   */
  function fold(tone, iconName, text) {
    state = tone;
    el.dataset.state = tone;
    const line = elem('div', 'op-card-line');
    line.append(chatIcon(iconName), elem('span', 'op-card-line-text', text));
    el.replaceChildren(line);
  }

  function cancel() {
    if (!isPending()) return;
    fold('cancelled', 'circle', `Cancelled · ${isPlan ? 'plan' : toolName}`);
  }

  /**
   * Fold to the outcome line.
   * @param {boolean} allowed
   * @param {boolean} forSession
   */
  function foldOutcome(allowed, forSession) {
    if (isPlan) {
      if (allowed) fold('allowed', 'check', 'Plan approved');
      else fold('denied', 'x', 'Kept planning');
    } else if (allowed) {
      fold('allowed', 'check', `${forSession ? 'Allowed for this session' : 'Allowed'} · ${toolName}`);
    } else {
      fold('denied', 'x', `Denied · ${toolName}`);
    }
  }

  /**
   * @param {boolean} allowed
   * @param {boolean} [forSession]
   */
  async function decide(allowed, forSession = false) {
    if (state !== 'pending') return;
    state = 'sending';
    el.dataset.state = 'sending';
    for (const control of [allow, deny, session]) if (control) control.disabled = true;
    error.hidden = true;

    const outcome = await deliver(hooks, { allow: allowed, ...(forSession ? { for_session: true } : {}) });
    if (state !== 'sending') return; // the turn ended while the answer was in flight
    if (outcome === 'answered') {
      foldOutcome(allowed, forSession);
    } else if (outcome === 'stale') {
      cancel();
    } else {
      state = 'pending';
      el.dataset.state = 'pending';
      for (const control of [allow, deny, session]) if (control) control.disabled = false;
      error.textContent = 'Could not send that. Try again.';
      error.hidden = false;
    }
    hooks.onSettled();
  }

  allow.addEventListener('click', () => void decide(true));
  deny.addEventListener('click', () => void decide(false));
  session?.addEventListener('click', () => void decide(true, true));
  el.addEventListener('keydown', (event) => {
    if (state !== 'pending') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void decide(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void decide(false);
    }
  });

  return {
    el,
    get pending() {
      return isPending();
    },
    cancel,
    focus: () => allow.focus(),
    resolved(answer) {
      // Answered in another tab; an answer of this tab's own still in flight
      // folds the card itself.
      if (state !== 'pending') return;
      foldOutcome(Boolean(answer.allow), Boolean(answer.for_session));
      hooks.onSettled();
    },
  };
}

/**
 * @typedef {{ label: string, description: string }} QuestionOption
 */

/**
 * @typedef {object} QuestionSpec
 * @property {string} question
 * @property {string} header
 * @property {boolean} multiSelect
 * @property {QuestionOption[]} options
 */

/**
 * @typedef {object} QuestionPick
 * @property {Set<number>} picked - indices of the chosen options
 * @property {boolean} otherOn - whether the "Other…" answer counts
 * @property {string} other - the free text typed into "Other…"
 */

/**
 * The shape of an AskUserQuestion's `questions`, cleaned for display. A missing
 * or empty list becomes one free-text question, so the card always has a
 * page to show.
 * @param {unknown} raw
 * @returns {QuestionSpec[]}
 */
function normaliseQuestions(raw) {
  const specs = (Array.isArray(raw) ? raw : []).map((item) => {
    const q = /** @type {WireEvent} */ (item && typeof item === 'object' ? item : {});
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({
        label: String(o?.label ?? ''),
        description: String(o?.description ?? ''),
      }))
      .filter((o) => o.label !== '');
    return {
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      multiSelect: Boolean(q.multiSelect),
      options,
    };
  });
  return specs.length > 0
    ? specs
    : [{ question: 'The agent has a question.', header: '', multiSelect: false, options: [] }];
}

/**
 * The question card for an AskUserQuestion: one question per page, options as
 * radio rows (checkboxes for multi-select), and an "Other…" row for free text.
 * Keys 1–9 pick an option on the current page, the arrow keys turn pages,
 * Enter takes the primary action and Escape skips. Submit answers every
 * question, keyed by its exact text; Skip denies the request.
 * @param {WireEvent} request - a `permission_request` event of kind `question`
 * @param {CardHooks} hooks
 * @returns {PermissionCard}
 */
export function createQuestionCard(request, hooks) {
  const questions = normaliseQuestions(request.input?.questions);
  /** @type {QuestionPick[]} */
  const picks = questions.map(() => ({ picked: new Set(), otherOn: false, other: '' }));
  let page = 0;
  let state = 'pending';
  const isPending = () => state === 'pending' || state === 'sending';
  const isLast = () => page === questions.length - 1;

  const el = elem('section', 'op-card op-question');
  el.dataset.state = 'pending';
  el.tabIndex = -1;
  el.setAttribute('aria-label', 'Question from the agent');

  const head = elem('div', 'op-card-head');
  const icon = chatIcon('question');
  icon.classList.add('op-card-icon');
  const chip = elem('span', 'op-card-chip');
  const pager = elem('div', 'op-card-pager');
  const prev = button('op-pager');
  prev.setAttribute('aria-label', 'Previous question');
  const prevIcon = chatIcon('chevron');
  prevIcon.classList.add('op-pager-prev');
  prev.append(prevIcon);
  const position = elem('span', 'op-card-pos');
  const next = button('op-pager');
  next.setAttribute('aria-label', 'Next question');
  next.append(chatIcon('chevron'));
  pager.append(prev, position, next);
  head.append(icon, chip, pager);

  const prompt = elem('p', 'op-question-text');
  const list = elem('div', 'op-options');
  const error = elem('p', 'op-card-error');
  error.hidden = true;
  const skip = button('op-btn', 'Skip');
  const primary = button('op-btn op-btn-primary', 'Continue');
  const actions = elem('div', 'op-card-actions');
  actions.append(skip, primary);
  el.append(head, prompt, list, error, actions);

  /** @returns {QuestionPick} */
  const current = () => /** @type {QuestionPick} */ (picks[page]);

  /**
   * What one question's answer reads as: the chosen labels, then the typed
   * text, comma-joined. Empty when nothing is chosen.
   * @param {number} index
   * @returns {string}
   */
  function valueOf(index) {
    const q = questions[index];
    const pick = picks[index];
    const labels = [...pick.picked].sort((a, b) => a - b).map((n) => q.options[n].label);
    const other = pick.otherOn ? pick.other.trim() : '';
    if (other) labels.push(other);
    return labels.join(', ');
  }
  const answered = (/** @type {number} */ index) => valueOf(index) !== '';

  /** Sync every control to the current picks and pending state. No rebuild: typing must keep focus. */
  function refresh() {
    const q = questions[page];
    const pick = current();
    const busy = state === 'sending';
    for (const row of list.querySelectorAll('[data-option]')) {
      const option = row.getAttribute('data-option');
      const on = option === 'other' ? pick.otherOn : pick.picked.has(Number(option));
      row.setAttribute('aria-checked', String(on));
      row.classList.toggle('on', on);
      const mark = row.querySelector('.op-option-mark');
      if (mark) mark.replaceChildren(...(on && q.multiSelect ? [chatIcon('check')] : []));
      if (row instanceof HTMLButtonElement) row.disabled = busy;
    }
    const input = list.querySelector('input.op-other-input');
    if (input instanceof HTMLInputElement) input.disabled = busy;

    position.textContent = `${page + 1} / ${questions.length}`;
    pager.hidden = questions.length < 2;
    prev.disabled = busy || page === 0;
    next.disabled = busy || isLast();
    primary.textContent = isLast() ? 'Submit' : 'Continue';
    const complete = questions.every((_, i) => answered(i));
    primary.disabled = busy || (isLast() ? !complete : !answered(page));
    skip.disabled = busy;
  }

  /** Rebuild the current page's prompt and rows. */
  function render() {
    const q = questions[page];
    chip.textContent = q.header;
    chip.hidden = !q.header;
    prompt.textContent = q.question;
    const rows = q.options.map((option, index) => {
      const row = button('op-option');
      row.dataset.option = String(index);
      row.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
      const body = elem('span', 'op-option-body');
      body.append(elem('span', 'op-option-label', option.label));
      if (option.description) body.append(elem('span', 'op-option-desc', option.description));
      row.append(elem('span', 'op-option-key', String(index + 1)), elem('span', 'op-option-mark'), body);
      row.addEventListener('click', () => choose(index));
      return row;
    });
    rows.push(otherRow(q));
    list.replaceChildren(...rows);
    refresh();
  }

  /** @param {QuestionSpec} q */
  function otherRow(q) {
    const row = elem('div', 'op-option op-option-other');
    row.dataset.option = 'other';
    row.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
    row.tabIndex = 0;
    const key = q.options.length + 1 <= 9 ? String(q.options.length + 1) : '';
    const input = /** @type {HTMLInputElement} */ (document.createElement('input'));
    input.type = 'text';
    input.className = 'op-other-input';
    input.placeholder = 'Other…';
    input.setAttribute('aria-label', 'Other answer');
    input.value = current().other;
    input.addEventListener('input', () => {
      const pick = current();
      pick.other = input.value;
      pick.otherOn = input.value.trim() !== '';
      if (!q.multiSelect && pick.otherOn) pick.picked.clear();
      refresh();
    });
    const body = elem('span', 'op-option-body');
    body.append(input);
    row.append(elem('span', 'op-option-key', key), elem('span', 'op-option-mark'), body);
    row.addEventListener('click', (event) => {
      if (event.target !== input) chooseOther();
    });
    return row;
  }

  /** @param {number} index */
  function choose(index) {
    if (state !== 'pending') return;
    const q = questions[page];
    const pick = current();
    if (q.multiSelect) {
      if (pick.picked.has(index)) pick.picked.delete(index);
      else pick.picked.add(index);
    } else {
      pick.picked.clear();
      pick.picked.add(index);
      pick.otherOn = false;
      pick.other = '';
      const input = list.querySelector('input.op-other-input');
      if (input instanceof HTMLInputElement) input.value = '';
    }
    refresh();
  }

  function chooseOther() {
    if (state !== 'pending') return;
    const q = questions[page];
    const pick = current();
    if (q.multiSelect) {
      pick.otherOn = !pick.otherOn;
    } else {
      pick.picked.clear();
      pick.otherOn = true;
    }
    refresh();
    const input = list.querySelector('input.op-other-input');
    if (pick.otherOn && input instanceof HTMLInputElement) input.focus();
  }

  /** @param {number} next */
  function goTo(next) {
    if (state !== 'pending') return;
    const target = Math.min(Math.max(next, 0), questions.length - 1);
    if (target === page) return;
    page = target;
    render();
    el.focus({ preventScroll: true });
  }

  /** @returns {Record<string, string>} */
  function answersFor() {
    /** @type {Record<string, string>} */
    const answers = {};
    questions.forEach((q, i) => {
      answers[q.question] = valueOf(i);
    });
    return answers;
  }

  /**
   * Fold the card to its resolved state, listing what was answered.
   * @param {boolean} allowed
   */
  function foldResolved(allowed) {
    if (!allowed) {
      fold('skipped', 'x', 'Skipped');
      return;
    }
    fold('answered', 'check', 'Answered');
    const list2 = elem('ul', 'op-card-answers');
    questions.forEach((q, i) => {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = q.header || q.question;
      item.append(label, document.createTextNode(`: ${valueOf(i)}`));
      list2.append(item);
    });
    el.append(list2);
  }

  /** @param {boolean} allowed */
  async function send(allowed) {
    if (state !== 'pending') return;
    state = 'sending';
    el.dataset.state = 'sending';
    error.hidden = true;
    refresh();
    const body = allowed ? { allow: true, answers: answersFor() } : { allow: false };
    const outcome = await deliver(hooks, body);
    if (state !== 'sending') return; // the turn ended while the answer was in flight
    if (outcome === 'answered') {
      foldResolved(allowed);
    } else if (outcome === 'stale') {
      cancel();
    } else {
      state = 'pending';
      el.dataset.state = 'pending';
      error.textContent = 'Could not send that. Try again.';
      error.hidden = false;
      refresh();
    }
    hooks.onSettled();
  }

  function cancel() {
    if (!isPending()) return;
    fold('cancelled', 'circle', 'Cancelled');
  }

  /**
   * @param {string} tone
   * @param {ChatIconName} iconName
   * @param {string} text
   */
  function fold(tone, iconName, text) {
    state = tone;
    el.dataset.state = tone;
    const line = elem('div', 'op-card-line');
    line.append(chatIcon(iconName), elem('span', 'op-card-line-text', text));
    el.replaceChildren(line);
  }

  prev.addEventListener('click', () => goTo(page - 1));
  next.addEventListener('click', () => goTo(page + 1));
  skip.addEventListener('click', () => void send(false));
  primary.addEventListener('click', () => {
    if (!isLast()) goTo(page + 1);
    else void send(true);
  });
  el.addEventListener('keydown', (event) => {
    if (state !== 'pending') return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'Escape') {
      event.preventDefault();
      void send(false);
      return;
    }
    // A focused button keeps its own Enter (a click); anywhere else Enter takes the primary action.
    if (event.key === 'Enter' && !event.shiftKey && !(target instanceof HTMLButtonElement)) {
      event.preventDefault();
      primary.click();
      return;
    }
    if (target instanceof HTMLInputElement) return;
    if (/^[1-9]$/.test(event.key)) {
      const n = Number(event.key) - 1;
      const count = questions[page].options.length;
      if (n < count) {
        event.preventDefault();
        choose(n);
      } else if (n === count) {
        event.preventDefault();
        chooseOther();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(page - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(page + 1);
    }
  });

  render();

  return {
    el,
    get pending() {
      return isPending();
    },
    cancel,
    focus: () => el.focus(),
    resolved(answer) {
      // Answered in another tab; this tab's own answer in flight folds itself.
      if (state !== 'pending') return;
      if (answer.allow) fold('answered', 'check', 'Answered in another tab');
      else fold('skipped', 'x', 'Skipped');
      hooks.onSettled();
    },
  };
}

// ---- Turn furniture ---- //

/**
 * The line that closes a finished turn: how long it worked, and a copy of what
 * it said.
 * @param {{ durationMs: number, text: string, isError: boolean }} turn
 * @returns {HTMLElement}
 */
export function createTurnFooter({ durationMs, text, isError }) {
  const el = elem('div', 'op-footer');
  const lead = isError ? 'Ended with an error after' : 'Worked for';
  el.append(elem('span', 'op-footer-text', `${lead} ${formatElapsed(durationMs)}`));
  if (text) {
    const copy = button('op-copy');
    copy.title = 'Copy response';
    copy.setAttribute('aria-label', 'Copy response');
    copy.append(chatIcon('copy'));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return; // no clipboard here: the button simply does nothing
      }
      copy.classList.add('copied');
      copy.replaceChildren(chatIcon('check'));
      window.setTimeout(() => {
        copy.classList.remove('copied');
        copy.replaceChildren(chatIcon('copy'));
      }, 1500);
    });
    el.append(copy);
  }
  return el;
}

/**
 * A soft error card. Text only.
 * @param {string} message
 * @returns {HTMLElement}
 */
export function createErrorBlock(message) {
  const el = elem('div', 'op-error-block');
  el.setAttribute('role', 'alert');
  const icon = chatIcon('alert');
  icon.classList.add('op-error-icon');
  el.append(icon, elem('span', 'op-error-text', message));
  return el;
}

/** @returns {HTMLElement} */
export function createSessionDivider() {
  return elem('div', 'op-system', 'session reset');
}

/**
 * A one-line notice from the CLI in the log, e.g. that the conversation was
 * compacted. Not a message: it carries no text the agent said.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function createNotice(text) {
  const line = elem('div', 'op-notice');
  line.append(chatIcon('alert'), elem('span', 'op-notice-text', text));
  return line;
}

/**
 * An operator's turn: a soft bubble, right-aligned.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function createUserEntry(text) {
  const entry = elem('div', 'op-entry operator');
  entry.append(elem('div', 'op-bubble', text));
  return entry;
}

/**
 * The agent's side of a turn: no bubble. Its blocks are appended in order.
 * @returns {HTMLElement}
 */
export function createAgentEntry() {
  return elem('div', 'op-entry assistant');
}

/**
 * A markdown block of the agent's reply. The shared `osprey-md-rendered` class
 * is what the link handling and the markdown styles key on.
 * @returns {HTMLElement}
 */
export function createTextBlock() {
  return elem('div', 'op-entry-body osprey-md-rendered');
}
