'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// What a run spec's memory block inherits from the config file's (audit L23): an explicit `memory: null` is "no block" (defaults
// only), and a spec that turns notes off drops the notes-dependent levers it would inherit rather than being refused for them.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLevers, mergeMemory, memoryText } = require('../../src/cli/run-levers.cjs');
const ML = require('../../src/core/memory-levers.cjs');

const CFG = { path: '/p/belay.config.json', memory: { project: 'acme', notes: true, note_review: true, notes_reflection: true, notes_sink: 'record', on_embedder_failure: 'stop' } };
const lv = (memory, config = CFG, extra = {}) => parseLevers({ ...(memory === undefined ? {} : { memory }), ...extra }, { config });

test('an absent memory block and an empty one inherit the config; the sources name the file', () => {
  for (const spec of [undefined, {}]) {
    const l = lv(spec);
    assert.ifError(l.error);
    assert.deepStrictEqual([l.memory_levers.notes, l.memory_levers.project, l.memory_levers.note_review], [true, 'acme', true]);
    assert.strictEqual(l.memory_sources.notes, CFG.path);
  }
});

test('an explicit memory: null is no block: every lever at its default, nothing inherited, the config named nowhere', () => {
  const l = lv(null);
  assert.ifError(l.error);
  assert.strictEqual(l.memory_levers, undefined, 'a default block records none');
  assert.strictEqual(l.memory_sources, undefined);
  assert.strictEqual(l.memory_dropped, undefined);
  const m = mergeMemory(null, CFG);
  assert.strictEqual(m.block, undefined);
  assert.ok(Object.values(m.sources).every((s) => s === 'default'));
  assert.deepStrictEqual(Object.keys(m.sources), Object.keys(ML.DEFAULTS));
  // a config that sets only on_embedder_failure does not reach a run that said "no block" either
  const only = { path: '/p/c.json', memory: { on_embedder_failure: 'continue' } };
  assert.strictEqual(parseLevers({}, { config: only }).on_embedder_failure, 'keyword');
  assert.strictEqual(parseLevers({ memory: null }, { config: only }).on_embedder_failure, ML.DEFAULTS.on_embedder_failure);
  // the spec's own top-level lever still applies
  assert.strictEqual(parseLevers({ memory: null, on_embedder_failure: 'stop' }, { config: only }).on_embedder_failure, 'required');
});

test('notes: false in the spec drops the notes-dependent levers inherited from the config, and says which', () => {
  const l = lv({ notes: false });
  assert.ifError(l.error);
  assert.strictEqual(l.memory_levers.notes, false);
  assert.deepStrictEqual([l.memory_levers.note_review, l.memory_levers.notes_reflection, l.memory_levers.notes_sink], [false, false, 'off']);
  assert.strictEqual(l.memory_levers.project, 'acme', 'levers that do not need notes are still inherited');
  assert.deepStrictEqual(l.memory_dropped.slice().sort(), ['note_review', 'notes_reflection', 'notes_sink']);
  assert.strictEqual(l.memory_sources.note_review, 'default');
  assert.strictEqual(l.memory_sources.project, CFG.path);
  assert.strictEqual(l.memory_sources.notes, 'spec');
  assert.match(memoryText(l), /config levers dropped by notes false: .*note_review/);
});

test('a notes-dependent lever the spec itself sets beside notes: false is still refused', () => {
  const l = lv({ notes: false, note_review: true });
  assert.match(l.error, /memory\.note_review needs memory\.notes/);
  const noConfig = parseLevers({ memory: { notes: false, note_review: true } }, { config: null });
  assert.match(noConfig.error, /memory\.note_review needs memory\.notes/);
});

test('without notes: false nothing is dropped, and a config that is invalid on its own is still refused', () => {
  assert.strictEqual(lv({ alpha: 0.7 }).memory_dropped, undefined);
  const bad = parseLevers({ memory: { alpha: 0.7 } }, { config: { path: '/p/c.json', memory: { note_review: true } } });
  assert.match(bad.error, /memory\.note_review needs memory\.notes/);
});
