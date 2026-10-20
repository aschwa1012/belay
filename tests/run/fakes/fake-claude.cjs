'use strict';
// A fake Claude Code substrate: reads stream-json user messages on stdin and answers with the same
// event shapes the real binary emits — system/init (one per user message, ADR 0008 §5), an
// assistant message with a tool_use and per-call usage, a user tool_result, and a cumulative
// result. Exits 0 when stdin closes, which is the graceful-stop path (ADR 0001 §5).
// Pointed at through BELAY_CLAUDE_EXE; launch.resolveExe runs a .cjs path under this Node binary.
// build step 6e-4 (ADR 0023 amendment 2): FAKE_ORPHAN_CHILD=1 spawns one plain child (stdio ignored,
// detached, its own process group) that sleeps 120 s and writes its own pid to FAKE_CHILD_PID_FILE;
// detached so it escapes Windows's own job-object cascade on a graceful exit, and nothing here takes it
// along on stdin close either way — the descendant a park's own kill-after-exit step exists to catch.

if (process.env.FAKE_ORPHAN_CHILD === '1') {
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore', detached: true });
  kid.unref();
  if (process.env.FAKE_CHILD_PID_FILE) fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(kid.pid));
}

// ADR 0045 (audit D06): FAKE_SPAWN_SCRIPT=<path> starts that script as an ordinary child of this process, the way a worker's Bash starts one.
if (process.env.FAKE_SPAWN_SCRIPT) {
  require('node:child_process').spawn(process.execPath, [process.env.FAKE_SPAWN_SCRIPT], { windowsHide: true, stdio: 'ignore' }).unref();
}

