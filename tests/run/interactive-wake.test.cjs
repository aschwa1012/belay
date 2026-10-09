'use strict';
// interactive-wake.test.cjs — ADR 0037 amendment 5: the wake publisher (hold and release, replay, no input),
// the wake-stream client (heartbeat timeout, clean close), the mod's dedupe across a simulated reload (the
// plain-ES-module helper src/mod/hooks/wake/core.mjs), the gate admitting belay's own plugin and nothing
// else, the plugin hash ignoring Claude Code's own files, and the launcher end to end against the stub.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { startWakePublisher, wakePipeName } = require('../../src/run/wake-pipe.cjs');
const wakeStream = require('../../src/cli/cmd-wake-stream.cjs');
const PC = require('../../src/run/plugin-copy.cjs');
const { checkDebugLog } = require('../../src/run/interactive-surface.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wake-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const uniquePipe = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\belay-test-wake-${crypto.randomBytes(5).toString('hex')}`
  : path.join(os.tmpdir(), `belay-test-wake-${crypto.randomBytes(5).toString('hex')}.sock`));

// A client that records every line the pipe sends.
function client(pipe) {
  const lines = [];
  const sock = net.connect(pipe);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  return { lines, wakes: () => lines.filter((l) => l.id), sock, close: () => sock.destroy() };
}
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}
const row = (id, turns, seq, extra = {}) => ({ id, run_id: 'r1', state: 'running', turns, seq, pid_alive: true, mid_turn: 0, ...extra });
function fakeCore() {
  const s = { rows: [row('w1', 0, 1)] };
  return { s, worker: { list: async () => ({ workers: s.rows.map((r) => ({ ...r })) }) } };
}

test('publisher: wakes derived while held are queued and released in order when the hold ends; none before', async () => {
  const core = fakeCore();
  let held = true;
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25, isHeld: () => held });
  await pub.listening;
  const c = client(pipe);
  try {
    assert.ok(await until(() => c.lines.some((l) => l.hb)), 'a heartbeat on connect');
    await sleep(100); // baseline taken at turns 0
    core.s.rows = [row('w1', 1, 2)];
    await sleep(150);
    core.s.rows = [row('w1', 2, 3)];
    await sleep(150);
    assert.strictEqual(c.wakes().length, 0, 'held: nothing published');
    assert.ok(pub.stats().queued >= 2, JSON.stringify(pub.stats()));
    held = false;
    assert.ok(await until(() => c.wakes().length === 2), 'released');
    const w = c.wakes();
    assert.match(w[0].text, /finished turn 1\./);
    assert.match(w[1].text, /finished turn 2\./);
    assert.notStrictEqual(w[0].id, w[1].id);
    assert.ok(w[0].id.startsWith('r1:w1:turn_end:1:'));
  } finally { c.close(); await pub.stop(); }
});

test('publisher: a late client is replayed every wake; input is refused; stop closes the pipe', async () => {
  const core = fakeCore();
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25 });
  await pub.listening;
  await sleep(100);
  core.s.rows = [row('w1', 1, 2)];
  assert.ok(await until(() => pub.stats().published === 1));
  const late = client(pipe);
  try {
    assert.ok(await until(() => late.wakes().length === 1), 'replayed to a client that connected after');
    let closed = false;
    late.sock.on('close', () => { closed = true; });
    late.sock.write('{"cmd":"stop"}\n');
    assert.ok(await until(() => closed), 'a connection that sends anything is cut');
  } finally { late.close(); }
  const c2 = client(pipe);
  assert.ok(await until(() => c2.lines.length > 0));
  let ended = false;
  c2.sock.on('close', () => { ended = true; });
  await pub.stop();
  assert.ok(await until(() => ended), 'stop ends the connections');
});

test('wake-stream: prints the publisher\'s lines; exit 0 when the pipe closes', async () => {
  const core = fakeCore();
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r1', pipeName: pipe, pollMs: 25 });
  await pub.listening;
  const out = [];
  const p = wakeStream.run({ argv: ['--run', 'r1', '--nonce', 'n1'], dataDir: 'x', emit: (t) => out.push(t), wakeStreamDeps: { pipe } });
  await sleep(100);
  core.s.rows = [row('w1', 1, 2)];
  assert.ok(await until(() => out.join('').includes('"id"')));
  await pub.stop();
  const res = await p;
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.ended, 'pipe closed');
  assert.ok(out.every((l) => l.endsWith('\n')) && out.some((l) => JSON.parse(l).hb));
});

