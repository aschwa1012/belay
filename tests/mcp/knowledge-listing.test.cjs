// knowledge-listing.test.cjs — ADR 0043 decision 1: knowledge_ask is listed only when the run's knowledge_agent
// lever is on. With the lever off the orchestrator's listing is byte-identical to what it was before the tool
// existed; with it on the tool is listed and the listing is under the 10 KB budget. The worker never lists it.
// The adapter reads the run row once, through the core, and creates nothing to do so.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE = `${ROOT}/tests/mcp/fake-core-knowledge.cjs`;
const ON = JSON.stringify({ knowledge_agent: true });
const OFF = JSON.stringify({ knowledge_agent: false, rules: true });

// A data dir that already holds a store file (the gate never reads a store that is not there).
function dataDir(tag, { store = true } = {}) {
  const d = sandboxDir(tag);
  if (store) fs.writeFileSync(`${d}/memory.db`, '');
  return d;
}

async function listing({ role = 'orchestrator', levers, store = true, runGet, tag = 'kl' } = {}) {
  const data = dataDir(tag, { store });
  const countFile = path.join(data, 'run-get-count.txt');
  const env = { BELAY_FAKE_CORE: FAKE, BELAY_FAKE_COUNT_FILE: countFile };
  if (levers !== undefined) env.BELAY_FAKE_LEVERS = levers;
  if (runGet) env.BELAY_FAKE_RUNGET = runGet;
  const a = launch({ role, data, workerId: role === 'worker' ? 'w1' : undefined, env });
  try {
    await a.initialize();
    const list = await a.list();
    const again = await a.list();
    const reads = fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0;
    return { list, again, reads, stderr: () => a.stderr, data, adapter: a };
  } finally { await a.close(); }
}

const bytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

test('lever off: the orchestrator listing is byte-identical to the listing without the tool', async () => {
  const baseline = JSON.stringify(tools.toolsFor('orchestrator'));
  for (const levers of [undefined, OFF]) {
    const r = await listing({ levers });
    assert.strictEqual(JSON.stringify(r.list), baseline, `levers ${levers}`);
    assert.ok(!r.list.some((t) => t.name === 'knowledge_ask'));
  }
  assert.strictEqual(bytes(tools.toolsFor('orchestrator')), 14410, 'the off listing is the 14,410 bytes last measured (14,236 before the task_create amend and tree_of, 14,185 before the task_create base, 13,982 before the lean replies, 13,921 before ADR 0060 judged heads, 13,827 before ADR 0060 retries_on_fail, 13,728 before the integration state, 13,360 before the compact task views, 13,321 before the ADR 0059 task_create text, 11,076 before ADR 0054\'s git_read, 11,049 before the ADR 0057 search texts, 9,900 before ADR 0053\'s worktree tools, 9,829 before the paired write/search contract)');
});

test('lever on: knowledge_ask is listed, last, and the listing is under the orchestrator budget', async () => {
  const r = await listing({ levers: ON });
  assert.deepStrictEqual(r.list.map((t) => t.name).slice(-1), ['knowledge_ask']);
  assert.strictEqual(JSON.stringify(r.list), JSON.stringify(tools.toolsFor('orchestrator', { knowledge: true })));
  const b = bytes(r.list);
  console.log(`knowledge_ask on: ${r.list.length} tools, ${b} bytes, budget ${tools.BUDGET.orchestrator}, headroom ${tools.BUDGET.orchestrator - b}`);
  assert.ok(b <= tools.BUDGET.orchestrator, `${b} bytes is over the ${tools.BUDGET.orchestrator} byte budget`);
  assert.strictEqual(tools.listingBytes('orchestrator', { knowledge: true }), b);
  assert.deepStrictEqual(r.again, r.list, 'a second tools/list answers the same');
});

test('the run row is read once for any number of listings', async () => {
  const r = await listing({ levers: ON, tag: 'kl-once' });
  assert.strictEqual(r.reads, 1);
});

test('a worker never lists knowledge_ask, whatever the lever, and its listing is unchanged', async () => {
  const r = await listing({ role: 'worker', levers: ON, tag: 'kl-w' });
  assert.strictEqual(JSON.stringify(r.list), JSON.stringify(tools.toolsFor('worker')));
  assert.strictEqual(r.reads, 0, 'a worker adapter reads no lever');
  assert.ok(bytes(r.list) <= tools.BUDGET.worker);
  assert.strictEqual(JSON.stringify(tools.toolsFor('worker', { knowledge: true })), JSON.stringify(tools.toolsFor('worker')));
});

test('with no store the tool is not listed and nothing is created or read', async () => {
  const r = await listing({ levers: ON, store: false, tag: 'kl-nostore' });
  assert.ok(!r.list.some((t) => t.name === 'knowledge_ask'));
  assert.strictEqual(r.reads, 0);
  assert.deepStrictEqual(fs.readdirSync(r.data).filter((f) => f !== 'run-get-count.txt'), [], 'the data dir stays empty');
});

