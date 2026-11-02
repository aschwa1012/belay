'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
process.env.BELAY_TEST_MODE = '1';
// survivors.test.cjs — the run-close e2e's final sweep checks survival by {pid, created}. A real survivor
// (the pid held by the process the row recorded) is reported with its image and creation time; a reused pid
// (held by a process created at another time) is not a survivor. No load: one idle child, ended by handle.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const ID = require('../../src/core/proc-identity.cjs');
const { survivors, describe, dropped } = require('./survivors.cjs');
const crash = require('../crash.cjs');

const snapOf = (entries) => () => new Map(entries);

test('survivors: a pid held by another creation time is reused, not a survivor; the same time is', () => {
  const alive = () => true;
  const s = survivors([4242], new Map([[4242, 1000]]), { alive, snapshot: snapOf([[4242, { ppid: 1, created: 5000, image: 'other.exe' }]]) });
  assert.deepStrictEqual(s.survivors, []);
  assert.strictEqual(s.reused.length, 1);
  assert.strictEqual(s.reused[0].image, 'other.exe');
  const t = survivors([4242], new Map([[4242, 1000]]), { alive, snapshot: snapOf([[4242, { ppid: 1, created: 1000, image: 'node.exe' }]]) });
  assert.strictEqual(t.survivors.length, 1);
  assert.deepStrictEqual(t.reused, []);
  assert.match(describe(t.survivors), /pid 4242 image node\.exe created 1000 \(row recorded 1000\)/);
});

test('survivors: a holder whose creation time cannot be read is a survivor, not a reused pid; dropped pids are reported', () => {
  const alive = () => true;
  const a = survivors([5], new Map([[5, 1000]]), { alive, snapshot: snapOf([[5, { ppid: 1, created: null, image: 'x.exe' }]]) });
  assert.strictEqual(a.survivors.length, 1);
  assert.deepStrictEqual(a.reused, []);
  const b = survivors([5, 6], new Map([[5, 1], [6, 2]]), { alive, snapshot: snapOf([[5, { ppid: 1, created: 9, image: 'y.exe' }]]) });
  const text = dropped(b);
  assert.ok(text.includes("dropped as reused: [pid 5 image y.exe created 9 (row recorded 1)]") && text.includes("not listed: [pid 6") && text.includes("[not listed]"), text);
});

test('survivors: a pid with no recorded creation time keeps the bare check; an unreadable snapshot or a pid no longer listed', () => {
  const alive = () => true;
  const a = survivors([7], new Map(), { alive, snapshot: snapOf([[7, { ppid: 1, created: 9, image: 'x.exe' }]]) });
  assert.strictEqual(a.survivors.length, 1);
  const b = survivors([7], new Map([[7, 1]]), { alive, snapshot: () => null });
  assert.strictEqual(b.survivors.length, 1, 'unreadable is not an answer: it is reported');
  const c = survivors([7], new Map([[7, 1]]), { alive, snapshot: snapOf([]) });
  assert.deepStrictEqual(c.survivors, []);
  let taken = 0;
  survivors([7], new Map(), { alive: () => false, snapshot: () => { taken++; return null; } });
  assert.strictEqual(taken, 0, 'no snapshot when nothing reads alive');
});

test('survivors: a real live process is a survivor by its own identity; the same pid with another recorded time is not', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => child.once('spawn', r));
    let me = null;
    for (let i = 0; i < 20 && !me; i++) { me = await ID.createdOf(child.pid); if (!me) await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(me && me.created != null, 'the child has a readable creation time');
    const real = survivors([child.pid], new Map([[child.pid, me.created]]));
    assert.strictEqual(real.survivors.length, 1, JSON.stringify(real));
    assert.strictEqual(real.survivors[0].created, me.created);
    assert.ok(real.survivors[0].image, 'the image is named');
    const reused = survivors([child.pid], new Map([[child.pid, me.created - 60000]]));
    assert.deepStrictEqual(reused.survivors, []);
    assert.strictEqual(reused.reused.length, 1);
  } finally { crash.crash(child); }
});