test('wake-stream: no line for the heartbeat timeout is exit 1; an unreachable pipe is exit 1; bad args are exit 2', async () => {
  const pipe = uniquePipe();
  const silent = net.createServer(() => {}); // accepts, never speaks
  await new Promise((r) => silent.listen(pipe, r));
  try {
    const t0 = Date.now();
    const res = await wakeStream.run({ argv: ['--run', 'r1', '--nonce', 'n1', '--heartbeat-timeout-ms', '300'], dataDir: 'x', emit: () => {}, wakeStreamDeps: { pipe } });
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.json.ended, 'no heartbeat');
    assert.match(res.text, /no line from .* for 300 ms/);
    assert.ok(Date.now() - t0 < 3000);
  } finally { silent.close(); }
  // a slow trickle that never goes 300 ms silent outlives the timeout: every line re-arms it
  const socks = [];
  const trickle = net.createServer((s) => { socks.push(s); const iv = setInterval(() => s.write('{"hb":1}\n'), 100); s.on('close', () => clearInterval(iv)); s.on('error', () => {}); });
  const pipe2 = uniquePipe();
  await new Promise((r) => trickle.listen(pipe2, r));
  try {
    let settled = false;
    const p = wakeStream.run({ argv: ['--run', 'r1', '--nonce', 'n1', '--heartbeat-timeout-ms', '300'], dataDir: 'x', emit: () => {}, wakeStreamDeps: { pipe: pipe2 } }).then((r) => { settled = true; return r; });
    await sleep(900);
    assert.strictEqual(settled, false, 'the stream ended on its own while lines kept arriving');
    socks.forEach((s) => s.destroy());
    assert.strictEqual((await p).code, 0);
  } finally { socks.forEach((s) => s.destroy()); trickle.close(); }
  const gone = await wakeStream.run({ argv: ['--run', 'r1', '--nonce', 'n1'], dataDir: 'x', emit: () => {}, wakeStreamDeps: { pipe: uniquePipe() } });
  assert.strictEqual(gone.code, 1);
  assert.strictEqual(gone.json.ended, 'error');
  assert.strictEqual((await wakeStream.run({ argv: [], dataDir: 'x' })).code, 2);
  assert.strictEqual(wakePipeName('/a/b', 'r1', 'n') === wakePipeName('/a/b', 'r2', 'n'), false);
  assert.strictEqual(wakePipeName('/a/b', 'r1', 'n1') === wakePipeName('/a/b', 'r1', 'n2'), false, 'the nonce is part of the name');
});

// ---------------------------------------------------------------- the mod's logic (core.mjs)