test('a run row that cannot be read leaves the tool out, says so, and asks again next time', async () => {
  const r = await listing({ levers: ON, runGet: 'fail', tag: 'kl-fail' });
  assert.ok(!r.list.some((t) => t.name === 'knowledge_ask'));
  assert.match(r.stderr(), /knowledge_ask is not listed: the run's levers could not be read: fake run\.get failure/);
  assert.strictEqual(r.reads, 2, 'a failed read is not cached');
});

test('a run row that never answers is given up on inside the bound', { timeout: 20000 }, async () => {
  const t0 = Date.now();
  const r = await listing({ levers: ON, runGet: 'hang', tag: 'kl-hang' });
  assert.ok(!r.list.some((t) => t.name === 'knowledge_ask'));
  assert.match(r.stderr(), /did not answer inside 3000 ms/);
  assert.ok(Date.now() - t0 < 15000);
});

test('once the adapter has attached, the listing and the run manager take the levers from the attach row: no run.get at all', async () => {
  const data = dataDir('kl-attached');
  const countFile = path.join(data, 'run-get-count.txt');
  const wt = sandboxDir('kl-wt');
  const a = launch({ data, extra: ['--worktree', wt], env: { BELAY_FAKE_CORE: FAKE, BELAY_FAKE_LEVERS: ON, BELAY_FAKE_COUNT_FILE: countFile } });
  try {
    await a.initialize();
    const asked = await a.call('knowledge_ask', { question: 'q' }); // opens the run manager, which attaches first
    assert.strictEqual(asked.isError, false, JSON.stringify(asked));
    assert.strictEqual(asked.structuredContent.manager_levers.knowledge_agent, true, 'the manager was handed the levers');
    assert.strictEqual(asked.structuredContent.manager_worktree, wt, 'and the run worktree from --worktree');
    const list = await a.list();
    assert.ok(list.some((t) => t.name === 'knowledge_ask'));
    assert.ok(!fs.existsSync(countFile), 'run.get was never called');
  } finally { await a.close(); }
});

test('knowledge_ask routes to the run manager, and a worker is refused with E_ROLE', async () => {
  const data = dataDir('kl-call');
  const orch = launch({ data, env: { BELAY_FAKE_CORE: FAKE, BELAY_FAKE_LEVERS: ON } });
  const worker = launch({ role: 'worker', workerId: 'w1', data, env: { BELAY_FAKE_CORE: FAKE, BELAY_FAKE_LEVERS: ON } });
  try {
    await orch.initialize();
    const ok = await orch.call('knowledge_ask', { question: 'why a pipe?' });
    assert.strictEqual(ok.isError, false, JSON.stringify(ok));
    assert.strictEqual(ok.structuredContent.answer, 'echo: why a pipe?');
    const bad = await orch.call('knowledge_ask', {});
    assert.strictEqual(bad.structuredContent.error, 'E_ARGS');
    await worker.initialize();
    const refused = await worker.call('knowledge_ask', { question: 'x' });
    assert.strictEqual(refused.structuredContent.error, 'E_ROLE');
  } finally { await orch.close(); await worker.close(); }
});

// The knowledge agent reads memory it did not write, so its adapter lists and allows only the memory read tools.
test('the knowledge agent\'s worker adapter lists and allows only the memory read tools', async (t) => {
  const names = tools.toolsFor('worker', { workerId: 'knowledge-r1' }).map((x) => x.name).sort();
  assert.deepStrictEqual(names, [...tools.KNOWLEDGE_READ_TOOLS].sort());
  for (const n of ['memory_store', 'memory_delete', 'lease_release', 'checkpoint_write', 'task_list']) assert.strictEqual(tools.allows('worker', n, 'knowledge-r1'), false, n);
  for (const n of tools.KNOWLEDGE_READ_TOOLS) assert.strictEqual(tools.allows('worker', n, 'knowledge-r1'), true, n);
  assert.strictEqual(tools.allows('worker', 'memory_store', 'w1'), true, 'any other worker keeps its surface');
  const { KNOWLEDGE_TOOLS } = require('../../src/run/knowledge.cjs');
  assert.deepStrictEqual(KNOWLEDGE_TOOLS.filter((x) => x.startsWith('mcp__')).sort(), tools.KNOWLEDGE_READ_TOOLS.map((x) => `mcp__belay__${x}`).sort(), 'the pre-approved list names the same tools');
  const a = launch({ role: 'worker', data: dataDir('kw'), workerId: 'knowledge-r1', env: { BELAY_FAKE_CORE: FAKE } });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  assert.deepStrictEqual((await a.list()).map((x) => x.name).sort(), names);
  const r = await a.call('memory_store', { text: 'a knowledge agent write' });
  assert.deepStrictEqual([r.isError, r.structuredContent.error], [true, 'E_ROLE']);
});
