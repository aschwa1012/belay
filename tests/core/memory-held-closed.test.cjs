'use strict';
// memory-held-closed.test.cjs — the held-note read filter fails closed (ADR 0047 amendment of 2026-10-25): a hold body it cannot read hides its
// note, or every note of its project when no note can be named, and is counted as malformed for the operator; it never opens every note. And a
// 0.3.0 hold written past the breaker (state held, hiding nothing) is counted, listed, marked and ranked as queued. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const call = (caller, method, args = {}) => E.handle(method, { caller, ...args });
const RUN = 'hc-run';
const worker = (project) => callerFor('worker', { run_id: `${RUN}-${project}`, worker_id: 'w-reader' });
const orch = (project) => callerFor('orchestrator', { run_id: `${RUN}-${project}` });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  for (const p of ['ha', 'hb', 'hl']) await call(orch(p), 'run.attach', { adapter_pid: process.pid, project: p, memory_levers: JSON.stringify({ project: p, notes: true }) });
});
after(() => withTeardown(() => {}, [() => store.close(), () => cleanup(dir)]));

let n = 0;
const note = (project, title) => store.storeIn({
  namespace: `project/${project}`, worker_id: 'w1', type: 'note', text: `${title} closedcase ${++n}`, title,
  body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
  embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'gone-run', task_id: null, source: 'model', written_by: 'worker:w1',
}).id;
const hold = (project, body) => store.storeIn({ namespace: `held/${project}`, worker_id: 'harness', type: 'held', text: `held ${++n}`, title: 'h', body, run_id: 'gone-run', source: 'harness', written_by: 'harness' }).id;
const listed = async (caller, project, id) => (await call(caller, 'memory.list', { namespaces: [`project/${project}`], limit: 500 })).rows.some((r) => r.id === id);
const got = async (caller, id) => (await call(caller, 'memory.get', { id })).found === true;

test('a hold whose reports are not a list of objects hides its note and only that note, and is counted as malformed', async () => {
  const bad = note('ha', 'reports x');
  const plain = note('ha', 'plain');
  hold('ha', { state: 'held', note_id: bad, kind: 'wrong', ground: 'reported', reports: 'x', rev: 0 }); // the checker's probe
  const other = note('ha', 'reports with a string entry');
  hold('ha', { state: 'held', note_id: other, kind: 'wrong', ground: 'reported', reports: ['x'], rev: 0 });
  for (const id of [bad, other]) {
    assert.strictEqual(await listed(worker('ha'), 'ha', id), false, 'closed: withheld');
    assert.strictEqual(await got(worker('ha'), id), false);
  }
  assert.strictEqual(await listed(worker('ha'), 'ha', plain), true, 'nothing else is hidden');
  const c = await call(orch('ha'), 'memory.held', { project: 'ha' });
  assert.ok(c.malformed >= 2, JSON.stringify(c));
  assert.ok(c.total >= 2, 'the count is not thrown away');
  // The operator is told: belay notices carries one event while an unreadable hold stands.
  const N = require('../../src/cli/cmd-notices.cjs');
  const ev = N.heldEvents(c, null).find((e) => e.kind === 'holds_unreadable');
  assert.ok(ev && ev.count === c.malformed);
  assert.ok(N.renderText([ev]).includes('held rows cannot be read; their notes are withheld from workers (closed)'));
});

test('a hold body that is not JSON hides the note it names; one that names none closes its whole project, never others', async () => {
  const named = note('hb', 'named in a broken body');
  const plain = note('hb', 'plain in hb');
  const elsewhere = note('ha', 'plain in ha');
  const h1 = hold('hb', { state: 'held', note_id: named, kind: 'wrong', ground: 'reported', rev: 0 });
  store.db.prepare('UPDATE memory_entries SET body = ? WHERE id = ?').run(`{"state":"held","note_id":"${named}", broken`, h1);
  assert.strictEqual(await listed(worker('hb'), 'hb', named), false);
  assert.strictEqual(await listed(worker('hb'), 'hb', plain), true);
  const h2 = hold('hb', { state: 'held', kind: 'wrong' });
  store.db.prepare('UPDATE memory_entries SET body = ? WHERE id = ?').run('not json at all', h2);
  assert.strictEqual(await listed(worker('hb'), 'hb', plain), false, 'an unnamed broken hold closes its project');
  assert.strictEqual(await got(worker('hb'), plain), false);
  assert.strictEqual(await listed(worker('ha'), 'ha', elsewhere), true, 'another project stays open');
  assert.strictEqual(await listed(orch('hb'), 'hb', plain), true, 'the orchestrator still sees it');
  assert.ok((await call(orch('hb'), 'memory.held', {})).malformed >= 2);
  store.db.prepare("UPDATE memory_entries SET body = '{\"state\":\"released\"}' WHERE id IN (?, ?)").run(h1, h2);
  assert.strictEqual(await listed(worker('hb'), 'hb', plain), true, 'readable again once the rows are');
});

