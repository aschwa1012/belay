'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// The fake orchestrator's delayed adapter kill (fakes/fake-orch-adapter.cjs) used to send SIGKILL to a bare pid 350 ms or more after
// its own exit, with no handle and no creation-time check. If the adapter had already gone, Windows could give that pid to an unrelated
// process, such as a test file running beside it, and the kill ended that process silently. It now goes through delayed-kill.cjs,
// which signals only an exact { pid, created } match in one snapshot taken just before the signal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { killIfSame } = require('./fakes/delayed-kill.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const G = require('../helpers/proc-gone.cjs');
const { crash } = require('../crash.cjs');

const PID = 4242, CREATED = 1730000000123;
const spy = () => { const calls = []; const f = (pid) => { calls.push(pid); }; f.calls = calls; return f; };
const snapOf = (entries) => async () => new Map(entries);

test('delayed kill: an exact pid and creation-time match is signalled once', async () => {
  const signal = spy();
  const r = await killIfSame({ pid: PID, created: CREATED, snapshot: snapOf([[PID, { created: CREATED, ppid: 1, image: 'node.exe' }]]), signal });
  assert.deepStrictEqual(signal.calls, [PID]);
  assert.strictEqual(r.outcome, 'killed');
});

test('delayed kill: a pid another process now holds (another creation time) is not signalled', async () => {
  const signal = spy();
  const r = await killIfSame({ pid: PID, created: CREATED, snapshot: snapOf([[PID, { created: CREATED + 5000, ppid: 1, image: 'node.exe' }]]), signal });
  assert.deepStrictEqual(signal.calls, []);
  assert.strictEqual(r.outcome, 'mismatch');
});

test('delayed kill: a pid nothing holds is not signalled', async () => {
  const signal = spy();
  const r = await killIfSame({ pid: PID, created: CREATED, snapshot: snapOf([]), signal });
  assert.deepStrictEqual(signal.calls, []);
  assert.strictEqual(r.outcome, 'gone');
});

test('delayed kill: an unreadable snapshot or a missing creation time is not signalled', async () => {
  const signal = spy();
  let reads = 0;
  assert.strictEqual((await killIfSame({ pid: PID, created: CREATED, snapshot: async () => { reads += 1; return null; }, signal })).outcome, 'unverifiable');
  assert.strictEqual((await killIfSame({ pid: PID, created: null, snapshot: async () => { reads += 1; return new Map([[PID, { created: CREATED }]]); }, signal })).outcome, 'unverifiable');
  assert.deepStrictEqual(signal.calls, []);
  assert.strictEqual(reads, 1, 'with no creation time the snapshot is not even read');
});

test('delayed kill: the fake orchestrator ends its adapter only through the identity-checked kill', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fakes', 'fake-orch-adapter.cjs'), 'utf8');
  assert.doesNotMatch(src, /process\.kill\(/, 'the fake signals no pid itself');
  assert.match(src, /delayed-kill\.cjs/, 'it starts the delayed kill');
});

test('delayed kill, real processes: a live process with its own creation time is ended; the wrong creation time leaves it running', async () => {
  const kids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true }));
  try {
    await Promise.all(kids.map((k) => new Promise((r) => k.once('spawn', r))));
    const ids = await Promise.all(kids.map((k) => G.identify(k.pid)));
    const wrong = await killIfSame({ pid: ids[0].pid, created: ids[0].created - 1 });
    assert.strictEqual(wrong.outcome, 'mismatch');
    assert.ok(ID.handleLive(kids[0]), 'the process the wrong identity named is untouched');
    const exited = new Promise((r) => kids[1].once('exit', r));
    const right = await killIfSame({ pid: ids[1].pid, created: ids[1].created });
    assert.strictEqual(right.outcome, 'killed');
    await exited;
  } finally { for (const k of kids) crash(k); }
});
