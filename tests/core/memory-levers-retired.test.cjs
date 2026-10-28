'use strict';
// memory-levers-retired.test.cjs — the note-review job's three levers were removed. A true note_review, or a model or a cost cap of any
// value, is refused loudly (spec, config, settings, run.attach); note_review false is accepted and stored nowhere; a run row written
// before the removal is still read, its three keys dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ML = require('../../src/core/memory-levers.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { leversOfRow } = require('../../src/run/memory-levers.cjs');
const settings = require('../../src/cli/cmd-settings.cjs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { teardown } = require('../helpers/teardown.cjs');

const MSG = /was removed \(2026-10-21\).*archive review.*Delete the key/;
const BASE = { project: 'acme', notes: true };

test('the spec refuses a true note_review, any model and any cap, naming the key', () => {
  for (const extra of [{ note_review: true }, { note_review_model: 'claude-haiku-5-5' }, { note_review_cost_cap_usd: 0.05 }, { note_review_model: null }]) {
    const r = ML.parseMemoryBlock({ ...BASE, ...extra });
    assert.match(r.error, MSG, JSON.stringify(extra));
    assert.ok(r.error.includes(`memory.${Object.keys(extra)[0]} was removed`), r.error);
  }
});

test('note_review false is accepted, and the parsed levers do not carry it', () => {
  const r = ML.parseMemoryBlock({ ...BASE, note_review: false });
  assert.ifError(r.error);
  for (const k of ML.RETIRED_KEYS) assert.ok(!(k in r.value), k);
  assert.ok(!Object.keys(ML.DEFAULTS).some((k) => k.startsWith('note_review')));
});

test('a config memory block with a retired lever is refused with the config path; note_review false is accepted and not recorded', () => {
  const cfg = (memory) => ({ path: '/p/belay.config.json', memory });
  const bad = parseLevers({}, { config: cfg({ ...BASE, note_review: true }) });
  assert.match(bad.error, MSG);
  assert.match(bad.error, /\/p\/belay\.config\.json/);
  const fine = parseLevers({}, { config: cfg({ ...BASE, note_review: false }) });
  assert.ifError(fine.error);
  assert.ok(!JSON.stringify(fine.memory_levers || {}).includes('note_review'), 'false is not recorded in the run row');
  const spec = parseLevers({ memory: { ...BASE, note_review_cost_cap_usd: 1 } }, { config: null });
  assert.match(spec.error, MSG);
});

test('belay settings: a truthy set leaves the config bytes unchanged, false says removed and writes nothing, get prints the message', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    const file = path.join(dir, 'belay.config.json');
    const bytes = `${JSON.stringify({ memory: { project: 'acme' } }, null, 2)}\n`;
    fs.writeFileSync(file, bytes);
    const ctx = (argv) => ({ argv, cwd: dir.split(path.sep).join('/'), json: false });
    for (const argv of [['memory.note_review', 'true'], ['memory.note_review_model', 'claude-haiku-5-5'], ['memory.note_review_cost_cap_usd', '0.05']]) {
      const r = await settings.run(ctx(argv));
      assert.strictEqual(r.code, 2, argv.join(' '));
      assert.match(r.text, MSG);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, 'the config is untouched');
    }
    const off = await settings.run(ctx(['memory.note_review', 'false']));
    assert.strictEqual(off.code, 0);
    assert.match(off.text, /was removed/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes);
    const got = await settings.run(ctx(['memory.note_review']));
    assert.strictEqual(got.code, 0);
    assert.match(got.text, MSG);
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('a run row written before the removal still reads: the three keys are dropped, notes and project kept', () => {
  const old = { ...ML.DEFAULTS, ...BASE, note_review: true, note_review_model: 'claude-haiku-5-5', note_review_cost_cap_usd: 0.05 };
  const lv = leversOfRow({ memory_levers: JSON.stringify(old) });
  assert.strictEqual(lv.notes, true);
  assert.strictEqual(lv.project, 'acme');
  for (const k of ML.RETIRED_KEYS) assert.ok(!(k in lv), k);
});

test('run.attach with a retired lever is E_ARGS and writes no run row', async () => {
  const dir = sandbox();
  const { Store } = core('store.cjs');
  const { Engine } = core('engine.cjs');
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: async () => null, owner: null, establishedBy: 'test' });
  const orch = callerFor('orchestrator', { run_id: 'r-ret' });
  let bodyError = null;
  try {
    const rowsOf = () => JSON.stringify(store.p('SELECT * FROM run').all());
    const before = rowsOf();
    await assert.rejects(E.handle('run.attach', { caller: orch, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ ...BASE, note_review: true }) }), (e) => e.code === 'E_ARGS' && MSG.test(e.message));
    assert.strictEqual(rowsOf(), before, 'no run row');
    const ok = await E.handle('run.attach', { caller: orch, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ ...BASE, note_review: false }) });
    assert.ok(!String(ok.run.memory_levers).includes('note_review'), 'false is not recorded');
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => store.close(), () => cleanup(dir)]); }
});
