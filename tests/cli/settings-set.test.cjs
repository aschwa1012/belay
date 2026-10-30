'use strict';
require('../helpers/tmp.cjs');
// settings-set.test.cjs — `belay settings --set <key> <value> [--set <key> <value>]...` (ADR 0050 amendment 3): argv shapes, an odd count, a repeated
// key, a created file, a conflict, the final block judged once, and the old value's invalid mark kept in the receipt.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../../src/cli/cmd-settings.cjs');

const fwd = (p) => String(p).split('\\').join('/');
const realSeams = { ...settings.seams };
const reset = () => Object.assign(settings.seams, realSeams);
function project() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-setset-')));
  fs.mkdirSync(`${dir}/.git`);
  return dir;
}
const run = (cwd, argv) => settings.run({ argv, cwd, json: true });
const file = (dir) => `${dir}/belay.config.json`;
const read = (dir) => JSON.parse(fs.readFileSync(file(dir), 'utf8'));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('--set writes several keys with one rename and returns each old and new value', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), JSON.stringify({ memory: { project: 'acme' } }));
    const r = await run(dir, ['--set', 'memory.routing', '{"reviewer":"gpu-rerank"}', '--set', 'memory.routing_cpu', '{"reviewer":"cpu-rerank"}', '--set', 'mod.band', 'minimal']);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(r.json.keys, ['memory.routing', 'memory.routing_cpu', 'mod.band']);
    assert.deepStrictEqual(r.json.results.map((x) => [x.key, x.old.value, x.new.value]), [['memory.routing', null, { reviewer: 'gpu-rerank' }], ['memory.routing_cpu', null, { reviewer: 'cpu-rerank' }], ['mod.band', 'two-lines', 'minimal']]);
    assert.strictEqual(r.json.created, false);
    assert.deepStrictEqual(read(dir), { memory: { project: 'acme', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank' } }, mod: { band: 'minimal' } });
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.git', 'belay.config.json'], 'no temp file left');
  } finally { clean(dir); }
});

test('--set with no file creates it, once', async () => {
  const dir = project();
  try {
    const r = await run(dir, ['--set', 'mod.pane', 'above-prompt', '--set', 'mod.band', 'one-line']);
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(r.json.created, true);
    assert.deepStrictEqual(read(dir), { mod: { pane: 'above-prompt', band: 'one-line' } });
  } finally { clean(dir); }
});

test('argv shapes: a lone --set, an odd count, a stray word and a missing value are usage errors and write nothing', async () => {
  const dir = project();
  try {
    for (const argv of [['--set'], ['--set', 'mod.pane'], ['--set', 'mod.pane', 'docked', '--set'], ['--set', 'mod.pane', 'docked', 'mod.band', 'minimal'], ['--set', 'mod.pane', 'docked', '--set', 'mod.band']]) {
      const r = await run(dir, argv);
      assert.strictEqual(r.code, 2, JSON.stringify(argv));
      assert.match(r.json.error, /--set takes a key and a value each time/);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), ['.git'], 'nothing was created');
  } finally { clean(dir); }
});

test('a repeated key is a usage error before anything is written, even when both values are good', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), JSON.stringify({ mod: { band: 'minimal' } }));
    const before = fs.readFileSync(file(dir), 'utf8');
    const r = await run(dir, ['--set', 'mod.pane', 'docked', '--set', 'mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 2);
    assert.match(r.json.error, /mod\.pane is given twice; nothing was written/);
    assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), before);
  } finally { clean(dir); }
});

test('an unknown key or a bad value refuses the whole set', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), '{}');
    for (const argv of [['--set', 'mod.pane', 'docked', '--set', 'nope.key', 'x'], ['--set', 'mod.pane', 'docked', '--set', 'mod.band', 'sideways'], ['--set', 'mod.pane', 'docked', '--set', 'memory.rerank_depth', '999']]) {
      const r = await run(dir, argv);
      assert.strictEqual(r.code, 2, JSON.stringify(argv));
      assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), '{}', 'the good first pair was not written either');
    }
  } finally { clean(dir); }
});

test('the FINAL block is judged once: a prerequisite may come from a later pair, and a bad final block refuses all', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), '{}');
    // notes needs a project: given in the other order than the dependency, the set is still fine
    const ok = await run(dir, ['--set', 'memory.notes', 'true', '--set', 'memory.project', 'acme']);
    assert.strictEqual(ok.code, 0, ok.text);
    assert.deepStrictEqual(read(dir).memory, { notes: true, project: 'acme' });
    const before = fs.readFileSync(file(dir), 'utf8');
    const bad = await run(dir, ['--set', 'memory.project', 'null', '--set', 'mod.pane', 'docked']);
    assert.strictEqual(bad.code, 2);
    assert.match(bad.json.error, /memory\.notes needs memory\.project/);
    assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), before, 'the pane key was not written either');
  } finally { clean(dir); }
});

test('the receipt keeps an old value\'s invalid mark', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), JSON.stringify({ mod: { band: 'sideways' } }));
    const r = await run(dir, ['--set', 'mod.band', 'minimal']);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.json.results[0].old.invalid, 'the stored sideways value was invalid');
    assert.strictEqual(r.json.results[0].new.value, 'minimal');
  } finally { clean(dir); }
});

test('a file that changes between the read and the rename is a conflict: nothing of the set is written', async () => {
  const dir = project();
  try {
    fs.writeFileSync(file(dir), JSON.stringify({ mod: { band: 'minimal' } }));
    const theirs = JSON.stringify({ theirs: true });
    settings.seams.beforeRename = (f) => fs.writeFileSync(f, theirs);
    const r = await run(dir, ['--set', 'mod.pane', 'above-prompt', '--set', 'mod.band', 'one-line']);
    assert.strictEqual(r.code, 1);
    assert.match(r.json.error, /changed while it was being updated/);
    assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), theirs);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.git', 'belay.config.json']);
  } finally { reset(); clean(dir); }
});
