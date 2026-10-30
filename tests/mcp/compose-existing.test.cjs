'use strict';
// compose-existing.test.cjs — an assignment the core answers as already standing (a policy step made it) is sent to the worker unless this
// process has already sent it: a policy step's hand-over that failed must not leave the worker without its task when the orchestrator
// assigns the same worker again.

const test = require('node:test');
const assert = require('node:assert');
const { createCompose } = require('../../src/mcp/compose.cjs');

function harness(lease, { existing }) {
  const sent = [];
  const callCore = async (m, a) => {
    if (m === 'task.assign') return { task: { id: a.task_id, spec: 'do it', state: 'assigned' }, new_lease: { id: lease }, ...(existing ? { existing: true } : {}) };
    if (m === 'continuity.resumeLine') return { text: `task ${a.task_id} lease=${lease}.` };
    throw new Error(`unexpected ${m}`);
  };
  const mgr = { _worker: () => ({}), message: async (a) => { sent.push(a.text); return { worker_id: a.worker_id, channel: 'stdin', bytes: 1 }; } };
  return { c: createCompose({ callCore, manager: () => mgr }), sent };
}

test('an existing assignment with no delivery on record is sent', async () => {
  const h = harness('LX1', { existing: true });
  const out = await h.c.assign({ task_id: 't1', worker_id: 'w1' });
  assert.strictEqual(out.delivered.sent, true);
  assert.strictEqual(h.sent.length, 1);
});

test('an existing assignment this process already sent is not sent again, in any compose instance', async () => {
  const first = harness('LX2', { existing: false });
  assert.strictEqual((await first.c.assign({ task_id: 't2', worker_id: 'w1' })).delivered.sent, true);
  const again = harness('LX2', { existing: true });
  const out = await again.c.assign({ task_id: 't2', worker_id: 'w1' });
  assert.strictEqual(again.sent.length, 0);
  assert.strictEqual(out.delivered.sent, false);
  assert.match(out.delivered.reason, /already stands/);
});

test('an existing assignment held by another worker is not sent to the one asked for', async () => {
  const sent = [];
  const callCore = async (m, a) => {
    if (m === 'task.assign') return { task: { id: a.task_id, spec: 'do it', state: 'assigned' }, new_lease: { id: 'LY1', holder: 'w2' }, existing: true };
    throw new Error(`unexpected ${m}`);
  };
  const mgr = { _worker: () => ({}), message: async (a) => { sent.push(a); return {}; } };
  const out = await createCompose({ callCore, manager: () => mgr }).assign({ task_id: 't9', worker_id: 'w1' });
  assert.deepStrictEqual(sent, []);
  assert.match(out.delivered.reason, /already held by w2, not w1/);
  assert.strictEqual(out.existing, true);
});