let modCore;
test('mod core: line parsing, the 226-minus-name cap, activation only for the orchestrator', async () => {
  modCore = await import(`file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`);
  const m = modCore;
  assert.deepStrictEqual(m.parseLine('{"id":"a:b","text":"hi"}'), { kind: 'wake', id: 'a:b', text: 'hi' });
  assert.deepStrictEqual(m.parseLine('{"hb":5}'), { kind: 'hb' });
  assert.strictEqual(m.parseLine('not json').kind, 'ignore');
  assert.strictEqual(m.parseLine('{"id":"x"}').kind, 'ignore');
  assert.strictEqual(m.maxTextBytes(), 221);
  const long = 'é'.repeat(200); // 400 bytes
  const capped = m.capText(long);
  assert.ok(m.byteLength(capped) <= 221 && m.byteLength(capped) >= 220, String(m.byteLength(capped)));
  assert.strictEqual(m.capText('short'), 'short');
  const cfg = { role: 'orchestrator', run_id: 'r1', data_dir: 'D', belay_cli: 'C', node: 'N', orchestrator_dir: 'O\\x', wake_nonce: 'NN' };
  assert.deepStrictEqual(m.streamArgv(m.activeConfig(JSON.stringify(cfg))), ['N', 'C', 'wake-stream', '--run', 'r1', '--nonce', 'NN', '--data', 'D']);
  assert.strictEqual(m.activeConfig(JSON.stringify({ ...cfg, role: 'watcher' })), null);
  assert.strictEqual(m.activeConfig('{}'), null);
  assert.strictEqual(m.activeConfig('garbage'), null);
  assert.strictEqual(m.deliveredPath(cfg), 'O/x/wakes-delivered.jsonl');
  const split = m.lineSplitter();
  assert.deepStrictEqual(split('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepStrictEqual(split(':2}\n'), ['{"b":2}']);
});

// What the mod does per line, driven through the real createDelivery (core.mjs) with the file as its only memory.
async function modRun(m, file, lines) {
  const submitted = [];
  const d = m.createDelivery({
    file, initial: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
    io: { write: async (f, c) => { fs.writeFileSync(f, c); }, submit: async (t) => { submitted.push(t); }, log: () => {} },
  });
  const ids = [];
  for (const line of lines) {
    const p = m.parseLine(line);
    if (m.decide(p, d.delivered) !== 'submit') continue;
    if ((await d.deliver(p.id, p.text)) === 'submitted') ids.push(p.id);
  }
  return ids;
}

test('mod dedupe: after a simulated reload (fresh state, same file) the replayed wakes are not submitted again', async () => {
  const d = tmp();
  try {
    const file = `${d}/wakes-delivered.jsonl`;
    const stream = ['{"hb":1}', '{"id":"r1:w1:turn_end:1:2","text":"one"}', '{"id":"r1:w1:turn_end:2:3","text":"two"}'];
    assert.deepStrictEqual(await modRun(modCore, file, stream), ['r1:w1:turn_end:1:2', 'r1:w1:turn_end:2:3']);
    // reload: the module's variables start over; the publisher replays everything, plus one new wake
    assert.deepStrictEqual(await modRun(modCore, file, [...stream, '{"id":"r1:w1:turn_end:3:4","text":"three"}']), ['r1:w1:turn_end:3:4']);
    assert.deepStrictEqual(await modRun(modCore, file, stream), []);
    fs.appendFileSync(file, '{"id":"torn'); // a torn last line does not poison the rest
    assert.deepStrictEqual(await modRun(modCore, file, ['{"id":"r1:w1:turn_end:9:9","text":"x"}']), ['r1:w1:turn_end:9:9']);
  } finally { rm(d); }
});

// ---------------------------------------------------------------- the gate admits belay's plugin and no other

const DIR = 'C:/Home/u/AppData/Local/Temp/belay-run/r1/plugin';
const iso = () => new Date().toISOString();
function debugText({ dirLine = DIR, hooksPath = `${DIR.split('/').join('\\')}\\hooks\\hooks.json`, hooksName = 'belay', extra = [] } = {}) {
  return [
    `${iso()} [DEBUG] Loaded 0 unique skills (0 unconditional)`,
    `${iso()} [DEBUG] Found 6 plugins (4 enabled, 2 disabled)`,
    ...(dirLine ? [`${iso()} [DEBUG] --plugin-dir ${dirLine} is one plugin: .claude-plugin at its top marks it`] : []),
    ...(hooksPath ? [`${iso()} [DEBUG] Read hooks.json for plugin ${hooksName} (enabled=true): ${hooksPath}`] : []),
    `${iso()} [DEBUG] Loaded 1 directory-loaded plugins`,
    `${iso()} [DEBUG] Checking plugin ${hooksName}: skillsPath=none, skillsPaths=0 paths`,
    `${iso()} [DEBUG] No CLAUDE.md/rules files found`,
    `${iso()} [DEBUG] Loaded plugins - Enabled: 4, Disabled: 2, Commands: 0, Agents: 0, Errors: 0`,
    `${iso()} [DEBUG] cc_version=2.1.293.d9e;`,
    `${iso()} [DEBUG] MCP server "belay": Successfully connected (transport: stdio) in 9ms`,
    ...extra, '',
  ].join('\n');
}
const REQ = { plugin: { name: 'belay', dir: DIR } };
const failed = (r) => r.checks.filter((c) => c.ok === false).map((c) => c.name);

test('gate: belay\'s plugin, by name and path, is admitted; the same log without it declared fails', () => {
  const r = checkDebugLog(debugText(), REQ);
  assert.strictEqual(r.ok, true, JSON.stringify(failed(r)));
  assert.strictEqual(r.checks.find((c) => c.name === 'belay_plugin').ok, true);
  assert.deepStrictEqual(r.facts.plugin, { name: 'belay', dir: DIR });
  const none = checkDebugLog(debugText(), {}); // no plugin requested: the same lines are a leak
  assert.strictEqual(none.ok, false);
  assert.ok(failed(none).includes('user_plugins_disabled'));
});

test('gate: a second plugin, another path, another --plugin-dir, or a missing plugin all fail', () => {
  // each of the two lines a second plugin leaves is enough on its own
  for (const line of [`Read hooks.json for plugin intruder (enabled=true): C:\\x\\hooks\\hooks.json`, 'Checking plugin intruder: skillsPath=none']) {
    const second = checkDebugLog(debugText({ extra: [`${iso()} [DEBUG] ${line}`] }), REQ);
    assert.strictEqual(second.ok, false, line);
    assert.match(second.checks.find((c) => c.name === 'user_plugins_disabled').detail, /intruder/);
  }
  const otherDir = checkDebugLog(debugText({ extra: [`${iso()} [DEBUG] --plugin-dir C:/elsewhere/mod is one plugin: x`] }), REQ);
  assert.strictEqual(otherDir.ok, false);
  assert.match(otherDir.checks.find((c) => c.name === 'belay_plugin').detail, /elsewhere/);
  const samename = checkDebugLog(debugText({ hooksPath: 'C:\\somewhere\\else\\hooks\\hooks.json' }), REQ);
  assert.strictEqual(samename.ok, false);
  assert.ok(failed(samename).includes('belay_plugin') || failed(samename).includes('user_plugins_disabled'));
  const missing = checkDebugLog(debugText({ dirLine: null, hooksPath: null, hooksName: 'cc-plugin-diff' }), REQ);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.checks.find((c) => c.name === 'belay_plugin').missing, true);
  const twoLoaded = checkDebugLog(debugText().replace('Loaded 1 directory-loaded', 'Loaded 2 directory-loaded'), REQ);
  assert.ok(failed(twoLoaded).includes('belay_plugin'));
  const agents = checkDebugLog(debugText().replace('Agents: 0', 'Agents: 1'), REQ);
  assert.ok(failed(agents).includes('plugin_agents'), 'a plugin agent still fails the gate');
  const skills = checkDebugLog(debugText().replace('Loaded 0 unique skills', 'Loaded 1 unique skills'), REQ);
  assert.ok(failed(skills).includes('skills'), 'a skill still fails the gate');
});

