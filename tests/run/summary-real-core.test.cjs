'use strict';
// summary-real-core.test.cjs — a task's summary is built from the observation bodies on a real store. Core's
// memory.list never returns a body, so a fake that does hid the summary reading none (every file and command
// list empty yet the row stored ok). Here the rows are written and read through a real core in a sandbox.

const test = require('node:test');
const assert = require('node:assert');

const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const RUN = 'summary-real-1';
const LEVERS = { ...DEFAULTS, capture: true, observations: true, summaries: 'mechanical' };

async function setup(observations) {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS) });
  const t = await orch.task.create({ spec: 'build the parser' });
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's1', last_event_at: Date.now(), task_id: t.id });
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-1' });
  for (let i = 0; i < observations.length; i += 1) {
    await orch.memory.store({ type: 'observation', title: `turn ${i + 1}`, text: `turn ${i + 1}`, body: observations[i], task_id: t.id, worker_id: 'coder-1', embed: false, source: 'harness' });
  }
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'coder-1', run_id: RUN }), embed: false });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'parser built', verdict: 'holds' } });
  await w.close();
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's1', task_id: t.id });
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  return { dir, orch, op, taskId: t.id };
}
async function teardown(s) {
  await s.op.close();
  await s.orch.shutdownOwner();
  await s.orch.close();
  cleanup(s.dir);
}
const summaryOf = async (s) => {
  const listed = await s.op.memory.list({ filter: { types: ['summary'] }, view: 'index' });
  assert.strictEqual(listed.rows.length, 1, 'one summary row');
  return s.op.memory.get({ id: listed.rows[0].id, view: 'full' });
};

test('the summary lists the files and commands in the observation bodies', async () => {
  const s = await setup([
    { v: 1, turn: 1, files_read: ['a.cjs'], files_modified: ['b.cjs'], commands: [{ command: 'npm test', exit_code: 1 }], errors: 0 },
    { v: 1, turn: 2, files_read: ['c.cjs'], files_modified: ['b.cjs', 'd.cjs'], commands: [{ command: 'npm test', exit_code: 0 }], errors: 1 },
  ]);
  try {
    assert.deepStrictEqual(await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS }), { outcome: 'done' });
    const row = await summaryOf(s);
    assert.deepStrictEqual(row.body.looked_at, ['a.cjs', 'c.cjs']);
    assert.deepStrictEqual(row.body.done.files_modified, ['b.cjs', 'd.cjs']);
    assert.strictEqual(row.body.done.commands.length, 2);
    assert.strictEqual(row.body.notes.errors, 1);
    assert.match(row.text, /modified b\.cjs, d\.cjs; ran 2 commands \(1 failed\)/);
  } finally { await teardown(s); }
});

test('500 observations with commands still give a stored summary under 8192 bytes, with the counts', async () => {
  const obs = Array.from({ length: 500 }, (_, i) => ({
    v: 1, turn: i + 1, files_read: [`src/read/file-${i}.cjs`], files_modified: [`src/changed/file-${i}.cjs`],
    commands: [{ command: `node scripts/run-check.cjs --case ${i} ${'x'.repeat(300)}`, exit_code: i % 7 === 0 ? 1 : 0 }], errors: 0,
  }));
  const s = await setup(obs);
  try {
    assert.deepStrictEqual(await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS }), { outcome: 'done' });
    const ledger = (await s.op.memory.events({ run_id: RUN, kinds: ['summary'] })).events;
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].ok, 1, 'the summary was stored, not classed over_budget');
    const row = await summaryOf(s);
    assert.ok(Buffer.byteLength(JSON.stringify(row.body), 'utf8') <= 8192, 'the stored body fits the budget');
    const d = row.body.done;
    assert.ok(d.commands.length <= 30);
    assert.strictEqual(d.commands.length + (d.commands_omitted || 0), 500, 'commands plus the count of the rest is every command');
    assert.strictEqual(d.files_modified.length + (d.files_modified_omitted || 0), 500);
    assert.strictEqual(row.body.looked_at.length + (row.body.looked_at_omitted || 0), 500);
    assert.match(row.text, /ran 500 commands/);
  } finally { await teardown(s); }
});

