'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A wake held during a run pause is re-sent on resume with the text it had when it was held. The receipt record carries no
// text, so re-rendering from it sent an `evaluated` or `note_refuted` wake as an empty text block and dropped the release
// evaluation from a turn_end and the released-lease clause from a death.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunHold } = require('../../src/run/run-hold.cjs');
const { wakeText } = require('../../src/run/wake.cjs');

const cases = [
  { event: 'evaluated', worker_id: 'call:k1', turn: 0, seq: 5, task_id: 't1', text: 'belay: integrate of t1 ended: merged.' },
  { event: 'note_refuted', worker_id: 'note:n1', turn: 0, seq: 6, text: 'belay: note n1 was refuted by review r1; read memory_note_refutation.' },
  { event: 'turn_end', worker_id: 'w1', turn: 3, seq: 7, evaluated: [{ task_id: 't1', state: 'done', passed: true, failing: [] }] },
  { event: 'death', worker_id: 'w2', turn: 2, seq: 8, exit_code: 1, exit_signal: null, death_established_by: 'exit event', leases_released: [{ lease_id: 'lease-9', task_id: 't9' }] },
];
// The record writeWake builds: the wake's facts, never its text.
const record = (ev, text) => ({ at_ms: 0, worker_id: ev.worker_id, event: ev.event, turn: ev.turn, bytes: Buffer.byteLength(text, 'utf8'), orchestrator_idle_at_write: true, established_by: 'test' });

test('a resume writes each held wake with the text it was held with', () => {
  const writes = [];
  const child = { stdin: { destroyed: false, writableEnded: false, write: () => true } };
  const hold = createRunHold({
    child, getIdle: () => true, onDeadline: () => {}, wakeText,
    writeStdinLine: (text) => { writes.push(text); return true; },
    pushWake: () => {}, suppressWake: () => {}, nowMs: () => 0,
  });
  hold.pause('op'); // the paused state is set synchronously
  const texts = cases.map((ev) => wakeText(ev));
  texts.forEach((t) => assert.ok(t && t.length > 0));
  cases.forEach((ev, i) => assert.equal(hold.holdWake(record(ev, texts[i]), texts[i]), true));
  writes.length = 0;
  hold.resume('op', 'resumed');
  assert.deepEqual(writes.slice(1), texts); // [0] is the resume line
  assert.match(writes[3], /evaluated at release/);
  assert.match(writes[4], /lease-9/);
});
