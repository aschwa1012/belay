'use strict';
require('../helpers/tmp.cjs'); // points TEMP at a scratch dir of the tests: the first launch sweeps the base's belay folder, which must never be the real one
// worker-temp.test.cjs — a worker gets its own temp folder (ADR 0084 amendment 1): the environment names it, belay makes it at
// launch under the OS temp dir (never the data directory), removes it when the run's manager shuts down except for workers the
// shutdown left alone, and sweeps a crashed run's leftovers. Fake executables only.

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
if (!/^belay-(suite|test)-tmp-/.test(path.basename(os.tmpdir()))) throw new Error('worker-temp.test.cjs makes and sweeps folders under the OS temp dir: run it with --require ./tests/helpers/tmp.cjs (or through npm test), never against the real temp dir');
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wtemp-'));
const { deadPid } = require('../helpers/dead-pid.cjs');
const junction = (target, at) => fs.symlinkSync(target, at, 'junction');

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

test('the base is the OS temp dir, and %LOCALAPPDATA%\\Temp when that dir lies in the home folder outside AppData (an indexed place)', () => {
  const tmp = os.tmpdir();
  assert.strictEqual(WT.base({}, path.join(tmp, 'nohome'), 'win32'), tmp, 'a temp dir outside the home folder is kept');
  assert.strictEqual(WT.base({ LOCALAPPDATA: 'C:/home/x/AppData/Local' }, tmp, 'win32'), path.join('C:/home/x/AppData/Local', 'Temp'), 'a temp dir inside the home folder is refused');
  assert.strictEqual(WT.base({}, path.dirname(tmp), 'linux'), tmp, 'the rule is Windows only');
});

test('make creates <base>/belay/<run>/<worker> with an owner marker, keeps it across launches, and refuses a link or an odd id', () => {
  const root = sandbox();
  try {
    const dir = WT.make('run-1', 'w1', { root, dataDir: 'C:/data' });
    assert.strictEqual(norm(dir), norm(path.join(root, 'belay', 'run-1', 'w1')));
    assert.ok(fs.statSync(dir).isDirectory());
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'belay', 'run-1', WT.ownerFile(process.pid)), 'utf8'));
    assert.deepStrictEqual([marker.pid, marker.run_id, marker.data_dir], [process.pid, 'run-1', 'C:/data']);
    assert.ok(marker.created > 0 && marker.created <= Date.now(), 'the launcher\'s start time is recorded');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    assert.strictEqual(WT.make('run-1', 'w1', { root }), dir);
    assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'a second launch of the same worker keeps what its first left');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x:y', null, undefined]) assert.strictEqual(WT.make('run-1', bad, { root }), null, String(bad));
    assert.strictEqual(WT.make('../run', 'w1', { root }), null);
    assert.strictEqual(WT.make('..', 'w1', { root }), null);
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious.txt'), 'x');
    junction(target, path.join(root, 'belay', 'run-1', 'w2'));
    assert.strictEqual(WT.make('run-1', 'w2', { root }), null, 'a link in the worker place is not used');
    junction(target, path.join(root, 'belay', 'run-2'));
    assert.strictEqual(WT.make('run-2', 'w1', { root }), null, 'a link in the run place is not used');
    assert.ok(fs.existsSync(path.join(target, 'precious.txt')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the worker folder is under the OS temp base, not under a data directory or a .belay', () => {
  const dir = WT.make('run-loc', 'w1');
  try {
    assert.ok(dir);
    assert.ok(!norm(dir).includes('/.belay/'));
    assert.ok(norm(dir).startsWith(norm(WT.base())));
  } finally { WT.closeRun(new Map([['w1', { id: 'w1' }]]), 'run-loc', {}); }
});

