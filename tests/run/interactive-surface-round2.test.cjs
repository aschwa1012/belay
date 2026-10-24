'use strict';
// interactive-surface-round2.test.cjs — the gate fixes of Opus review round 2 (ADR 0037): F1 (a session that ran a
// turn is never "not reached"), F2 (the assistant wait restarts on each act of the operator), F5 (no directory
// search before a first-message cue), F6 (a null line or a throw never escapes the timer).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../../src/run/interactive-surface.cjs');

const FIX = path.join(__dirname, 'fixtures', 'interactive');
const rd = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const DEBUG = rd('debug-pass.log');
const REQ = { model: 'claude-sonnet-5-5', permissionMode: 'auto', effort: null, versionFloor: '2.1.280' };
const SID = 'sid';
const SPATH = 'P/C--w/sid.jsonl';
const SPAWN = Date.parse('2026-10-07T18:28:30.000Z');
const DEBUG_NO_PROMPT = DEBUG.split('\n').filter((l) => !/cc_prompt_index/.test(l)).join('\n');

// The user entry without the two fields the gate recognises a typed message by.
const noOrigin = (text) => text.split('\n').map((l) => {
  if (!l.includes('"type":"user"')) return l;
  const o = JSON.parse(l); delete o.origin; delete o.promptSource; return JSON.stringify(o);
}).join('\n');
const assistantLine = rd('session-e1.jsonl').split('\n').find((l) => l.includes('"type":"assistant"')) + '\n';

function fakeEnv(files) {
  let t = 0;
  const timers = new Map();
  let id = 0;
  const calls = { readdir: 0, exists: 0 };
  return {
    files, calls,
    deps: {
      readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; },
      exists: (p) => { calls.exists += 1; return p in files; },
      readdir: () => { calls.readdir += 1; return [...new Set(Object.keys(files).filter((k) => k.startsWith('P/')).map((k) => k.split('/')[1]))]; },
      now: () => t,
      setTimeout: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
      clearTimeout: (h) => { timers.delete(h); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const mk = (env, over = {}) => S.createInteractiveGate({
  debugFile: 'D', projectsDir: 'P', cwd: 'C:\\w', sessionId: SID, requested: REQ, spawnedAt: SPAWN,
  surfaceMs: 15000, settleMs: 15000, pollMs: 250, deps: env.deps, ...over,
});
const watch = (p) => { const s = { done: false, value: null }; p.then((v) => { s.done = true; s.value = v; }); return s; };

// ------------------------------------------------------------------ F1

test('F1: a user entry without origin or promptSource and no cc_prompt_index is a turn that ran, not "not reached"', async () => {
  const env = fakeEnv({ D: DEBUG_NO_PROMPT, [SPATH]: noOrigin(rd('session-i2.jsonl')) });
  const g = mk(env);
  const r = await g.finalize();
  assert.strictEqual(typeof (await g.firstMessage), 'number', 'the session had a user entry, so a message was reached');
  assert.notStrictEqual(r.session.reason, 'not reached');
  assert.strictEqual(r.session.ok, false);
  assert.strictEqual(r.session.failed, 'no_assistant_reply_before_exit');
  const env2 = fakeEnv({ D: DEBUG_NO_PROMPT, [SPATH]: noOrigin(rd('session-e1.jsonl')) });
  const r2 = await mk(env2, { requested: { ...REQ, effort: 'high' } }).finalize();
  assert.strictEqual(r2.session.ok, true);
  assert.strictEqual(r2.debug.ok, true);
});

test('F1: an assistant entry alone, and a session file that does not parse, also count as reached (fail closed)', async () => {
  const onlyAssistant = '{"type":"permission-mode","permissionMode":"auto"}\n' + assistantLine;
  const g1 = mk(fakeEnv({ D: DEBUG_NO_PROMPT, [SPATH]: onlyAssistant }));
  await g1.finalize();
  assert.strictEqual(typeof (await g1.firstMessage), 'number');
  const g2 = mk(fakeEnv({ D: DEBUG_NO_PROMPT, [SPATH]: '{"type":"permission-mode"\n{"type":"user"}\n' }));
  const r2 = await g2.finalize();
  assert.strictEqual(r2.session.ok, false);
  assert.notStrictEqual(r2.session.reason, 'not reached');
});

for (const [label, debugValue] of [['missing', undefined], ['empty', '']]) {
  test(`F1: finalize with a ${label} debug file fails debug_file_missing, with a turn in the session file`, async () => {
    const files = { [SPATH]: noOrigin(rd('session-e1.jsonl')) };
    if (debugValue !== undefined) files.D = debugValue;
    const g = mk(fakeEnv(files), { requested: { ...REQ, effort: 'high' } });
    const r = await g.finalize();
    assert.strictEqual(r.debug.ok, false);
    assert.strictEqual(r.debug.failed, 'debug_file_missing');
  });
  test(`F1: finalize with a ${label} debug file and no turn at all is "not reached" (nothing else can fail before the session is reached)`, async () => {
    const files = {};
    if (debugValue !== undefined) files.D = debugValue;
    const g = mk(fakeEnv(files));
    const r = await g.finalize();
    assert.strictEqual(r.debug.ok, null);
    assert.strictEqual(r.debug.reason, 'not reached');
    assert.strictEqual(r.session.reason, 'not reached');
  });
}

test('F1: finalize with no turn and a debug log lacking a startup line is still "not reached"; a leak line fails at once', async () => {
  const cut = DEBUG_NO_PROMPT.split('\n').filter((l) => !/Loaded plugins - Enabled/.test(l)).join('\n');
  const bad = await mk(fakeEnv({ D: cut })).finalize();
  assert.strictEqual(bad.debug.ok, null);
  assert.strictEqual(bad.debug.reason, 'not reached');
  const good = await mk(fakeEnv({ D: DEBUG_NO_PROMPT })).finalize();
  assert.strictEqual(good.debug.reason, 'not reached');
  const leak = await mk(fakeEnv({ D: DEBUG_NO_PROMPT + '2026-10-07T18:29:30.000Z [DEBUG] Loaded 3 unique skills (0 unconditional)\n' })).finalize();
  assert.strictEqual(leak.debug.ok, false);
  assert.strictEqual(leak.debug.failed, 'skills');
});

// ------------------------------------------------------------------ F2

const withInterrupt = (text) => text + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, sessionId: SID, version: '2.1.293' }) + '\n';
const typedLine = () => JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' }, origin: { kind: 'human' }, promptSource: 'typed', sessionId: SID, version: '2.1.293' }) + '\n';

test('F2: a second typed entry at 290 s and a reply at 400 s pass (there is no assistant clock)', async () => {
  const env = fakeEnv({ D: DEBUG, [SPATH]: rd('session-i2.jsonl') });
  const g = mk(env);
  const s = watch(g.session);
  env.advance(290000); await tick();
  assert.strictEqual(s.done, false);
  env.files[SPATH] += typedLine();
  env.advance(110000); await tick(); // t = 400 s: past 300 s from the first message
  assert.strictEqual(s.done, false, 'killed at 300 s while the operator was still typing');
  env.files[SPATH] += assistantLine;
  env.advance(250); await tick();
  assert.strictEqual(s.value.ok, true);
  g.stop();
});

test('F2: an interrupt entry, and a user entry of an unrecognised shape, never get a live session killed for a pending model check (1 h); finalize fails it', async () => {
  for (const text of [withInterrupt(rd('session-i2.jsonl')), noOrigin(rd('session-i2.jsonl'))]) {
    const env = fakeEnv({ D: DEBUG, [SPATH]: text });
    const g = mk(env);
    const s = watch(g.session);
    env.advance(60 * 60 * 1000); await tick();
    assert.strictEqual(s.done, false);
    const r = await g.finalize();
    assert.strictEqual(r.session.failed, 'no_assistant_reply_before_exit');
  }
});

// ------------------------------------------------------------------ F5

test('F5: the directory search runs on its own 2 s throttle from the spawn with no cue; the direct path is tried every poll', async () => {
  const env = fakeEnv({ D: DEBUG_NO_PROMPT });
  const g = mk(env);
  env.advance(60000); await tick();
  assert.ok(env.calls.readdir >= 28 && env.calls.readdir <= 31, `searches: ${env.calls.readdir} in 60 s`);
  assert.ok(env.calls.exists >= 200, `the direct path was not tried each poll (${env.calls.exists})`);
  g.stop();
});

test('F5: a hashed-path session file is found by the search once the cue is there, and is cached; the direct hit needs no search', async () => {
  const env = fakeEnv({ D: DEBUG, 'P/C--long-0a1b/sid.jsonl': rd('session-e1.jsonl') });
  const g = mk(env, { requested: { ...REQ, effort: 'high' } });
  const r = await g.session;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.facts.session_file, 'P/C--long-0a1b/sid.jsonl');
  const readdirs = env.calls.readdir;
  env.advance(5000);
  assert.strictEqual(env.calls.readdir, readdirs, 'a found path was searched for again');
  const env2 = fakeEnv({ D: DEBUG, [SPATH]: rd('session-e1.jsonl') });
  await mk(env2, { requested: { ...REQ, effort: 'high' } }).session;
  assert.strictEqual(env2.calls.readdir, 0);
});