const turns = (n) => Array.from({ length: n }, (_, i) => ({ v: 1, turn: i + 1, files_read: [], files_modified: [`f${i}.cjs`], commands: [{ command: `c${i}`, exit_code: 0 }], errors: 0 }));
const failOnCall = (core, which) => {
  const real = core.memory.get_many.bind(core.memory);
  let n = 0;
  core.memory.get_many = async (a) => { n += 1; if (n >= which) throw Object.assign(new Error('busy'), { code: 'E_BUSY' }); return real(a); };
};

test('the kept commands are the last 30, in order, and the files the first 50', async () => {
  const s = await setup(turns(120));
  try {
    await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    const row = await summaryOf(s);
    assert.deepStrictEqual(row.body.done.commands.map((c) => c.command), Array.from({ length: 30 }, (_, i) => `c${90 + i}`));
    assert.strictEqual(row.body.done.commands_omitted, 90);
    assert.deepStrictEqual(row.body.done.files_modified.slice(0, 3), ['f0.cjs', 'f1.cjs', 'f2.cjs']);
    assert.strictEqual(row.body.done.files_modified_omitted, 70);
  } finally { await teardown(s); }
});

test('a read that stops partway keeps what it read and says the list is incomplete', async () => {
  const s = await setup(turns(120));
  try {
    failOnCall(s.op, 2);
    await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    const row = await summaryOf(s);
    assert.deepStrictEqual(row.body.observations_partial, { read: 50, listed: 120, code: 'E_BUSY' });
    assert.strictEqual(row.body.done.commands.length + row.body.done.commands_omitted, 50);
    assert.match(row.text, /observation list incomplete \(read 50 of 120 listed, E_BUSY\)/);
  } finally { await teardown(s); }
});

test('nothing read of a task that has observations is a failed summary, not an empty one', async () => {
  const s = await setup(turns(3));
  try {
    failOnCall(s.op, 1);
    await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    const ev = (await s.op.memory.events({ run_id: RUN, kinds: ['summary'] })).events;
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].ok, 0);
    assert.strictEqual(ev[0].code, 'E_BUSY');
    assert.strictEqual((await s.op.memory.list({ filter: { types: ['summary'] }, view: 'index' })).rows.length, 0);
  } finally { await teardown(s); }
});

test('the stored body is under 8192 bytes for hostile input of every kind', async () => {
  const { summarise } = require('../../src/run/summarise.cjs');
  const big = (n, c = 'x') => c.repeat(n);
  const cases = {
    'huge findings': { handoff: { findings: big(20000), next_step: big(20000), verdict: big(20000) } },
    'huge multibyte findings': { handoff: { findings: big(5000, '\u{1F600}'), next_step: big(5000, '\u00e9'), verdict: big(5000, '\u4e2d') } },
    'huge commands': { observations: [{ body: { commands: Array.from({ length: 300 }, (_, i) => ({ command: big(5000, '\u00e9') + i, exit_code: 1 })) } }] },
    'many long files': { observations: [{ body: { files_read: Array.from({ length: 400 }, (_, i) => big(900) + i), files_modified: Array.from({ length: 400 }, (_, i) => big(900, '\u4e2d') + i) } }] },
    'everything': { handoff: { findings: big(9000), next_step: big(9000), verdict: big(9000) }, observations: [{ body: { commands: Array.from({ length: 100 }, () => ({ command: big(4000), exit_code: 2 })), files_read: Array.from({ length: 200 }, (_, i) => big(500) + i), files_modified: Array.from({ length: 200 }, (_, i) => big(500) + i) } }] },
  };
  for (const [name, input] of Object.entries(cases)) {
    const out = await summarise({ task: { spec: big(2000), state: 'done' }, ...input }, { kind: 'mechanical' });
    assert.strictEqual(out.output_class, 'ok', name);
    const body = JSON.stringify({ v: 1, ...out.fields, generator: out.generator });
    assert.ok(Buffer.byteLength(body, 'utf8') <= 8192, `${name}: ${Buffer.byteLength(body, 'utf8')} bytes`);
    assert.ok(!body.includes('\ufffd'), `${name}: no broken character`);
  }
});
