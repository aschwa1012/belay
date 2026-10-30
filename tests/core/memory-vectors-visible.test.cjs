'use strict';
// memory-vectors-visible.test.cjs — the row-first selection sees the same notes the current memory.search does (ADR 0050: every
// tier sees the same notes), for an ungated caller and, with the caller's gate passed as `hidden`, for a gated one.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const MV = require('../../src/core/memory-vectors.cjs');
const gate = require('../../src/core/memory-note-gate.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const TIER = { model: 'm', revision: 'r', dims: 3 };

test('selectSearchable returns exactly the set memory.search returns, over live, held, refuted, expired, superseded and archived notes', async () => {
  const ns = `project/${PROJECT}`, arch = `archive/${PROJECT}`;
  const live = T.note('visible live');
  const held = T.note('visible held');
  const refuted = T.note('visible refuted', { status: 'refuted' });
  const expired = T.note('visible expired');
  const old = T.note('visible old');
  const newer = T.note('visible newer');
  const archived = T.note('visible archived', { ns: arch });
  const promoted = T.note('visible promoted');
  const pending = T.note('visible pending', { state: 'pending' });
  const otherRun = T.note('visible other open run', { run_id: 'lc-plain' });
  const zeroTtl = T.note('visible zero ttl');
  const b = T.body(held);
  b.held = { row: 'h', kind: 'wrong', of: null, reason: 'x', run_id: 'r', at: 1 };
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), held);
  T.store.p('UPDATE memory_entries SET ttl_at = 1 WHERE id = ?').run(expired);
  T.store.p('UPDATE memory_entries SET ttl_at = 0 WHERE id = ?').run(zeroTtl);
  const pb = T.body(promoted);
  pb.promoted_to = 'some-row';
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(pb), promoted);
  T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(old, newer);

  const searchIds = async (caller, namespaces, extra = {}) => {
    const r = await T.call(caller, 'memory.search', { query_embedding: [1, 0, 0], mode: 'semantic', namespaces, k: 100, ...extra });
    return r.results.map(x => x.id).sort();
  };
  for (const namespaces of [[ns], [ns, arch]]) {
    // an ungated caller (the operator): nothing is hidden by a gate
    const op = T.who.operator('apply');
    const mine = MV.selectSearchable(T.store.db, TIER, { namespaces });
    assert.deepStrictEqual(mine.missing, [], 'every fixture row has the tier vector');
    assert.deepStrictEqual(mine.rows.map(r => r.id).sort(), await searchIds(op, namespaces), `operator, ${namespaces.join(' + ')}`);
    const expectIds = [live, held, refuted, promoted, pending, otherRun, zeroTtl, ...(namespaces.length > 1 ? [archived] : []), newer].sort();
    assert.deepStrictEqual(mine.rows.map(r => r.id).sort(), expectIds, 'an ungated caller sees live, held, refuted, promoted, pending, other-run and zero-ttl notes and the superseder; expired and superseded are not');
    assert.ok(!mine.rows.some(r => r.id === expired || r.id === old));
  }
  // a gated caller (it may not name archive/): its gate's hidden ids go in as `hidden`
  const tool = T.who.tool('apply');
  const hidden = gate.hiddenIds(T.E, tool, { includeSuperseded: true, body: false, namespaces: [ns] });
  assert.ok(hidden.includes(refuted) && hidden.includes(otherRun));
  const gated = MV.selectSearchable(T.store.db, TIER, { namespaces: [ns], hidden, bodyLive: true });
  assert.deepStrictEqual(gated.rows.map(r => r.id).sort(), await searchIds(tool, [ns]));
  for (const gone of [refuted, otherRun, promoted, pending]) assert.ok(!gated.rows.some(r => r.id === gone), 'a gated caller does not see ' + gone);
  assert.ok(MV.selectSearchable(T.store.db, TIER, { namespaces: [ns], hidden }).rows.some(r => r.id === promoted), 'without bodyLive a promoted note is still selected');
  // include_superseded is the same flag on both sides
  const withOld = MV.selectSearchable(T.store.db, TIER, { namespaces: [ns], includeSuperseded: true });
  assert.deepStrictEqual(withOld.rows.map(r => r.id).sort(), await searchIds(T.who.operator('apply'), [ns], { include_superseded: true }));
});
