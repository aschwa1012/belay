'use strict';
// review-claim.test.cjs — the in-flight claim of an archive review: one live review per project, a dead claim taken over by
// compare-and-swap and recorded, a release that only the holder can make, and a read that names what established "running".

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'r-claim';
const op = callerFor('operator', { run_id: RUN });
const orch = callerFor('orchestrator', { run_id: RUN });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const claim = (over = {}) => call('memory.reviewClaim', op, { project: 'acme', pid: process.pid, created: 1000, image: 'node.exe', job: 'archreview-r-claim-a', ...over });
const state = async (project = 'acme') => (await call('memory.reviewState', orch, { project })).reviews[project];

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => null, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('a project with no review says none, and a claim makes it running with the pid and creation time on the row', async () => {
  assert.deepStrictEqual((await state()).state, 'none');
  const { claim: c, replaced } = await claim();
  assert.deepStrictEqual([c.pid, c.created, c.image, c.job, replaced], [process.pid, 1000, 'node.exe', 'archreview-r-claim-a', null]);
  const st = await state();
  assert.deepStrictEqual([st.state, st.pid_alive, st.claim.id], ['running', true, c.id]);
  assert.match(st.established_by, /no release after it/);
  const ev = store.p("SELECT kind, ok, key, worker_id FROM memory_event WHERE id = ?").get(c.id);
  assert.deepStrictEqual({ ...ev }, { kind: 'review_claim', ok: 1, key: 'review:acme', worker_id: 'archreview-r-claim-a' });
});

test('a second claim of a running project is E_BUSY and names the holder; another project is free', async () => {
  await assert.rejects(claim({ job: 'archreview-r-claim-b' }), (e) => e.code === 'E_BUSY' && e.detail.claim.pid === process.pid && /already claimed/.test(e.message));
  await assert.rejects(claim({ job: 'archreview-r-claim-b', replaces: 'me-not-the-claim' }), (e) => e.code === 'E_BUSY');
  const other = await claim({ project: 'zeta', job: 'archreview-r-claim-z' });
  assert.ok(other.claim.id);
  await call('memory.reviewRelease', op, { project: 'zeta', claim_id: other.claim.id, ok: true, message: 'done' });
});

test('a dead claim is taken over by naming it; the new claim records what it replaced, and the old holder can no longer release', async () => {
  const old = (await state()).claim;
  const dead = await claim({ pid: deadPid(), job: 'archreview-r-claim-c', replaces: old.id });
  assert.deepStrictEqual([dead.replaced.id, dead.replaced.pid, dead.replaced.job], [old.id, old.pid, old.job]);
  assert.strictEqual((await state()).claim.id, dead.claim.id);
  await assert.rejects(call('memory.reviewRelease', op, { project: 'acme', claim_id: old.id, ok: true }), (e) => e.code === 'E_BUSY' && /taken over/.test(e.message));
  const st = await state();
  assert.deepStrictEqual([st.state, st.pid_alive], ['running', false], 'the pid check says the new holder is gone too');
});

test('two takers of one dead claim: exactly one wins the compare-and-swap', async () => {
  const cur = (await state()).claim;
  const results = await Promise.allSettled([claim({ pid: process.pid, job: 'archreview-r-claim-d1', replaces: cur.id }), claim({ pid: process.pid, job: 'archreview-r-claim-d2', replaces: cur.id })]);
  assert.deepStrictEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.strictEqual(results.find((r) => r.status === 'rejected').reason.code, 'E_BUSY');
});

test('a release ends the review with its outcome: ok, or the code that failed it; a second release and a new claim follow', async () => {
  const cur = (await state()).claim;
  const rel = await call('memory.reviewRelease', op, { project: 'acme', claim_id: cur.id, ok: false, code: 'E_TIMEOUT', message: 'the archive review did not finish inside 600 s' });
  assert.deepStrictEqual([rel.release.ok, rel.release.code, rel.release.claim_id], [false, 'E_TIMEOUT', cur.id]);
  const st = await state();
  assert.deepStrictEqual([st.state, st.claim.id, st.release.code, st.release.summary], ['ended', cur.id, 'E_TIMEOUT', 'the archive review did not finish inside 600 s']);
  await assert.rejects(call('memory.reviewRelease', op, { project: 'acme', claim_id: cur.id, ok: true }), (e) => e.code === 'E_BUSY' && /already released/.test(e.message));
  const next = await claim({ job: 'archreview-r-claim-e' });
  assert.ok(next.claim.id && next.replaced === null, 'an ended review is free: no takeover is needed');
  await call('memory.reviewRelease', op, { project: 'acme', claim_id: next.claim.id, ok: true, message: 'ran' });
  assert.strictEqual((await state()).release.ok, true);
});

test('the read lists every project with a review, and a failed release must name its code', async () => {
  const all = (await call('memory.reviewState', orch, {})).reviews;
  assert.deepStrictEqual(Object.keys(all).sort(), ['acme', 'zeta']);
  const c = (await claim({ job: 'archreview-r-claim-f' })).claim;
  await assert.rejects(call('memory.reviewRelease', op, { project: 'acme', claim_id: c.id, ok: false }), (e) => e.code === 'E_ARGS');
  await call('memory.reviewRelease', op, { project: 'acme', claim_id: c.id, ok: true });
});

test('only the operator claims or releases; any role reads; bad arguments are E_ARGS', async () => {
  for (const method of ['memory.reviewClaim', 'memory.reviewRelease']) {
    for (const caller of [orch, callerFor('worker', { run_id: RUN, worker_id: 'w1' })]) {
      await assert.rejects(call(method, caller, { project: 'acme', pid: 1, job: 'j', claim_id: 'x', ok: true }), (e) => e.code === 'E_ROLE' || /role/i.test(e.message), `${method} ${caller.role}`);
    }
  }
  await assert.rejects(claim({ pid: 'x' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(claim({ job: '' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(claim({ extra: 1 }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.reviewRelease', op, { project: 'acme', claim_id: 'c', ok: 'yes' }), (e) => e.code === 'E_ARGS');
});