const SESSION = process.env.FAKE_SESSION_ID || 'fake-session-0000-0000-0000-000000000001';
const EXTRA_INIT = process.env.FAKE_EXTRA_INIT === '1'; // simulate an inbound cross-session turn
// 5b-2: the unsolicited turn's own init lands right after the answer it rides in on; its own
// assistant/result can be held back so a test can write a wake into the gap between the two.
const EXTRA_INIT_DELAY_MS = Number(process.env.FAKE_EXTRA_INIT_DELAY_MS || 0);
const HANG = process.env.FAKE_HANG === '1'; // accept input, never answer
// 5b-2: messages after the n-th are accepted (so a poll can still write) and never answered.
const HANG_AFTER = process.env.FAKE_HANG_AFTER === undefined ? null : Number(process.env.FAKE_HANG_AFTER);
let msgsSeen = 0;
// belay run (step 5a): hold every answer this many ms, so a test can observe a turn end mid-orchestrator-turn.
const ANSWER_DELAY_MS = Number(process.env.FAKE_ANSWER_DELAY_MS || 0);
// Hold every answer until this file exists, so a test decides when a turn ends instead of guessing a delay.
const ANSWER_GATE_FILE = process.env.FAKE_ANSWER_GATE_FILE || null;
const HEARTBEAT_MS = Number(process.env.FAKE_HEARTBEAT_MS || 0);
// The belay MCP server's reported status: 'connected', any other, 'none' (empty list), 'absent' (no key).
const MCP = process.env.FAKE_MCP || 'connected';
// build step 6d: the smallest env echo a test can drive, to stderr so it never disturbs stream-json.
if (process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT === '1') {
  process.stderr.write(`FAKE_ENV MCP_TOOL_TIMEOUT=${process.env.MCP_TOOL_TIMEOUT === undefined ? '(absent)' : process.env.MCP_TOOL_TIMEOUT} BELAY_WORKER_ID=${process.env.BELAY_WORKER_ID === undefined ? '(absent)' : process.env.BELAY_WORKER_ID}\n`);
}
// ADR 0021: the mode the session actually started in and the build's version, overridable by FAKE_PERMISSION_MODE.
const modeAt = process.argv.indexOf('--permission-mode');
const PERMISSION_MODE = process.env.FAKE_PERMISSION_MODE || (modeAt >= 0 ? process.argv[modeAt + 1] : 'default');
const VERSION = process.env.FAKE_CLAUDE_CODE_VERSION || '2.1.280-fake';
// ADR 0024, build step S2: the fake follows the real binary, never the reverse (6i-2's own rule). Its
// built-ins are exactly the comma-split `--tools` value (none if absent); its belay tools are the ones
// it lists today, less `permit` when `--permission-prompt-tool` is on this launch (decision 7).
const BELAY_TOOLS_TODAY = ['mcp__belay__memory_store'];
// The MCP servers this launch was actually given (--mcp-config, a file; --strict-mcp-config means nothing else): the real binary
// lists a server's tools only if the server is in that file, and the belay adapter lists none for a job worker (a reserved id prefix).
function launchedBelay() {
  const at = process.argv.indexOf('--mcp-config');
  if (at < 0) return { present: true, job: false }; // a launch without a config file: the old behaviour
  try {
    const cfg = JSON.parse(require('node:fs').readFileSync(process.argv[at + 1], 'utf8'));
    const srv = cfg && cfg.mcpServers && cfg.mcpServers.belay;
    if (!srv) return { present: false, job: false };
    const a = Array.isArray(srv.args) ? srv.args : [];
    const wid = a.indexOf('--worker-id');
    const id = wid >= 0 ? a[wid + 1] : null;
    return { present: true, job: a[a.indexOf('--role') + 1] === 'worker' && typeof id === 'string' && require('../../../src/core/job-ids.cjs').isJobId(id) };
  } catch { return { present: true, job: false }; }
}
function surfaceTools() {
  const idx = process.argv.indexOf('--tools');
  const builtins = idx >= 0 ? process.argv[idx + 1].split(',').filter(Boolean) : [];
  // S2 fix round 3 (review 2 should-fix): the real binary lists no mcp__belay__* tools when the belay
  // MCP server itself failed to connect, same as it would for any other failed server. The fake must
  // follow that, never the reverse — before this it kept listing BELAY_TOOLS_TODAY even on FAKE_MCP
  // values other than 'connected', which masked the connection-vs-surface ordering defect.
  if (MCP !== 'connected') return builtins;
  const lb = launchedBelay();
  if (!lb.present || lb.job) return builtins;
  const permit = process.argv.includes('--permission-prompt-tool');
  const belay = permit ? BELAY_TOOLS_TODAY.filter((t) => t !== 'mcp__belay__permit') : BELAY_TOOLS_TODAY;
  return [...builtins, ...belay];
}
// One knob corrupts the first init's own surface so surface-launch.test.cjs can drive the gate's
// refusal paths; a second applies it only once a launch is a resume (--resume in argv).
const FAKE_SURFACE = process.env.FAKE_SURFACE || null;
const FAKE_SURFACE_ON_RESUME = process.env.FAKE_SURFACE_ON_RESUME === '1';
const PLUGINS = [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }];
function initEvent() {
  const isResume = process.argv.includes('--resume');
  const ev = { type: 'system', subtype: 'init', session_id: SESSION, tools: surfaceTools(),
    permissionMode: PERMISSION_MODE, claude_code_version: VERSION, plugins: PLUGINS, model: MODEL };
  // ADR 0024 amendment 3: FAKE_MEMORY_AUTO=echo reports the autoMemoryDirectory the launch's --settings file names (as Claude Code does
  // when it honours it); any other value is reported as is; unset reports no memory_paths.
  if (process.env.FAKE_MEMORY_AUTO) {
    let auto = process.env.FAKE_MEMORY_AUTO;
    if (auto === 'echo') { try { auto = JSON.parse(require('node:fs').readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8')).autoMemoryDirectory; } catch (e) { auto = null; } }
    if (auto !== null && auto !== undefined) ev.memory_paths = { auto };
  }
  if (MCP === 'absent') return ev;
  ev.mcp_servers = MCP === 'none' || !launchedBelay().present ? [] : [{ name: 'belay', status: MCP }];
  if (FAKE_SURFACE && (!FAKE_SURFACE_ON_RESUME || isResume)) {
    if (FAKE_SURFACE === 'extra-tool') ev.tools = [...ev.tools, 'Task'];
    else if (FAKE_SURFACE === 'user-plugin') ev.plugins = [...ev.plugins, { name: 'example-plugin', path: 'user', source: 'example-plugin@example' }];
    else if (FAKE_SURFACE === 'memory') ev.memory_paths = { auto: 'C:/fake/memory/' };
    // S2 fix round F1: a malformed (non-array) plugins field — checkSurface must refuse this, never throw.
    else if (FAKE_SURFACE === 'plugins-object') ev.plugins = {};
  }
  return ev;
}

// A turn's closing burst (everything `finish()` says, the lifecycle lines included) goes out as one
// write, so a reader sees it in one chunk as the tests' "two turn ends in one chunk" premise needs;
// separate writes let the pipe split the burst once the wake-correlation fix added lifecycle lines.
let batch = null;
const say = (o) => { const l = JSON.stringify(o) + '\n'; if (batch) batch.push(l); else process.stdout.write(l); };
// Build 12 (ADR 0007 decision 3, the compact_at_tokens lever): with FAKE_CTX_START the final call of each turn reports
// a per-call context of ctxNow tokens, growing by FAKE_CTX_STEP per turn; a user message `/compact ...` answers as the
// real binary does (PreCompact hook, compact_boundary, SessionStart/PostCompact hooks, a result) and resets the context;
// FAKE_AUTO_COMPACT_AT makes a turn compact on its own, mid-turn, once the context is that high; FAKE_NO_POST_TOKENS
// leaves post_tokens out of the boundary; FAKE_RECV_FILE records every user text with whether a turn was running.
// The hooks come from the --settings file, run as shell commands with the payload on stdin. All of it is off by default.
const CTX_START = process.env.FAKE_CTX_START === undefined ? null : Number(process.env.FAKE_CTX_START);
const CTX_STEP = Number(process.env.FAKE_CTX_STEP || 0);
const AUTO_AT = process.env.FAKE_AUTO_COMPACT_AT ? Number(process.env.FAKE_AUTO_COMPACT_AT) : null;
const NO_POST = process.env.FAKE_NO_POST_TOKENS === '1';
let ctxNow = CTX_START;
let lastCtx = CTX_START; // what the last reported call said: a manual compaction's pre_tokens
function runHooks(event, trigger) {
  const at = process.argv.indexOf('--settings');
  if (at < 0) return;
  let hooks;
  try { hooks = JSON.parse(require('node:fs').readFileSync(process.argv[at + 1], 'utf8')).hooks; } catch { return; }
  for (const ent of (hooks && hooks[event]) || []) {
    if (ent.matcher && ent.matcher !== trigger) continue;
    for (const h of ent.hooks || []) {
      require('node:child_process').spawnSync(h.command, { shell: true, input: JSON.stringify({ trigger, hook_event_name: event }), encoding: 'utf8' });
    }
  }
}
function boundary(trigger) {
  runHooks('PreCompact', trigger);
  const meta = { trigger, pre_tokens: trigger === 'manual' ? lastCtx : ctxNow, duration_ms: 7 };
  if (!NO_POST) meta.post_tokens = 900;
  say({ type: 'system', subtype: 'compact_boundary', session_id: SESSION, compact_metadata: meta });
  runHooks('SessionStart', 'compact');
  runHooks('PostCompact', trigger);
  ctxNow = 900;
}
let turn = 0;
let cumIn = 0;
let cumOut = 0;
// build step W2-3: the fake follows the real binary's receipt fields. system/init names the model the session
// actually started with (FAKE_MODEL); every turn does FAKE_TOOL_USES tool_use/tool_result pairs (default 1);
// the closing result carries per-turn cache tokens in usage and a modelUsage block, in the shapes of
// tests/run/fixtures/claude-stream.jsonl. total_cost_usd is session-cumulative and survives a --resume, so
// FAKE_COST_BASE seeds the running total the way a resumed session inherits it.
const MODEL = process.env.FAKE_MODEL || 'fake-claude-model-1';
const TOOL_USES = Number(process.env.FAKE_TOOL_USES || 1);
const TURN_IN = 100; // result.usage is per turn, as the real binary reports it; modelUsage and total_cost_usd are session-cumulative
const TURN_OUT = 20;
const TURN_CACHE_READ = 1900;
const TURN_CACHE_CREATION = 7;
let cumCost = Number(process.env.FAKE_COST_BASE || 0);

// build step 6h design item 7: the real binary emits its system/init at once, and the rest of the turn
// after however long it takes to answer. `say(initEvent())` fires synchronously; `finish()` carries
// everything after it, delayed. FAKE_EXTRA_INIT's own turn still lands after this turn's own result.
// The wake-correlation fix: a user message carrying a `uuid` gets
// `command_lifecycle` events, `queued` on arrival, `started` when its turn takes it, `completed` after
// that turn's result. FAKE_FOLD=1 reproduces what the real binary does with a message that arrives
// during a running turn: no init and no turn of its own, consumed by the running turn, completed
// with it (a coalescing defect seen in an earlier probe).
const FOLD = process.env.FAKE_FOLD === '1';
let inTurn = false;
let folded = [];
const lifecycle = (uuid, state) => { if (uuid) say({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: SESSION }); };

// build step 6e (ADR 0023 decision 1): the in-flight turn's own delayed `finish`, so an interrupt
// arriving before it runs can cancel it and answer with error_during_execution instead. `null` once a
// turn's finish has run (or none is pending).
let pendingFinish = null;
const IGNORE_INTERRUPT = process.env.FAKE_IGNORE_INTERRUPT === '1';

// build step 6e-3, ADR 0023 amendment 1 decisions 1-2: with FAKE_BG_TASK=1, every turn backgrounds one
// Bash task that completes on its own FAKE_BG_TASK_MS after it started (unless stopped) and then starts
// a turn of its own (init, then a delayed success) — as bg-probe.cjs's bg-midturn receipt measured.
const BG_TASK = process.env.FAKE_BG_TASK === '1';
const BG_TASK_MS = Number(process.env.FAKE_BG_TASK_MS || 1500);
const BG_TURN_DELAY_MS = Number(process.env.FAKE_BG_TURN_DELAY_MS || 100);
const STOP_TASK_UNSUPPORTED = process.env.FAKE_STOP_TASK_UNSUPPORTED === '1';
const BG_CMD = 'sleep 20 && echo slept > marker.txt';
let bgSeq = 0;
const bgTasks = new Map();
// A turn the substrate starts on its own (a bg-task completion, or EXTRA_INIT below) — cancelable by
// `interrupt()` the same way `pendingFinish` is, but never confused with it.
let pendingUnsolicited = null;
function scheduleUnsolicited(finishFn, ms) { if (ms > 0) pendingUnsolicited = { timer: setTimeout(finishFn, ms) }; else finishFn(); }
function runningBgList() {
  const out = [];
  for (const [id, rec] of bgTasks) if (!rec.stopped && !rec.completed) out.push({ task_id: id, task_type: 'local_bash', description: BG_CMD });
  return out;
}
function finishBg() {
  pendingUnsolicited = null;
  say({ type: 'assistant', session_id: SESSION, message: { role: 'assistant', content: [{ type: 'text', text: 'bg task done' }], usage: { input_tokens: 5, output_tokens: 5 } } });
  say({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: turn, total_cost_usd: cumCost, result: 'bg task done', usage: { input_tokens: TURN_IN, output_tokens: TURN_OUT } });
}
function completeBgTask(taskId) {
  const rec = bgTasks.get(taskId);
  if (!rec || rec.stopped || rec.completed) return;
  rec.completed = true;
  say({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: Date.now() }, session_id: SESSION });
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: runningBgList(), session_id: SESSION });
  say({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary: BG_CMD, session_id: SESSION });
  say({ type: 'system', subtype: 'init', session_id: SESSION, tools: [], mcp_servers: [] });
  scheduleUnsolicited(finishBg, BG_TURN_DELAY_MS);
}
// design item 5: not_supported still lets the task complete and start its own turn (above).
function stopTask(requestId, taskId) {
  process.stderr.write(`FAKE_CONTROL stop_task ${taskId}\n`);
  if (STOP_TASK_UNSUPPORTED) {
    say({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not_supported' } });
    return;
  }
  const rec = bgTasks.get(taskId);
  if (!rec || rec.completed) {
    say({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'unknown task' } });
    return;
  }
  clearTimeout(rec.timer);
  rec.stopped = true;
  say({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  say({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'killed', end_time: Date.now() }, session_id: SESSION });
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: runningBgList(), session_id: SESSION });
}

