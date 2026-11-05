'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// worker-temp.test.cjs — a worker gets its own temp folder (ADR 0084 amendment 1): the environment names it, belay makes it at
// launch and removes it when the run's manager shuts down, and the first message says so. Fake executables only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/run/launch.cjs');
const WT = require('../../src/run/worker-temp.cjs');
const TB = require('../../src/run/task-body.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const ECHO = path.join(__dirname, 'fakes', 'echo-temp.cjs');
const fwd = (p) => String(p).replace(/\\/g, '/');
const norm = (p) => fwd(path.resolve(p)).toLowerCase();

test('buildEnv replaces every spelling of TEMP, TMP and TMPDIR with the worker folder, and leaves them alone without one', () => {
  const base = { PATH: 'C:/bin', Temp: 'C:/op/tmp', TMP: 'C:/op/tmp', tmpdir: 'C:/op/tmp', HOME: 'C:/h' };
  const env = L.buildEnv(base, { substrate: 'claude-code', workerId: 'w1', tempDir: 'C:/data/workers/w1/tmp' });
  assert.deepStrictEqual([env.TEMP, env.TMP, env.TMPDIR], ['C:/data/workers/w1/tmp', 'C:/data/workers/w1/tmp', 'C:/data/workers/w1/tmp']);
  assert.deepStrictEqual(Object.keys(env).filter((k) => /^(?:temp|tmp|tmpdir)$/i.test(k)).sort(), ['TEMP', 'TMP', 'TMPDIR'], 'no second spelling is left');
  for (const substrate of ['claude-code', 'codex']) assert.strictEqual(L.buildEnv(base, { substrate, tempDir: 'D:/x' }).TMPDIR, 'D:/x');
  const plain = L.buildEnv(base, { substrate: 'claude-code', workerId: 'w1' });
  assert.strictEqual(plain.TMP, 'C:/op/tmp');
  assert.strictEqual(plain.Temp, 'C:/op/tmp');
  assert.strictEqual(L.buildEnv(base, { substrate: 'claude-code', tempDir: '' }).TMP, 'C:/op/tmp', 'an empty name sets nothing');
});

test('make creates the folder under the worker directory, is idempotent, and refuses a link or a bad directory', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wtemp-'));
  try {
    const w = path.join(d, 'w1');
    fs.mkdirSync(w);
    const dir = WT.make(w);
    assert.strictEqual(norm(dir), norm(path.join(w, 'tmp')));
    assert.ok(fs.statSync(dir).isDirectory());
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    assert.strictEqual(WT.make(w), dir);
    assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'a second launch of the same worker keeps what its first left');
    for (const bad of [null, undefined, '', 5]) assert.strictEqual(WT.make(bad), null);
    const w2 = path.join(d, 'w2');
    fs.mkdirSync(w2);
    const target = path.join(d, 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious.txt'), 'x');
    fs.symlinkSync(target, path.join(w2, 'tmp'), 'junction');
    assert.strictEqual(WT.make(w2), null, 'a link in the folder place is not used');
    const r = WT.removeAll(new Map([['w2', { id: 'w2', dir: w2 }]]));
    assert.strictEqual(r.removed, 1);
    assert.ok(fs.existsSync(path.join(target, 'precious.txt')), 'removing a link never reaches what it points to');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('removeAll removes each worker folder with its contents, counts the bytes, and skips a worker that has none', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wtemp-'));
  try {
    const workers = new Map();
    for (const id of ['a', 'b', 'c']) { fs.mkdirSync(path.join(d, id)); workers.set(id, { id, dir: path.join(d, id) }); }
    const a = WT.make(path.join(d, 'a')); const b = WT.make(path.join(d, 'b'));
    fs.mkdirSync(path.join(a, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(a, 'sub', 'deep', 'f.bin'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(b, 'g.txt'), 'abc');
    const r = WT.removeAll(workers);
    assert.deepStrictEqual({ removed: r.removed, bytes: r.bytes, failed: r.failed }, { removed: 2, bytes: 1003, failed: [] });
    for (const id of ['a', 'b', 'c']) assert.ok(!fs.existsSync(path.join(d, id, 'tmp')), id);
    assert.ok(fs.existsSync(path.join(d, 'a')), 'the worker directory itself stays: it holds the transcript');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the first message of a worker says where its temp is, without a path that could go stale', () => {
  assert.match(TB.PROCESS_LINE, /Your TEMP, TMP and TMPDIR name a folder belay made for you and removes when the run ends/);
  assert.ok(TB.PROCESS_LINE.endsWith('never in /tmp or C:\\tmp.'));
});

test('spawn: the worker process runs with TEMP, TMP and TMPDIR at <worker dir>/tmp, and shutdown removes the folder', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wtemp-run-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const data = fwd(d); const out = path.join(d, 'temp-seen.json');
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-wtemp', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  process.env.FAKE_SPAWN_SCRIPT = ECHO; process.env.FAKE_TEMP_OUT = out;
  let dir = null;
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'hi', worker_id: 'w-temp' });
    assert.equal(row.state, 'running');
    dir = path.join(L.workerDir(data, 'w-temp'), 'tmp');
    for (let i = 0; i < 400 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 25)); // the echo script is a grandchild: its file is the event
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const k of ['TEMP', 'TMP', 'TMPDIR']) assert.strictEqual(norm(seen[k]), norm(dir), k);
    assert.ok(fs.statSync(dir).isDirectory());
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'x');
  } finally {
    delete process.env.FAKE_SPAWN_SCRIPT; delete process.env.FAKE_TEMP_OUT;
    await m.shutdown();
    if (dir) assert.ok(!fs.existsSync(dir), 'the folder is gone once the run is shut down');
    cleanup(data);
  }
});
