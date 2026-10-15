'use strict';
// run-interactive-helpers.cjs — the scaffolding shared by run-interactive.test.cjs and
// run-interactive-lifecycle.test.cjs: a spec writer, a fake of createInteractiveGate's contract
// ({ debug, session, firstMessage, current(), stop() }), a fake argv builder, and `start`, which runs
// `belay run` in this process against tests/run/fakes/fake-claude-interactive.cjs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const cmdRun = require('../../src/cli/cmd-run.cjs');

const { ROOT, sandbox, cleanup } = H;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude-interactive.cjs`;
const MARKER = '<!-- belay-mode: interactive -->';

function makeSpec(dir, overrides = {}, promptText = `${MARKER}\nthe interactive prompt\n`) {
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  const promptFile = `${dir}/prompt.md`;
  fs.writeFileSync(promptFile, promptText);
  fs.writeFileSync(`${wt}/CLAUDE.md`, 'WORKTREE-INSTRUCTIONS-SENTINEL\n');
  const runId = overrides.run_id || `run-int-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: `${dir}/orch`,
    on_embedder_failure: 'continue', mode: 'interactive', ...overrides,
  };
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { specPath, wt, runId, orchestratorDir: spec.orchestrator_dir };
}

// A fake of createInteractiveGate's contract. A half whose delay is `null` never settles by itself: `stop()`
// settles it to { ok: null, facts: learned }, as the real gate does ("stop keeps the facts learned so far").
// `firstMs: null` is a first message that never comes (firstMessage resolves null at stop).
// `afterDebug` runs just after the debug half settles.
function fakeGate({
  debug = { ok: true, facts: { version: '2.1.293' } },
  session = { ok: true, facts: { permission_mode: 'auto', version: '2.1.293', effort: 'high' } },
  debugMs = 50, sessionMs = 300, firstMs = 100, learned = {}, afterDebug = null, debugWhen = null,
} = {}) {
  const seen = [];
  const make = (opts) => {
    seen.push(opts);
    const timers = [];
    const stoppers = [];
    const later = (v, ms, whenStopped, after) => new Promise((r) => {
      if (ms === null) stoppers.push(() => r(whenStopped));
      else if (whenStopped && whenStopped.waitFor) { // fire `ms` after the condition holds, so a slow machine's late child still exists to be judged
        const poll = setInterval(() => { if (whenStopped.waitFor()) { clearInterval(poll); timers.push(setTimeout(() => { r(v); if (after) after(); }, ms)); } }, 25);
        timers.push(poll); stoppers.push(() => { clearInterval(poll); r({ ok: null, facts: {} }); });
      } else timers.push(setTimeout(() => { r(v); if (after) after(); }, ms));
    });
    const unsettled = () => ({ ok: null, facts: { ...learned } });
    return {
      debug: later(debug, debugMs, debugWhen ? Object.assign(unsettled(), { waitFor: debugWhen }) : unsettled(), afterDebug),
      session: later(session, sessionMs, unsettled()),
      firstMessage: later(Date.now(), firstMs, null),
      current: () => ({ debug: unsettled(), session: unsettled() }),
      stop() { timers.forEach(clearTimeout); stoppers.splice(0).forEach((f) => f()); },
    };
  };
  return { make, seen };
}

// What the launcher hands the argv function, turned into the flags the stub reads (and the real one emits).
function fakeArgv(captured, onCall) {
  return (o) => {
    captured.push(o);
    if (onCall) onCall(o);
    return ['--model', o.model, '--permission-mode', o.permissionMode, ...(o.effort ? ['--effort', o.effort] : []),
      '--append-system-prompt-file', o.appendSystemPromptFile, '--session-id', o.sessionId, '--debug-file', o.debugFile];
  };
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Runs `belay run` in this process. Env is set for the call and restored after, never left behind.
function start(dir, { env = {}, argv = [], gate = fakeGate(), captured = [], specOverrides = {}, prompt, deps = {}, onArgv, cwd = ROOT, ctxExtra = {} } = {}) {
  const { specPath, wt, runId, orchestratorDir } = makeSpec(dir, specOverrides, prompt);
  const cfg = `${dir}/claude-config`;
  const dataDir = `${dir}/.belay`;
  const recordFile = `${dir}/stub-record.json`;
  const set = {
    BELAY_CLAUDE_EXE: FAKE, CLAUDE_CONFIG_DIR: cfg, FAKE_RECORD_FILE: recordFile, FAKE_HOLD_MS: '300', ...env,
  };
  const saved = {};
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  const ctx = {
    argv: [specPath, ...argv], cwd, dataDir, json: true, ...ctxExtra,
    interactiveDeps: {
      argv: fakeArgv(captured, onArgv), createGate: gate.make,
      sessionFilePath: ({ cwd, sessionId }) => path.join(cfg, 'projects', encodeCwd(path.resolve(cwd)), `${sessionId}.jsonl`),
      ...deps,
    },
  };
  const done = cmdRun.run(ctx).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const record = () => { try { const x = JSON.parse(fs.readFileSync(recordFile, 'utf8')); return x; } catch { return null; } }; // ADR 0039: creation times noted while the processes are alive
  return { done, runId, dataDir, wt, orchestratorDir, record, cfg, captured, gate };
}

const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

async function withRun(t, fn) {
  const dir = sandbox();
  t.after(() => cleanup(dir));
  return fn(dir);
}

module.exports = { FAKE, MARKER, makeSpec, fakeGate, fakeArgv, encodeCwd, start, sleeper, withRun };
