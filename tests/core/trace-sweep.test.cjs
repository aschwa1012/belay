'use strict';
// trace-sweep.test.cjs — the sweep of belay-trace files left by a process that died mid-git removes only a file belay's runTraced
// wrote whose writer is gone, and keeps everything else. Seams: the directory, the pid check, the clock, the cap and unlink.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { sandbox, cleanup } = require('./helpers.cjs');
const { deadPid, FLOOR } = require('../helpers/dead-pid.cjs');
const S = require('../../src/core/trace-sweep.cjs');
const H = require('../../src/core/git-hooks.cjs');

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EVENT = '{"event":"version","sid":"x"}\n';
const NOW = Date.now();
const OLD = new Date(NOW - S.MIN_AGE_MS - 60 * 1000);
let dir, n = 0;

before(() => { dir = sandbox(); });
after(() => cleanup(dir));

const fresh = () => { const d = path.join(dir, `d${n++}`); fs.mkdirSync(d); return d; };
const name = (pid, uuid = UUID) => `belay-trace-${pid}-${uuid}.json`;
function put(d, file, content = EVENT, mtime = OLD) {
  const f = path.join(d, file);
  fs.writeFileSync(f, content);
  if (mtime) fs.utimesSync(f, mtime, mtime);
  return f;
}
const deadOnly = pid => pid >= FLOOR; // the never-issued pids of deadPid()
const run = (d, o = {}) => S.sweep({ dir: d, gone: deadOnly, now: NOW, ...o });
const uuidN = i => `${i}f8fad5b-d9cb-469f-a165-70867728950e`;

test('a well-formed old trace file whose pid is gone is removed', async () => {
  const d = fresh(); const f = put(d, name(deadPid()));
  assert.deepStrictEqual(await run(d), [path.basename(f)]);
  assert.ok(!fs.existsSync(f));
});

test('an empty trace file (git died before writing) is removed when every other guard holds', async () => {
  const d = fresh(); const f = put(d, name(deadPid()), '');
  assert.deepStrictEqual(await run(d), [path.basename(f)]);
});

test('the writer\'s own name matches the pattern the sweep uses', () => {
  const f = S.traceFileName(process.pid, UUID);
  assert.match(f, S.TRACE_NAME);
  assert.strictEqual(f, name(process.pid));
});

test('a live pid keeps the file: this process, and a live child that is not the writer (a reused pid)', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const d = fresh();
    const mine = put(d, name(process.pid));
    const other = put(d, name(child.pid, uuidN(1)));
    assert.deepStrictEqual(await S.sweep({ dir: d, now: NOW }), []); // the real liveness check, not the seam
    assert.ok(fs.existsSync(mine) && fs.existsSync(other));
    // even when the check calls every pid gone, this process's own file stays
    assert.deepStrictEqual(await S.sweep({ dir: d, now: NOW, gone: () => true }), [path.basename(other)]);
    assert.ok(fs.existsSync(mine));
  } finally { child.kill(); }
});

test('an undecidable pid keeps the file (only ESRCH proves a pid gone)', async () => {
  const d = fresh(); const f = put(d, name(deadPid()));
  assert.deepStrictEqual(await S.sweep({ dir: d, now: NOW, gone: () => false }), []);
  assert.ok(fs.existsSync(f));
  fs.rmSync(f);
  const z = put(d, name(0, uuidN(2)));
  assert.deepStrictEqual(await S.sweep({ dir: d, now: NOW, gone: S.pidGone }), []);
  assert.ok(fs.existsSync(z));
});

test('a file under the age floor is kept', async () => {
  const d = fresh(); const f = put(d, name(deadPid()), EVENT, new Date(NOW - S.MIN_AGE_MS + 5000));
  assert.deepStrictEqual(await run(d), []);
  assert.ok(fs.existsSync(f));
});

test('names that are not exactly the writer\'s are kept', async () => {
  const d = fresh(); const pid = deadPid();
  const names = [
    name(pid, UUID.toUpperCase()), name(pid, UUID.slice(0, -1)), name(pid, UUID + '0'),
    name(pid) + '.bak', 'x' + name(pid), `belay-trace-${UUID}.json`, `belay-trace-${pid}-${UUID}.JSON`,
    `belay-trace-a${pid}-${UUID}.json`, `belay-trace--${pid}-${UUID}.json`, name(pid).replace('belay-trace', 'Belay-trace'),
  ];
  const files = names.map(x => put(d, x));
  assert.deepStrictEqual(await run(d), []);
  for (const f of files) assert.ok(fs.existsSync(f), f);
});

