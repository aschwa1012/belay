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
  const b = T.body(held);
  b.held = { row: 'h', kind: 'wrong', of: null, reason: 'x', run_id: 'r', at: 1 };
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), held);
  T.store.p('UPDATE memory_entries SET ttl_at = 1 WHERE id = ?').run(expired);
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
    const expectIds = [live, held, refuted, ...(namespaces.length > 1 ? [archived] : []), newer].sort();
    assert.deepStrictEqual(mine.rows.map(r => r.id).sort(), expectIds, 'live, held, refuted and the superseder are visible; expired and superseded are not');
    assert.ok(!mine.rows.some(r => r.id === expired || r.id === old));
  }
  // a gated caller (it may not name archive/): its gate's hidden ids go in as `hidden`
  const tool = T.who.tool('apply');
  const hidden = gate.hiddenIds(T.E, tool, { includeSuperseded: true, body: false, namespaces: [ns] });
  assert.ok(hidden.includes(refuted));
  const gated = MV.selectSearchable(T.store.db, TIER, { namespaces: [ns], hidden });
  assert.deepStrictEqual(gated.rows.map(r => r.id).sort(), await searchIds(tool, [ns]));
  assert.ok(!gated.rows.some(r => r.id === refuted), 'a gated caller does not see the refuted note');
  // include_superseded is the same flag on both sides
  const withOld = MV.selectSearchable(T.store.db, TIER, { namespaces: [ns], includeSuperseded: true });
  assert.deepStrictEqual(withOld.rows.map(r => r.id).sort(), await searchIds(T.who.operator('apply'), [ns], { include_superseded: true }));
});