test('F5: finalize searches the directories even when no cue was seen', async () => {
  const env = fakeEnv({ D: DEBUG_NO_PROMPT, 'P/C--long-0a1b/sid.jsonl': noOrigin(rd('session-i2.jsonl')) });
  const g = mk(env);
  const r = await g.finalize();
  assert.strictEqual(r.session.ok, false);
  assert.notStrictEqual(r.session.reason, 'not reached');
});

// ------------------------------------------------------------------ F6

test('F6: a null, a number and an array line are unrecognised entries: the parse check fails, nothing throws', () => {
  for (const bad of ['null', '7', '[1]']) {
    const r = S.checkSessionFile(`{"type":"permission-mode","permissionMode":"auto"}\n${bad}\n`, REQ);
    assert.strictEqual(r.ok, false, bad);
    assert.strictEqual(r.failed, 'parse');
  }
});

test('F6: a null line in a live session file fails the session half at the poll, not in the timer', async () => {
  const env = fakeEnv({ D: DEBUG, [SPATH]: rd('session-i2.jsonl') + 'null\n' });
  const g = mk(env);
  env.advance(1000);
  const r = await g.session;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'parse');
  g.stop();
});

test('F6: a throw inside a tick settles that half as failed gate_error with the message; the timer survives', async () => {
  const weird = rd('session-i2.jsonl') + JSON.stringify({ type: 'assistant', message: { model: 5 } }) + '\n'; // model.startsWith is not a function
  const env = fakeEnv({ D: DEBUG, [SPATH]: weird });
  const g = mk(env);
  let thrown = null;
  try { env.advance(1000); } catch (e) { thrown = e; }
  assert.strictEqual(thrown, null, 'the throw escaped the timer tick');
  const r = await g.session;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'gate_error');
  assert.match(r.detail, /startsWith/);
  g.stop();
});

test('F6: a throw in finalize is contained the same way', async () => {
  const weird = rd('session-i2.jsonl') + JSON.stringify({ type: 'assistant', message: { model: 5 } }) + '\n';
  const g = mk(fakeEnv({ D: DEBUG, [SPATH]: weird }));
  const r = await g.finalize();
  assert.strictEqual(r.session.failed, 'gate_error');
});