test('a directory with a matching name is kept, with what is inside it', async () => {
  const d = fresh(); const sub = path.join(d, name(deadPid()));
  fs.mkdirSync(sub); const inner = path.join(sub, 'keep.txt'); fs.writeFileSync(inner, 'x');
  fs.utimesSync(sub, OLD, OLD);
  assert.deepStrictEqual(await run(d), []);
  assert.ok(fs.existsSync(inner));
});

test('a junction or symlink with a matching name is kept and its target survives', async () => {
  const d = fresh(); const target = path.join(d, 'target'); fs.mkdirSync(target);
  const inner = path.join(target, 'keep.txt'); fs.writeFileSync(inner, 'x');
  const link = path.join(d, name(deadPid()));
  fs.symlinkSync(target, link, 'junction');
  const tfile = path.join(d, 'target.json'); fs.writeFileSync(tfile, EVENT);
  let flink = null;
  try { flink = path.join(d, name(deadPid())); fs.symlinkSync(tfile, flink, 'file'); } catch { flink = null; } // needs a privilege on Windows
  assert.deepStrictEqual(await run(d, { now: NOW + 3600 * 1000 }), []);
  assert.ok(fs.existsSync(inner) && fs.existsSync(tfile));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  if (flink) assert.ok(fs.lstatSync(flink).isSymbolicLink());
});

test('a matching name whose content is not a trace2 event is kept', async () => {
  const d = fresh(); const pid = deadPid();
  const f = put(d, name(pid), 'precious user data\n');
  const g = put(d, name(pid, uuidN(3)), ' {"event":"x"}\n');
  assert.deepStrictEqual(await run(d), []);
  assert.ok(fs.existsSync(f) && fs.existsSync(g));
});

test('a file in a subdirectory is never touched: the sweep does not recurse', async () => {
  const d = fresh(); const sub = path.join(d, 'sub'); fs.mkdirSync(sub);
  const f = put(sub, name(deadPid()));
  assert.deepStrictEqual(await run(d), []);
  assert.ok(fs.existsSync(f));
});

test('the cap holds: at most `cap` matching entries are examined', async () => {
  const d = fresh(); const files = [];
  for (let i = 0; i < 7; i++) files.push(put(d, name(deadPid(), uuidN(i))));
  put(d, 'unrelated.txt', 'x');
  assert.strictEqual((await run(d, { cap: 3 })).length, 3);
  assert.strictEqual(files.filter(f => fs.existsSync(f)).length, 4);
  assert.ok(S.CAP > 0 && S.CAP <= 100);
});

test('a failing unlink on one file does not stop the others', async () => {
  const d = fresh();
  for (let i = 0; i < 3; i++) put(d, name(deadPid(), uuidN(i)));
  const seen = [];
  const unlink = async f => { seen.push(f); if (seen.length === 1) throw new Error('EBUSY'); fs.unlinkSync(f); };
  const removed = await run(d, { unlink });
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(removed.length, 2);
});

test('a missing directory and a throwing pid check do not throw', async () => {
  assert.deepStrictEqual(await S.sweep({ dir: path.join(dir, 'nope') }), []);
  const d = fresh(); const f = put(d, name(deadPid()));
  assert.deepStrictEqual(await run(d, { gone: () => { throw new Error('boom'); } }), []);
  assert.ok(fs.existsSync(f));
});

test('the sweep runs once per process', async () => {
  S.resetForTests();
  const d = fresh(); const f = put(d, name(deadPid()));
  const first = S.sweepOnce({ dir: d, gone: deadOnly, now: NOW });
  assert.ok(first && typeof first.then === 'function');
  await first;
  assert.ok(!fs.existsSync(f));
  const g = put(d, name(deadPid(), uuidN(6)));
  assert.strictEqual(S.sweepOnce({ dir: d, gone: deadOnly, now: NOW }), null);
  assert.ok(fs.existsSync(g));
  S.resetForTests();
});

test('runTraced still returns its result when the sweep throws, and starts the sweep after the git run', async () => {
  const repo = fresh();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  S.resetForTests();
  const real = S.sweepOnce;
  let calls = 0;
  S.sweepOnce = () => { calls++; throw new Error('sweep exploded'); };
  try {
    const r = await H.runTraced(repo, ['status', '--short']);
    assert.strictEqual(r.exit_code, 0);
    assert.ok(Array.isArray(r.hooks));
    assert.strictEqual(calls, 1);
  } finally { S.sweepOnce = real; S.resetForTests(); }
});