function answer(text, uuid) {
  inTurn = true;
  lifecycle(uuid, 'started');
  turn += 1;
  cumIn += 100;
  cumOut += 20;
  cumCost += 0.001;
  say(initEvent());
  if (BG_TASK) {
    const taskId = 'bgtask_' + (++bgSeq);
    say({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: 'tu_bg_' + taskId, description: BG_CMD, is_backgrounded: true, task_type: 'local_bash', session_id: SESSION });
    const rec = { stopped: false, completed: false };
    bgTasks.set(taskId, rec);
    rec.timer = setTimeout(() => completeBgTask(taskId), BG_TASK_MS);
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: runningBgList(), session_id: SESSION });
  }
  const finish = () => {
    pendingFinish = null;
    batch = [];
    for (let k = 0; k < TOOL_USES; k += 1) {
      const tid = 'tu_' + turn + '_' + k;
      say({
        type: 'assistant',
        session_id: SESSION,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: tid, name: 'Read', input: { file_path: k === 0 ? 'input.md' : 'input' + k + '.md' } }],
          usage: { input_tokens: 90, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: k === 0 ? TURN_CACHE_CREATION : 0 },
        },
      });
      say({ type: 'user', session_id: SESSION, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: 'file contents here' }] }] } });
    }
    if (CTX_START !== null && AUTO_AT !== null && ctxNow >= AUTO_AT) boundary('auto');
    say({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        ...(CTX_START !== null ? { id: 'msg_fake_' + turn } : {}),
        content: [{ type: 'text', text: 'echo: ' + text }],
        usage: CTX_START !== null
          ? { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: ctxNow - 10, cache_creation_input_tokens: 0 }
          : { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      },
    });
    if (CTX_START !== null) { lastCtx = ctxNow; ctxNow += CTX_STEP; }
    say({
      type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: turn,
      duration_ms: 5, total_cost_usd: cumCost, result: 'echo: ' + text,
      usage: { input_tokens: TURN_IN, output_tokens: TURN_OUT, cache_read_input_tokens: TURN_CACHE_READ, cache_creation_input_tokens: TURN_CACHE_CREATION },
      modelUsage: { [MODEL]: { inputTokens: cumIn, outputTokens: cumOut, cacheReadInputTokens: turn * TURN_CACHE_READ, cacheCreationInputTokens: turn * TURN_CACHE_CREATION, costUSD: cumCost, contextWindow: 200000 } },
    });
    for (const u of folded) lifecycle(u, 'completed');
    lifecycle(uuid, 'completed');
    folded = [];
    inTurn = false;
    if (EXTRA_INIT) {
      // An inbound cross-session message: a second init for the same session id and a whole turn the
      // parent never wrote to stdin (ADR 0008 §5). The init itself is immediate; its assistant/result
      // can be delayed (5b-2) so a test can observe a wake written into the gap between the two.
      say({ type: 'system', subtype: 'init', session_id: SESSION, tools: [], mcp_servers: [] });
      scheduleUnsolicited(() => {
        pendingUnsolicited = null;
        say({ type: 'assistant', session_id: SESSION, message: { role: 'assistant', content: [{ type: 'text', text: 'unsolicited' }], usage: { input_tokens: 5, output_tokens: 5 } } });
        say({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: turn, total_cost_usd: cumCost, result: 'unsolicited', usage: { input_tokens: TURN_IN, output_tokens: TURN_OUT } });
      }, EXTRA_INIT_DELAY_MS);
    }
    const burst = batch.join('');
    batch = null;
    process.stdout.write(burst);
  };
  if (ANSWER_GATE_FILE && !require('node:fs').existsSync(ANSWER_GATE_FILE)) {
    const timer = setInterval(() => { if (require('node:fs').existsSync(ANSWER_GATE_FILE)) { clearInterval(timer); finish(); } }, 20);
    pendingFinish = { uuid, timer }; // an interrupt's clearTimeout clears this interval too
  } else if (ANSWER_DELAY_MS > 0) {
    // FAKE_HEARTBEAT_MS: a tool_progress line this often until the turn ends, as the real binary does mid-tool.
    const hb = HEARTBEAT_MS > 0 ? setInterval(() => say({ type: 'tool_progress', session_id: SESSION }), HEARTBEAT_MS) : null;
    const timer = setTimeout(() => { if (hb) clearInterval(hb); finish(); }, ANSWER_DELAY_MS);
    pendingFinish = { uuid, timer };
  } else finish();
}