test('a 0.3.0 hold past the breaker is shown as queued: counted, listed, unmarked and in rank order; its proof says queued', async () => {
  const legacy = note('hl', 'legacy past breaker');
  hold('hl', { state: 'held', note_id: legacy, kind: 'wrong', ground: 'reported', reason: 'disputed', rev: 0, reports: [{ key: 'k1', by: 'worker:w9', run_id: 'r-old', why: 'x', at: 1, withhold: false }] });
  const live = note('hl', 'held for real');
  hold('hl', { state: 'held', note_id: live, kind: 'wrong', ground: 'reported', reason: 'disputed', rev: 0, reports: [{ key: 'k2', by: 'orchestrator', why: 'y', at: 2 }] });
  const c = await call(orch('hl'), 'memory.held', { project: 'hl', list: true });
  assert.deepStrictEqual([c.total, c.held, c.queued, c.by_ground.reported], [2, 1, 1, 1]);
  assert.strictEqual(c.entries.find((e) => e.note_id === legacy).state, 'queued');
  assert.strictEqual(c.entries.find((e) => e.note_id === live).state, 'held');
  assert.strictEqual(await listed(worker('hl'), 'hl', legacy), true, 'visible to a worker');
  const rows = (await call(orch('hl'), 'memory.list', { namespaces: ['project/hl'], limit: 500 })).rows;
  assert.strictEqual(rows.find((r) => r.id === legacy).held, undefined, 'unmarked for the orchestrator');
  assert.strictEqual(rows.find((r) => r.id === live).held.kind, 'wrong');
  // A report past its run's breaker on the legacy hold leaves it hiding nothing, and the proof says it is queued, not "not of a kind".
  const brk = callerFor('orchestrator', { run_id: 'hc-brk' });
  await call(brk, 'run.attach', { adapter_pid: process.pid, project: 'hl', memory_levers: JSON.stringify({ project: 'hl', notes: true, held_breaker_count: 1 }) });
  assert.strictEqual((await call(brk, 'memory.noteReport', { note_id: note('hl', 'the run\'s one withholding report'), why: 'wrong' })).withheld, true);
  const out = await call(brk, 'memory.noteReport', { note_id: legacy, why: 'still wrong' });
  assert.deepStrictEqual([out.withheld, /^queued: every report on its hold is past its run's breaker/.test(out.withheld_why)], [false, true], out.withheld_why);
  assert.strictEqual(await listed(worker('hl'), 'hl', legacy), true, 'still visible');
});

test('a hold whose note_id is not a non-empty string closes its project loudly: counted, named in the notice, the status line and stderr', async () => {
  await call(orch('hn'), 'run.attach', { adapter_pid: process.pid, project: 'hn', memory_levers: JSON.stringify({ project: 'hn', notes: true }) });
  const plain = note('hn', 'plain in hn');
  const h = hold('hn', { state: 'held', note_id: 12345, kind: 'wrong', ground: 'reported', reports: [{ key: 'k', by: 'orchestrator', why: 'x', at: 1 }], rev: 0 }); // the checker's probe
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (s, ...rest) => { lines.push(String(s)); return true; };
  let seen;
  try { seen = await listed(worker('hn'), 'hn', plain); } finally { process.stderr.write = write; }
  assert.strictEqual(seen, false, 'closed: the whole project is withheld');
  assert.ok(lines.some((l) => l.includes(h) && l.includes('every note of project hn is withheld from workers')), lines.join(''));
  const c = await call(orch('hn'), 'memory.held', { project: 'hn' });
  assert.deepStrictEqual([c.malformed, c.closed_projects], [1, ['hn']], 'counted though its note cannot be found');
  const N = require('../../src/cli/cmd-notices.cjs');
  const ev = N.heldEvents(c, null).find((e) => e.kind === 'holds_unreadable');
  assert.ok(N.renderText([ev]).includes('every note of project hn is withheld from workers'));
  const P = require('../../src/cli/panel-common.cjs');
  assert.ok(P.unreadableText({ count: c.malformed, closed_projects: c.closed_projects }).includes('every note of project hn'));
  store.db.prepare("UPDATE memory_entries SET body = '{\"state\":\"released\"}' WHERE id = ?").run(h);
  assert.strictEqual(await listed(worker('hn'), 'hn', plain), true, 'open again once the row is settled');
});