test('closeRun removes the folders of the workers that stopped, counts the bytes, and leaves the folders of workers left parked, stale or running after a failed stop', () => {
  const root = sandbox();
  try {
    const ids = ['a', 'b', 'parked', 'stale', 'failed', 'nofolder'];
    const workers = new Map(ids.map((id) => [id, { id }]));
    for (const id of ids.filter((i) => i !== 'nofolder')) fs.writeFileSync(path.join(WT.make('run-c', id, { root }), 'f.bin'), Buffer.alloc(id === 'a' ? 1000 : 3));
    const res = WT.closeRun(workers, 'run-c', { stopped: ['a', 'b'], left_parked: ['parked'], left_stale: ['stale'], stop_failed: [{ worker_id: 'failed', pid: 1 }] }, { root });
    assert.strictEqual(res.stopped.length, 2, 'the shutdown result is returned with the block added');
    assert.deepStrictEqual({ removed: res.worker_temp.removed, bytes: res.worker_temp.bytes, failed: res.worker_temp.failed }, { removed: 2, bytes: 1003, failed: [] });
    assert.deepStrictEqual([...res.worker_temp.kept].sort(), ['failed', 'parked', 'stale']);
    for (const id of ['a', 'b']) assert.ok(!fs.existsSync(path.join(root, 'belay', 'run-c', id)), id);
    for (const id of ['parked', 'stale', 'failed']) assert.ok(fs.existsSync(path.join(root, 'belay', 'run-c', id, 'f.bin')), `${id} keeps its folder and its files`);
    assert.ok(fs.existsSync(path.join(root, 'belay', 'run-c')), 'the run folder stays while a worker may still use it');
    assert.match(WT.describe(res.worker_temp), /^temp removed=2 bytes=1003 kept=3 failed=0/);
    const res2 = WT.closeRun(workers, 'run-c', {}, { root }); // the last workers go: the run folder goes with them
    assert.strictEqual(res2.worker_temp.removed, 3);
    assert.ok(!fs.existsSync(path.join(root, 'belay', 'run-c')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('closeRun unlinks a junction at the folder and a junction nested in it, and never reaches what they point to', () => {
  const root = sandbox();
  try {
    const keep = path.join(root, 'precious');
    fs.mkdirSync(path.join(keep, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(keep, 'deep', 'file.txt'), 'x');
    const nested = WT.make('run-j', 'nest', { root });
    fs.mkdirSync(path.join(nested, 'sub'));
    junction(keep, path.join(nested, 'sub', 'node_modules'));
    junction(keep, path.join(nested, 'direct'));
    const top = WT.make('run-j', 'top', { root });
    fs.rmSync(top, { recursive: true });
    junction(keep, top);
    const res = WT.closeRun(new Map([['nest', { id: 'nest' }], ['top', { id: 'top' }]]), 'run-j', {}, { root });
    assert.deepStrictEqual(res.worker_temp.failed, []);
    assert.ok(!fs.existsSync(nested) && !fs.existsSync(top), 'both are gone');
    assert.ok(fs.existsSync(path.join(keep, 'deep', 'file.txt')), 'what the junctions pointed to is untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const DAY = 24 * 60 * 60 * 1000;
// A run folder with a worker folder and the given owner files: [{ pid, run_id?, ageMs }] (a string is written as is under the first pid).
function mkRun(root, run, owners) {
  const dir = path.join(root, 'belay', run);
  fs.mkdirSync(path.join(dir, 'w1', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'w1', 'sub', 'f.txt'), 'abc');
  for (const o of owners) {
    const p = path.join(dir, WT.ownerFile(o.pid));
    fs.writeFileSync(p, o.raw !== undefined ? o.raw : JSON.stringify({ pid: o.pid, created: 1, run_id: o.run_id || run, at: 1 }));
    const t = new Date(Date.now() - o.ageMs); fs.utimesSync(p, t, t);
  }
  return dir;
}

test('sweep removes only the run folders whose launchers are all gone and idle, matched by name and owner files, and never follows a link', () => {
  const root = sandbox();
  try {
    const dead = deadPid(); const dead2 = deadPid();
    const gone = mkRun(root, 'gone', [{ pid: dead, ageMs: 2 * DAY }, { pid: dead2, ageMs: 3 * DAY }]);
    const young = mkRun(root, 'young', [{ pid: dead, ageMs: 60 * 1000 }]);
    const oneYoung = mkRun(root, 'oneyoung', [{ pid: dead, ageMs: 2 * DAY }, { pid: dead2, ageMs: 60 * 1000 }]);
    const live = mkRun(root, 'live', [{ pid: process.pid, ageMs: 2 * DAY }]);
    const oneLive = mkRun(root, 'onelive', [{ pid: dead, ageMs: 2 * DAY }, { pid: process.pid, ageMs: 2 * DAY }]);
    const renamed = mkRun(root, 'renamed', [{ pid: dead, run_id: 'other', ageMs: 2 * DAY }]);
    const nomarker = mkRun(root, 'nomarker', []);
    const junky = mkRun(root, 'junky', [{ pid: dead, raw: 'not json', ageMs: 2 * DAY }]);
    const wrongname = mkRun(root, 'wrongname', [{ pid: dead, raw: JSON.stringify({ pid: dead + 1, run_id: 'wrongname' }), ageMs: 2 * DAY }]);
    const strange = mkRun(root, 'has space', [{ pid: dead, ageMs: 2 * DAY }]);
    const mine = mkRun(root, 'mine', [{ pid: dead, ageMs: 2 * DAY }]);
    const keep = path.join(root, 'precious');
    fs.mkdirSync(keep);
    fs.writeFileSync(path.join(keep, 'file.txt'), 'x');
    junction(keep, path.join(gone, 'w1', 'link'));
    junction(keep, path.join(root, 'belay', 'linkrun'));
    fs.writeFileSync(path.join(root, 'belay', 'afile'), 'x');
    const r = WT.sweep({ root, skipRun: 'mine' });
    assert.strictEqual(r.swept, 1);
    assert.deepStrictEqual(r.failed, []);
    assert.ok(!fs.existsSync(gone), 'every launcher dead and idle for a day: swept');
    for (const d of [young, oneYoung, live, oneLive, renamed, nomarker, junky, wrongname, strange, mine]) assert.ok(fs.existsSync(d), `${path.basename(d)} is left`);
    assert.ok(fs.existsSync(path.join(keep, 'file.txt')) && fs.existsSync(path.join(root, 'belay', 'linkrun')) && fs.existsSync(path.join(root, 'belay', 'afile')));
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'belay')).filter((n) => n.startsWith('.gone-')), [], 'no tombstone is left behind');
    assert.strictEqual(WT.sweep({ root: path.join(root, 'none') }).swept, 0, 'no belay folder is no error');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweep skips the run of the process that is launching, however idle, and make passes it', () => {
  const root = sandbox();
  try {
    const dead = deadPid();
    const parked = mkRun(root, 'parked-run', [{ pid: dead, ageMs: 5 * DAY }]);
    fs.writeFileSync(path.join(parked, 'w1', 'resume.txt'), 'x');
    assert.strictEqual(WT.sweep({ root, skipRun: 'parked-run' }).swept, 0);
    assert.ok(fs.existsSync(path.join(parked, 'w1', 'resume.txt')));
    WT.forgetSweep(); // the first launch of this process sweeps; it must skip the run it launches into
    const dir = WT.make('parked-run', 'w1', { root }); // resuming the parked worker five days later
    assert.ok(dir && fs.existsSync(path.join(dir, 'resume.txt')), 'its folder and files are there');
    assert.ok(fs.existsSync(path.join(parked, WT.ownerFile(process.pid))), 'and this adapter is now a launcher of the run');
    assert.strictEqual(WT.sweep({ root }).swept, 0, 'a live launcher keeps the run even for a later sweep');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a launcher that writes its owner file between a sweep\'s check and its rename stops the removal: the folder is renamed back whole', () => {
  const root = sandbox();
  const realRename = fs.renameSync;
  try {
    const dead = deadPid();
    const stale = mkRun(root, 'racy', [{ pid: dead, ageMs: 3 * DAY }]);
    fs.renameSync = function renameSync(from, to) {
      const out = realRename.apply(this, arguments);
      if (path.basename(String(to)).startsWith('.gone-racy-')) fs.writeFileSync(path.join(to, WT.ownerFile(process.pid)), JSON.stringify({ pid: process.pid, created: 1, run_id: 'racy', at: Date.now() })); // P2 arrives after the check, before the re-check
      return out;
    };
    const r = WT.sweep({ root });
    fs.renameSync = realRename;
    assert.strictEqual(r.swept, 0);
    assert.ok(fs.existsSync(path.join(stale, 'w1', 'sub', 'f.txt')), 'nothing was deleted');
    assert.ok(fs.existsSync(path.join(stale, WT.ownerFile(process.pid))), 'and the new launcher\'s file is in the restored folder');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'belay')).filter((n) => n.startsWith('.gone-')), []);
  } finally { fs.renameSync = realRename; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tombstone of the run being launched into is neither removed by the sweep nor lost: make takes it back whole', () => {
  const root = sandbox();
  try {
    const dead = deadPid();
    const tomb = mkRun(root, '.gone-resumed-run-cafebabe', []);
    fs.writeFileSync(path.join(tomb, WT.ownerFile(dead)), JSON.stringify({ pid: dead, created: 1, run_id: 'resumed-run', at: 1 }));
    const t = new Date(Date.now() - 3 * DAY); fs.utimesSync(path.join(tomb, WT.ownerFile(dead)), t, t);
    fs.writeFileSync(path.join(tomb, 'w1', 'parked.txt'), 'x');
    assert.strictEqual(WT.sweep({ root, skipRun: 'resumed-run' }).swept, 0, 'the tombstone of the launching run is skipped like its folder');
    assert.ok(fs.existsSync(path.join(tomb, 'w1', 'parked.txt')));
    WT.forgetSweep();
    const dir = WT.make('resumed-run', 'w1', { root });
    assert.ok(dir && fs.existsSync(path.join(dir, 'parked.txt')), 'the files of the parked worker are back in its folder');
    assert.ok(!fs.existsSync(tomb), 'the tombstone was renamed back, not left beside it');
    assert.ok(fs.existsSync(path.join(root, 'belay', 'resumed-run', WT.ownerFile(process.pid))));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tombstone left by a crashed sweep is judged by the same rule and removed when it is abandoned', () => {
  const root = sandbox();
  try {
    const dead = deadPid();
    const tomb = mkRun(root, '.gone-old-run-deadbeef', []);
    fs.writeFileSync(path.join(tomb, WT.ownerFile(dead)), JSON.stringify({ pid: dead, created: 1, run_id: 'old-run', at: 1 }));
    const t = new Date(Date.now() - 3 * DAY); fs.utimesSync(path.join(tomb, WT.ownerFile(dead)), t, t);
    assert.strictEqual(WT.sweep({ root }).swept, 1);
    assert.ok(!fs.existsSync(tomb));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('make survives a sweep that renames the run folder aside under it: the sequence is run once more', () => {
  const root = sandbox();
  const realWrite = fs.writeFileSync;
  try {
    let n = 0;
    fs.writeFileSync = function writeFileSync(p) {
      if (n++ === 0 && /\.owner-/.test(String(p))) { fs.rmSync(path.dirname(String(p)), { recursive: true, force: true }); const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
      return realWrite.apply(this, arguments);
    };
    const dir = WT.make('run-race', 'w1', { root });
    fs.writeFileSync = realWrite;
    assert.ok(dir && fs.statSync(dir).isDirectory(), 'the worker still gets its folder');
    assert.ok(fs.existsSync(path.join(root, 'belay', 'run-race', WT.ownerFile(process.pid))));
  } finally { fs.writeFileSync = realWrite; fs.rmSync(root, { recursive: true, force: true }); }
});

test('closeRun removes only this adapter\'s owner file while another adapter of the run is alive, and the run folder when none is', () => {
  const root = sandbox();
  try {
    const other = process.ppid; // alive for the length of the test
    WT.make('run-m', 'w1', { root });
    fs.writeFileSync(path.join(root, 'belay', 'run-m', WT.ownerFile(other)), JSON.stringify({ pid: other, created: 1, run_id: 'run-m', at: Date.now() }));
    WT.closeRun(new Map([['w1', { id: 'w1' }]]), 'run-m', {}, { root });
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'belay', 'run-m')), [WT.ownerFile(other)], 'the live adapter keeps its marker and the run folder');
    fs.rmSync(path.join(root, 'belay', 'run-m', WT.ownerFile(other)));
    WT.make('run-m', 'w2', { root });
    WT.closeRun(new Map([['w2', { id: 'w2' }]]), 'run-m', {}, { root });
    assert.ok(!fs.existsSync(path.join(root, 'belay', 'run-m')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the first message of a worker says where its temp is, without a path that could go stale', () => {
  assert.match(TB.PROCESS_LINE, /Your TEMP is a folder belay made for you/);
  assert.ok(('echo: one' + TB.PROCESS_LINE).length < 200, 'a turn row that echoes the first message stays under the 200-character list text bound');
  assert.ok(TB.PROCESS_LINE.endsWith('never in /tmp or C:\\tmp.'));
});

test('spawn: the worker process runs with TEMP, TMP and TMPDIR at belay/<run>/<worker> under the OS temp, and shutdown removes the folder and reports it', async () => {
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'wt'));
  const data = fwd(d); const out = path.join(d, 'temp-seen.json');
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-wtemp', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  process.env.FAKE_SPAWN_SCRIPT = ECHO; process.env.FAKE_TEMP_OUT = out;
  const dir = WT.dirFor('run-wtemp', 'w-temp');
  let res = null;
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'hi', worker_id: 'w-temp' });
    assert.equal(row.state, 'running');
    for (let i = 0; i < 400 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 25)); // the echo script is a grandchild: its file is the event
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const k of ['TEMP', 'TMP', 'TMPDIR']) assert.strictEqual(norm(seen[k]), norm(dir), k);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.ok(!norm(dir).startsWith(norm(data)), 'not under the data directory');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'x');
  } finally {
    delete process.env.FAKE_SPAWN_SCRIPT; delete process.env.FAKE_TEMP_OUT;
    res = await m.shutdown();
    cleanup(data);
  }
  assert.ok(!fs.existsSync(dir), 'the folder is gone once the run is shut down');
  assert.strictEqual(res.worker_temp.removed, 1);
  assert.strictEqual(res.worker_temp.bytes, 1);
  assert.ok(!fs.existsSync(WT.runDirOf('run-wtemp')), 'and the run folder with it');
});