// build step 6e (ADR 0023 decision 1): answers a stream-json interrupt control_request the way the real
// binary was measured to: a control_response of subtype success at
// once, and, when a turn's own finish has not yet run, that turn's result becomes
// error_during_execution instead, followed by a cancelled lifecycle for its uuid and every folded one —
// as one write, so a reader never sees the result split from its lifecycle line.
function interrupt(requestId) {
  process.stderr.write(`FAKE_CONTROL interrupt ${requestId}\n`);
  if (IGNORE_INTERRUPT) return;
  say({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } });
  // 6e-3: an unsolicited turn (a bg-task completion or EXTRA_INIT) this fake itself started, checked
  // first, since it is not the message-driven turn `pendingFinish` tracks below. Fix round: the
  // onInitWhilePaused interception this comment used to name is gone (6e-4 deletes it, item 5) — the
  // real substrate's own park now ends the process outright, so nothing belay writes intercepts this.
  if (pendingUnsolicited) {
    clearTimeout(pendingUnsolicited.timer);
    pendingUnsolicited = null;
    say({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION, num_turns: turn, duration_ms: 1, total_cost_usd: cumCost, usage: { input_tokens: TURN_IN, output_tokens: TURN_OUT } });
    return;
  }
  if (!pendingFinish) return;
  const { uuid, timer } = pendingFinish;
  clearTimeout(timer);
  pendingFinish = null;
  batch = [];
  say({
    type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION,
    num_turns: turn, duration_ms: 1, total_cost_usd: cumCost,
    usage: { input_tokens: TURN_IN, output_tokens: TURN_OUT },
  });
  for (const u of folded) lifecycle(u, 'cancelled');
  lifecycle(uuid, 'cancelled');
  folded = [];
  inTurn = false;
  const burst = batch.join('');
  batch = null;
  process.stdout.write(burst);
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    // build step 6e: a control_request is never a user message — no init, no answer, not counted by
    // FAKE_HANG_AFTER (ADR 0023 decision 1: the parser's own vocabulary keeps the two apart). 6e-2
    // (note fake-claude.cjs:180): every control_request line is kept out of the message path, not only
    // an interrupt one; any other subtype is answered an error, the way the real binary would refuse one
    // this adapter never sends.
    if (j.type === 'control_request') {
      if (j.request && j.request.subtype === 'interrupt') interrupt(j.request_id);
      else if (j.request && j.request.subtype === 'stop_task') stopTask(j.request_id, j.request.task_id);
      else say({ type: 'control_response', response: { subtype: 'error', request_id: j.request_id, error: 'unsupported in the fake' } });
      continue;
    }
    if (HANG) continue;
    msgsSeen += 1;
    if (HANG_AFTER !== null && msgsSeen > HANG_AFTER) continue; // accepted, never answered
    const text = (((j.message || {}).content || []).find((c) => c.type === 'text') || {}).text || '';
    if (process.env.FAKE_RECV_FILE) require('node:fs').appendFileSync(process.env.FAKE_RECV_FILE, JSON.stringify({ text, in_turn: inTurn }) + '\n');
    lifecycle(j.uuid, 'queued');
    if (CTX_START !== null && text.startsWith('/compact')) {
      lifecycle(j.uuid, 'started');
      turn += 1;
      say(initEvent());
      const doCompact = () => {
        boundary('manual');
        say({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: turn, duration_ms: 5, total_cost_usd: cumCost, result: '', usage: { input_tokens: 5, output_tokens: 5 } });
        lifecycle(j.uuid, 'completed');
        inTurn = false;
      };
      inTurn = true; // a real /compact takes seconds (7 to 28 s measured); FAKE_COMPACT_DELAY_MS models that
      if (Number(process.env.FAKE_COMPACT_DELAY_MS || 0) > 0) setTimeout(doCompact, Number(process.env.FAKE_COMPACT_DELAY_MS)); else doCompact();
      continue;
    }
    if (FOLD && inTurn) { lifecycle(j.uuid, 'started'); if (j.uuid) folded.push(j.uuid); continue; }
    answer(text, j.uuid); // ANSWER_DELAY_MS is now inside answer(), between its immediate init and the rest
  }
});
// A worker that does not exit when its stdin closes: the wedged case ADR 0001 §5's graceful stop
// has to time out on before belay kills it. Without this the fake always exits on stdin end and the
// timeout branch is never reached.
if (process.env.FAKE_IGNORE_STDIN_END === '1') setInterval(() => {}, 1000);
else process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
