'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// interactive-wave2-fix.test.cjs — the wave 2 review's findings (ADR 0037 amendment 5): the delivered-file
// ordering of the mod (the real core.mjs), a throwing hold fails closed, the wake pipe cannot be squatted, and
// the plugin copy's hash is enforced at finalize and while claude runs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
const PC = require('../../src/run/plugin-copy.cjs');
const P = require('../../src/run/process.cjs');
const H = require('../cli/run-interactive-helpers.cjs');
const L = require('../../src/run/launch.cjs');
// the real argv (it carries --plugin-dir) and the real gate: the helpers' default argv omits the plugin
const real = (extra = {}) => ({ argv: L.orchestratorInteractiveArgv, createGate: (o) => require('../../src/run/interactive-surface.cjs').createInteractiveGate(o), ...extra });

const T = { timeout: 120000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniquePipe = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\belay-test-w2fix-${crypto.randomBytes(5).toString('hex')}`
  : path.join(os.tmpdir(), `belay-test-w2fix-${crypto.randomBytes(5).toString('hex')}.sock`));
const modUrl = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;

// ---------------------------------------------------------------- delivered-file ordering (finding 3)

test('delivery: the id is recorded only after the file write succeeds, and the submit only after the record is persisted', async () => {
  const m = await import(modUrl);
  const log = [];
  let failWrite = true;
  const files = {};
  const submitted = [];
  const d = m.createDelivery({
    file: 'F', initial: '',
    io: {
      write: async (f, c) => { if (failWrite) throw new Error('disk full'); files[f] = c; },
      submit: async (t) => { assert.ok((files.F || '').includes('"id":"a"'), 'the submit ran before the record was on disk'); submitted.push(t); },
      log: (e) => log.push(e),
    },
  });
  assert.strictEqual(await d.deliver('a', 'one'), 'write-failed');
  assert.deepStrictEqual(submitted, [], 'a failed write submitted anyway');
  assert.strictEqual(d.delivered.has('a'), false, 'a failed write recorded the id in memory');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].stage, 'write');
  failWrite = false;
  assert.strictEqual(await d.deliver('a', 'one'), 'submitted', 'a wake whose write failed is deliverable on a replay');
  assert.deepStrictEqual(submitted, ['one']);
  assert.strictEqual(await d.deliver('a', 'one'), 'skip');
});

test('delivery: a failed submit is logged and never re-run (at most once)', async () => {
  const m = await import(modUrl);
  const log = [];
  let submits = 0;
  const d = m.createDelivery({ file: 'F', io: { write: async () => {}, submit: async () => { submits += 1; throw new Error('no prompt'); }, log: (e) => log.push(e) } });
  assert.strictEqual(await d.deliver('x', 't'), 'submit-failed');
  assert.strictEqual(log[0].stage, 'submit');
  assert.strictEqual(await d.deliver('x', 't'), 'skip');
  assert.strictEqual(submits, 1);
});

// ---------------------------------------------------------------- the hold fails closed (finding 6)

test('publisher: an isHeld that throws holds the wakes back, and one that stops throwing releases them', async () => {
  const rows = { v: [{ id: 'w1', run_id: 'r1', state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }] };
  const core = { worker: { list: async () => ({ workers: rows.v.map((r) => ({ ...r })) }) } };
  let broken = true;
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25, isHeld: () => { if (broken) throw new Error('unreadable'); return false; } });
  await pub.listening;
  try {
    await sleep(100);
    rows.v = [{ ...rows.v[0], turns: 1, seq: 2 }];
    await sleep(300);
    assert.strictEqual(pub.stats().published, 0, 'a throwing hold published');
    assert.ok(pub.stats().queued >= 1);
    broken = false;
    const end = Date.now() + 4000;
    while (pub.stats().published < 1 && Date.now() < end) await sleep(20);
    assert.strictEqual(pub.stats().published, 1);
  } finally { await pub.stop(); }
});

// ---------------------------------------------------------------- pipe squatting (finding 5)

test('publisher: a pipe name that is already taken rejects `listening`', async () => {
  const pipe = uniquePipe();
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(pipe, r));
  const core = { worker: { list: async () => ({ workers: [] }) } };
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25 });
  try { await assert.rejects(pub.listening, (e) => e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')); } finally { await pub.stop(); squatter.close(); }
});

test('launcher: a wake pipe that cannot be opened fails the launch before claude is spawned', T, async (t) => H.withRun(t, async (dir) => {
  const pipe = uniquePipe();
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(pipe, r));
  try {
    const r = H.start(dir, { env: { FAKE_HOLD_MS: '500' }, deps: { wakePipeName: pipe } });
    const res = await r.done;
    assert.strictEqual(res.code, 1, res.text);
    assert.match(res.json.ended_by, /the wake pipe could not be opened \(EADDRINUSE|the wake pipe could not be opened \(EACCES/);
    assert.strictEqual(r.record(), null, 'claude was spawned despite the failure');
    const { currentRunRow } = require('../cli/stop-helpers.cjs');
    let row;
    try { row = currentRunRow(r.dataDir, r.runId); } catch { row = null; } // no store at all is also "no run row"
    assert.ok(!row, 'a run row was written although the launch failed before the handover');
  } finally { squatter.close(); }
}));

test('launcher: belay-run.json carries an unguessable nonce; the pipe name is derived from it', T, async (t) => H.withRun(t, async (dir) => {
  const r = H.start(dir, { env: { FAKE_HOLD_MS: '800' } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  const cfg = JSON.parse(fs.readFileSync(`${r.orchestratorDir}/plugin/belay-run.json`, 'utf8'));
  assert.match(cfg.wake_nonce, /^[0-9a-f]{24}$/);
  const { wakePipeName } = require('../../src/run/wake-pipe.cjs');
  assert.notStrictEqual(wakePipeName(r.dataDir, r.runId, cfg.wake_nonce), wakePipeName(r.dataDir, r.runId, ''));
}));

// ---------------------------------------------------------------- the plugin hash is enforced (finding 2)

test('plugin: changedFiles names added, removed and changed files and ignores the engine\'s own', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-w2fix-'));
  try {
    const p = PC.installPlugin({ src: PC.modSourceDir(), dest: `${d}/plugin`, run: { role: 'orchestrator', wake_nonce: 'n' } });
    assert.deepStrictEqual(PC.changedFiles(p.dir, p.perFile), []);
    fs.writeFileSync(`${d}/plugin/tsconfig.json`, '{}');
    assert.deepStrictEqual(PC.changedFiles(p.dir, p.perFile), []);
    fs.appendFileSync(`${d}/plugin/hooks/wake/index.ts`, '//x\n');
    fs.writeFileSync(`${d}/plugin/extra.txt`, 'x');
    assert.deepStrictEqual(PC.changedFiles(p.dir, p.perFile), ['extra.txt', 'hooks/wake/index.ts']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('plugin: a file changed after spawn fails the run at finalize (ended_by, gate failed, exit 1, a text line)', T, async (t) => H.withRun(t, async (dir) => {
  const r = H.start(dir, { env: { FAKE_HOLD_MS: '1200', FAKE_TAMPER_PLUGIN: 'late' }, deps: real({ pluginCheckMs: 3600000 }) });
  const res = await r.done;
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /plugin copy changed after spawn \(hooks\/wake\/index\.ts\)/);
  const ia = res.json.orchestrator.interactive;
  assert.strictEqual(ia.gate.status, 'failed');
  assert.strictEqual(ia.plugin.unchanged, false);
  assert.deepStrictEqual(ia.plugin.changed_files, ['hooks/wake/index.ts']);
  assert.match(res.text, /plugin copy changed after spawn: hooks\/wake\/index\.ts/);
}));

test('plugin: a change while claude runs is a leak: claude is killed by its pid and the run fails', T, async (t) => H.withRun(t, async (dir) => {
  // FAKE_FALLBACK_EXIT_MS: if the live re-hash regresses and never kills, the stub exits by itself after 8 s, so the
  // test fails in seconds on the assertions below and leaves nothing behind. r.done is also raced against 20 s.
  const r = H.start(dir, { env: { FAKE_NEVER_EXIT: '1', FAKE_FALLBACK_EXIT_MS: '8000', FAKE_TAMPER_PLUGIN: 'early' }, deps: real({ pluginCheckMs: 100 }) });
  let timer;
  const res = await Promise.race([r.done, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 20000); })]);
  clearTimeout(timer);
  assert.ok(res, 'the run did not end within 20 s: the live re-hash never killed claude');
  const rec = r.record();
  assert.ok(Date.now() - rec.started_at < 7000, 'claude ran to its fallback exit: the live re-hash did not kill it');
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /plugin copy changed after spawn \(hooks\/wake\/index\.ts\)/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'failed');
  assert.ok(rec && !P.pidAlive(rec.pid), 'claude outlived the leak');
}));

test('plugin: the two paths Claude Code writes into the copy do not fail the run', T, async (t) => H.withRun(t, async (dir) => {
  const r = H.start(dir, { env: { FAKE_HOLD_MS: '1200', FAKE_TAMPER_PLUGIN: 'engine' }, deps: real({ pluginCheckMs: 100 }) });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.orchestrator.interactive.plugin.unchanged, true);
}));

// ---------------------------------------------------------------- the --plugin-dir regex (finding 7)

test('gate: a plugin directory whose path contains " is " parses (is-in-path)', () => {
  const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');
  const DIR = 'C:/Home/u/this is a dir/belay-run/r1/plugin';
  const iso = new Date().toISOString();
  const text = [
    `${iso} [DEBUG] Found 6 plugins (4 enabled, 2 disabled)`,
    `${iso} [DEBUG] --plugin-dir ${DIR} is one plugin: .claude-plugin at its top marks it`,
    `${iso} [DEBUG] Read hooks.json for plugin belay (enabled=true): ${DIR.split('/').join('\\')}\\hooks\\hooks.json`,
    `${iso} [DEBUG] Loaded 1 directory-loaded plugins`,
    `${iso} [DEBUG] Checking plugin belay: skillsPath=none, skillsPaths=0 paths`,
    `${iso} [DEBUG] Loaded plugins - Enabled: 4, Disabled: 2, Commands: 0, Agents: 0, Errors: 0`, '',
  ].join('\n');
  const r = checkDebugLog(text, { plugin: { name: 'belay', dir: DIR } });
  assert.strictEqual(r.checks.find((c) => c.name === 'belay_plugin').ok, true, JSON.stringify(r.checks.find((c) => c.name === 'belay_plugin')));
});

// ---------------------------------------------------------------- D6: the clearPluginCache line is not a plugin dir

const FIX = path.join(__dirname, 'fixtures', 'interactive');
const bp = (r) => r.checks.find((c) => c.name === 'belay_plugin');
const W1_DIR = 'C:/Home/dev/AppData/Local/Temp/belay-iow2/W1-muzd5jbs/orch/plugin';

test('D6: the real W1 debug log (with its clearPluginCache line) passes belay_plugin', () => {
  const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');
  const text = fs.readFileSync(path.join(FIX, 'debug-d6-w1-pass.log'), 'utf8');
  assert.match(text, /clearPluginCache: invalidating loadAllPlugins cache \(preAction: --plugin-dir inline plugins\)/);
  const r = checkDebugLog(text, { plugin: { name: 'belay', dir: W1_DIR } });
  assert.strictEqual(bp(r).ok, true, JSON.stringify(bp(r)));
});

test('D6: the real H5 debug log fails belay_plugin, naming the dummy plugin', () => {
  const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');
  const text = fs.readFileSync(path.join(FIX, 'debug-d6-h5-dummy.log'), 'utf8');
  const r = checkDebugLog(text, { plugin: { name: 'belay', dir: W1_DIR } });
  assert.strictEqual(bp(r).ok, false);
  assert.match(bp(r).detail, /dummy-plugin/);
  assert.ok(r.checks.some((c) => c.name === 'user_plugins_disabled' && !c.ok && /handrun-dummy/.test(c.detail)));
});

test('D6: the real final-smoke F-H5 log (clearPluginCache only, no load line) is not read as a second dir', () => {
  const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');
  const text = fs.readFileSync(path.join(FIX, 'debug-d6-final-h5.log'), 'utf8');
  const r = checkDebugLog(text, { plugin: { name: 'belay', dir: W1_DIR } });
  assert.doesNotMatch(bp(r).detail || '', /inline plugins/);
});

test('D6: a synthetic log with the clearPluginCache line and belay\'s load line passes', () => {
  const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');
  const iso = new Date().toISOString();
  const DIR = 'C:/x/orch/plugin';
  const text = [
    `${iso} [DEBUG] clearPluginCache: invalidating loadAllPlugins cache (preAction: --plugin-dir inline plugins)`,
    `${iso} [DEBUG] --plugin-dir ${DIR} is one plugin: .claude-plugin at its top marks it`,
    `${iso} [DEBUG] Read hooks.json for plugin belay (enabled=true): C:\\x\\orch\\plugin\\hooks\\hooks.json`,
    `${iso} [DEBUG] Loaded 1 directory-loaded plugins`, '',
  ].join('\n');
  assert.strictEqual(bp(checkDebugLog(text, { plugin: { name: 'belay', dir: DIR } })).ok, true);
});

// ---------------------------------------------------------------- an unreadable copy is its own fact

test('plugin: a copy that cannot be read at exit is "unreadable", gate unsettled, exit 1 (not "changed")', T, async (t) => H.withRun(t, async (dir) => {
  const r = H.start(dir, { env: { FAKE_HOLD_MS: '1000' }, deps: real({ pluginCheckMs: 3600000, pluginHash: () => { throw new Error('EBUSY'); } }) });
  const res = await r.done;
  assert.strictEqual(res.code, 1, res.text);
  assert.strictEqual(res.json.ended_by, 'plugin copy unreadable at exit');
  const ia = res.json.orchestrator.interactive;
  assert.strictEqual(ia.gate.status, 'unsettled');
  assert.strictEqual(ia.plugin.unreadable, true);
  assert.match(res.text, /plugin copy unreadable at exit/);
  assert.doesNotMatch(res.text, /changed after spawn/);
}));

test('plugin: a live check that throws is retried once; still unreadable is recorded, claude is not killed', T, async (t) => H.withRun(t, async (dir) => {
  let calls = 0;
  const r = H.start(dir, { env: { FAKE_HOLD_MS: '1500' }, deps: real({ pluginCheckMs: 100, pluginChangedFiles: () => { calls += 1; throw new Error('EBUSY'); } }) });
  const res = await r.done;
  const ia = res.json.orchestrator.interactive;
  assert.ok(ia.plugin.unreadable_live_checks >= 1, 'no unreadable live check was recorded');
  assert.strictEqual(calls, 2 * ia.plugin.unreadable_live_checks, 'each failed live check is retried once');
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.ended_by, 'claude exited (code 0)', 'a live unreadable check ended the run');
}));

test('plugin: a live check that throws once and then reads a change still kills claude', T, async (t) => H.withRun(t, async (dir) => {
  let calls = 0;
  const r = H.start(dir, { env: { FAKE_NEVER_EXIT: '1', FAKE_FALLBACK_EXIT_MS: '7500' }, deps: real({ pluginCheckMs: 4000, pluginChangedFiles: () => { calls += 1; if (calls === 1) throw new Error('EBUSY'); return ['hooks/wake/index.ts']; } }) });
  let timer;
  const res = await Promise.race([r.done, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 20000); })]);
  clearTimeout(timer);
  assert.ok(res, 'the run did not end within 20 s');
  assert.match(res.json.ended_by, /plugin copy changed after spawn \(hooks\/wake\/index\.ts\)/);
}));

// ---------------------------------------------------------------- the release drops only the pause's own park wakes

const net2 = require('node:net');
function lineClient(pipe) {
  const lines = [];
  const sock = net2.connect(pipe);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* torn */ } buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  return { wakes: () => lines.filter((l) => l.id), close: () => sock.destroy() };
}
const wrow = (id, extra = {}) => ({ id, run_id: 'r1', state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0, ...extra });
const PARK = (id) => ({ worker_id: id, paused_at: 1000, paused_by: 'operator:100' });
async function releaseScenario(script) {
  const rows = { v: [wrow('w1'), wrow('w2')] };
  const core = { worker: { list: async () => ({ workers: rows.v.map((r) => ({ ...r })) }) } };
  let held = true;
  const info = { id: 'r1:resume:1000', parks: [PARK('w1'), PARK('w2')], text: (n) => `belay: run resumed by operator:100: relaunched w1, w2; ${n} held event${n === 1 ? '' : 's'} follow.` };
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25, isHeld: () => held, onRelease: () => info });
  await pub.listening;
  const c = lineClient(pipe);
  try {
    await sleep(120);
    await script(rows, async () => { await sleep(150); });
    held = false;
    const end = Date.now() + 4000;
    while (!c.wakes().length && Date.now() < end) await sleep(20);
    await sleep(200);
    return c.wakes();
  } finally { c.close(); await pub.stop(); }
}
const park = (id, at = 1000, by = 'operator:100') => ({ state: 'paused', paused_at: at, paused_by: by, seq: 2 });

test('release: the pause\'s own park wakes are dropped, and the header counts exactly what follows (P0)', async () => {
  const got = await releaseScenario(async (rows, tick) => {
    rows.v = [wrow('w1', park('w1')), wrow('w2', park('w2'))]; await tick();
    rows.v = [wrow('w1', { turns: 1, seq: 3 }), wrow('w2', { turns: 1, seq: 3 })]; await tick();
  });
  assert.match(got[0].text, /^belay: run resumed by operator:100: relaunched w1, w2; \d+ held events? follows?\.$/);
  assert.strictEqual(got.filter((g) => /was paused by/.test(g.text)).length, 0);
  assert.strictEqual(Number(got[0].text.match(/(\d+) held event/)[1]), got.length - 1);
});

test('release: a real hand pause of a relaunched worker, held with the park wakes, is delivered (P2)', async () => {
  const got = await releaseScenario(async (rows, tick) => {
    rows.v = [wrow('w1', park('w1')), wrow('w2', park('w2'))]; await tick();
    rows.v = [wrow('w1', { turns: 1, seq: 3 }), wrow('w2', { turns: 1, seq: 3 })]; await tick();
    rows.v = [wrow('w1', { turns: 1, seq: 4, state: 'paused', paused_at: 2000, paused_by: 'operator:999' }), wrow('w2', { turns: 1, seq: 3 })]; await tick();
  });
  const paused = got.filter((g) => /was paused by/.test(g.text));
  assert.strictEqual(paused.length, 1, JSON.stringify(got));
  assert.match(paused[0].text, /worker w1 was paused by operator:999/);
  assert.strictEqual(Number(got[0].text.match(/(\d+) held event/)[1]), got.length - 1, 'the count must equal what follows');
});

test('release: the same identity pausing again later (a different paused_at) is kept too (P2b)', async () => {
  const got = await releaseScenario(async (rows, tick) => {
    rows.v = [wrow('w1', park('w1')), wrow('w2', park('w2'))]; await tick();
    rows.v = [wrow('w1', { turns: 1, seq: 3 }), wrow('w2', { turns: 1, seq: 3 })]; await tick();
    rows.v = [wrow('w1', { turns: 1, seq: 4, state: 'paused', paused_at: 2000, paused_by: 'operator:100' }), wrow('w2', { turns: 1, seq: 3 })]; await tick();
  });
  assert.strictEqual(got.filter((g) => /worker w1 was paused by/.test(g.text)).length, 1);
});

test('release: a death during the pause is kept (P1)', async () => {
  const got = await releaseScenario(async (rows, tick) => {
    rows.v = [wrow('w1', park('w1')), wrow('w2', park('w2'))]; await tick();
    rows.v = [wrow('w1', park('w1')), wrow('w2', { state: 'dead', pid_alive: false, seq: 3, exit_code: 1, exit_signal: null, death_established_by: 'pid check' })]; await tick();
  });
  assert.ok(got.some((g) => /worker w2 died/.test(g.text)), JSON.stringify(got));
  assert.strictEqual(Number(got[0].text.match(/(\d+) held event/)[1]), got.length - 1);
});