// ---------------------------------------------------------------- the copy and its hash

test('plugin hash: Claude Code\'s own types and tsconfig do not change it; any other file, belay-run.json included, does', () => {
  const d = tmp();
  try {
    const run = { role: 'orchestrator', run_id: 'r1', data_dir: 'D', belay_cli: 'C', node: 'N', orchestrator_dir: 'O', wake_nonce: 'NN' };
    const p = PC.installPlugin({ src: PC.modSourceDir(), dest: `${d}/plugin`, run });
    assert.strictEqual(p.name, 'belay');
    assert.ok(p.files > 5);
    assert.ok(!fs.existsSync(`${d}/plugin/tests`), 'tests are not copied');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${d}/plugin/belay-run.json`, 'utf8')), run);
    assert.strictEqual(PC.hashPlugin(p.dir).hash, p.hash);
    fs.mkdirSync(`${d}/plugin/.claude-plugin/types/claude-code`, { recursive: true });
    fs.writeFileSync(`${d}/plugin/.claude-plugin/types/claude-code/index.d.ts`, 'declare const x: 1');
    fs.writeFileSync(`${d}/plugin/.claude-plugin/types/.gitignore`, '*');
    fs.writeFileSync(`${d}/plugin/tsconfig.json`, '{}');
    assert.strictEqual(PC.hashPlugin(p.dir).hash, p.hash, 'the engine\'s own files are excluded by name');
    fs.writeFileSync(`${d}/plugin/belay-run.json`, JSON.stringify({ ...run, run_id: 'r2' }));
    assert.notStrictEqual(PC.hashPlugin(p.dir).hash, p.hash, 'belay-run.json is covered');
    fs.writeFileSync(`${d}/plugin/belay-run.json`, JSON.stringify(run, null, 2) + '\n');
    fs.appendFileSync(`${d}/plugin/hooks/wake/index.ts`, '// tamper\n');
    assert.notStrictEqual(PC.hashPlugin(p.dir).hash, p.hash, 'a module is covered');
  } finally { rm(d); }
});

// ---------------------------------------------------------------- the launcher, end to end against the stub

test('launcher: the stub gets --plugin-dir, the real gate admits the plugin, the receipt names its path and hash', async (t) => {
  const H = require('../cli/run-interactive-helpers.cjs');
  const L = require('../../src/run/launch.cjs');
  const realDeps = () => ({ argv: L.orchestratorInteractiveArgv, createGate: (o) => require('../../src/run/interactive-surface.cjs').createInteractiveGate(o) });
  await H.withRun(t, async (dir) => {
    const r = H.start(dir, { deps: realDeps(), env: { FAKE_HOLD_MS: '1500' } });
    const res = await r.done;
    const rec = r.record();
    const pd = rec.argv[rec.argv.indexOf('--plugin-dir') + 1];
    assert.strictEqual(pd, `${r.orchestratorDir}/plugin`);
    const ia = res.json.orchestrator.interactive;
    assert.strictEqual(ia.plugin.path, pd);
    assert.strictEqual(ia.plugin.hash_at_spawn, PC.hashPlugin(pd).hash);
    assert.strictEqual(ia.plugin.unchanged, true);
    assert.strictEqual(ia.gate.debug.checks.find((c) => c.name === 'belay_plugin').ok, true, JSON.stringify(ia.gate.debug));
    assert.ok(ia.wake === null || typeof ia.wake.polls === 'number');
  });
  await H.withRun(t, async (dir) => {
    const r = H.start(dir, { deps: realDeps(), env: { FAKE_HOLD_MS: '1500', FAKE_OTHER_PLUGIN: '1' } });
    const res = await r.done;
    assert.strictEqual(res.code, 1);
    assert.match(res.json.ended_by, /surface gate failed \(debug\): (belay_plugin|user_plugins_disabled)/);
  });
});
