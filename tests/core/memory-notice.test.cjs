'use strict';
// The no-project notice: the helper's condition, that it is pure (nothing is loaded that a read path must not load), and the
// words it carries (the exact line to add and the name rule).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const N = require('../../src/core/memory-notice.cjs');

test('the notice holds when notes are on by default and no project is set', () => {
  for (const block of [undefined, {}, { project: null }, { project: '' }, { notes_match_n: 2 }, 'x', []]) {
    const n = N.noticeFor(block);
    assert.ok(n, JSON.stringify(block));
    assert.strictEqual(n.title, 'Notes are on, but no project is set, so this run keeps no notes');
    assert.ok(n.fix.includes('"memory": { "project": "<name>" }'));
    assert.ok(n.fix.includes('belay settings memory.project <name>'));
    assert.ok(n.fix.includes(N.NAME_RULE));
  }
});

test('the notice does not hold once a project is set, or when notes are explicitly off', () => {
  assert.strictEqual(N.noticeFor({ project: 'acme' }), null);
  assert.strictEqual(N.noticeFor({ project: 'acme', notes: true }), null);
  assert.strictEqual(N.noticeFor({ notes: false }), null);
  assert.strictEqual(N.noticeFor({ notes: false, project: null }), null);
});

test('memory: null is an explicit off and redact false with a project says why notes are off', () => {
  assert.strictEqual(N.noticeFor(null), null, 'memory: null turns notes off: nothing to warn about');
  const r = N.noticeFor({ project: 'acme', redact: false });
  assert.strictEqual(r.code, 'memory_redact_off');
  assert.ok(r.fix.includes('redact'), 'the fix names the lever');
  assert.strictEqual(N.noticeFor({ project: 'acme', redact: false, notes: false }), null, 'notes explicitly off: silent');
  assert.strictEqual(N.noticeFor({ redact: false }).code, 'memory_project_unset', 'no project: the project is the first thing missing');
});

test('a run row with notes on suppresses the config notice; one with none or off does not', () => {
  const cfgNoProject = { found: true, config: {} };
  const cfgProject = { found: true, config: { memory: { project: 'acme' } } };
  // a run answers for itself, whatever the config says: its recorded code, or none
  assert.strictEqual(N.noticeForRun({ memory_notice: null }, cfgNoProject), null, 'notes on, explicitly off or memory null: silent even when the config has no project');
  assert.strictEqual(N.noticeForRun({ memory_notice: N.CODE }, cfgProject).code, N.CODE, 'launched without a project: the warning stays after the config gains one');
  assert.strictEqual(N.noticeForRun({ memory_notice: N.REDACT_CODE }, cfgProject).code, N.REDACT_CODE, 'redaction off stays named');
  assert.strictEqual(N.noticeForRun({ memory_notice: 'unknown_code' }, cfgNoProject), null, 'a code this build does not know is no notice');
  assert.strictEqual(N.noticeForRun({}, cfgNoProject), null, 'a run from before the column has none');
  // no run selected: the config's notice
  assert.ok(N.noticeForRun(null, cfgNoProject));
  assert.strictEqual(N.noticeForRun(null, cfgProject), null);
  assert.deepStrictEqual(N.CODES, [N.CODE, N.REDACT_CODE]);
  for (const c of N.CODES) assert.strictEqual(N.byCode(c).code, c);
});

test('from a discovered config: no file, an empty file and a file with a project', () => {
  assert.ok(N.noticeForConfig({ found: false }));
  assert.ok(N.noticeForConfig({ found: true, config: {} }));
  assert.ok(N.noticeForConfig({ found: true, config: { memory: { rules: true } } }));
  assert.strictEqual(N.noticeForConfig({ found: true, config: { memory: { project: 'acme' } } }), null);
});

test('the project name rule in the notice is the rule the levers enforce', () => {
  const ML = require('../../src/core/memory-levers.cjs');
  const re = new RegExp(N.NAME_RULE);
  assert.ok(re.test('acme') && re.test('a.b_c-1') && !re.test('Acme') && !re.test('-a'));
  assert.strictEqual(ML.parseMemoryBlock({ project: 'acme' }).error, undefined);
  assert.ok(ML.parseMemoryBlock({ project: 'Acme' }).error);
});

test('the helper requires nothing, so no read path that loads it reaches the embedder', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'memory-notice.cjs'), 'utf8');
  assert.deepStrictEqual(src.match(/require\(/g), null);
});

test('the read commands that show the notice load no embedder module', () => {
  require('../../src/cli/cmd-settings.cjs');
  require('../../src/cli/cmd-doctor.cjs');
  require('../../src/cli/cmd-status.cjs');
  require('../../src/cli/run-levers.cjs');
  const hit = Object.keys(require.cache).filter((k) => /[\/]src[\/]core[\/]embedder\.cjs$/i.test(k) || /transformers/i.test(k));
  assert.deepStrictEqual(hit, []);
});

test('every notice carries a compact one-line fix for the panel, from the same source as the full text', () => {
  const n = N.noticeFor({});
  assert.strictEqual(n.short, 'set one: belay settings memory.project <name> · or turn notes off: belay settings memory.notes false');
  assert.ok(n.fix.includes('belay settings memory.project <name>') && n.fix.includes('belay settings memory.notes false'), 'the full fix names the same two commands');
  const r = N.noticeFor({ project: 'acme', redact: false });
  assert.ok(r.short.includes('redact') && r.short.includes('belay settings memory.notes false') && !r.short.includes('\n'));
  for (const c of N.CODES) assert.ok(N.byCode(c).short.length < 120, c);
});
