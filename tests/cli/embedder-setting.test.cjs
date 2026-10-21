'use strict';
// embedder-setting.test.cjs — the run-spec handling of on_embedder_failure (ADR 0034 amendment 1) and the small function that persists
// the operator's choice in belay.config.json. Each value, the old names, the precedence (spec, memory block, config file, default), and
// a write that is atomic, keeps the other keys, and writes nothing when refused.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLevers } = require('../../src/cli/run-levers.cjs');

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-embsetting-'));
  fs.mkdirSync(path.join(d, '.git'));
  return d.split(path.sep).join('/');
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('the run spec: required is the default, each value is accepted, the old names map, anything else is refused', () => {
  assert.strictEqual(parseLevers({}).on_embedder_failure, 'required');
  for (const [given, canonical] of [['required', 'required'], ['keyword', 'keyword'], ['off', 'off'], ['stop', 'required'], ['continue', 'keyword']]) {
    assert.strictEqual(parseLevers({ on_embedder_failure: given }).on_embedder_failure, canonical, given);
    assert.strictEqual(parseLevers({ memory: { on_embedder_failure: given } }).on_embedder_failure, canonical, `memory.${given}`);
  }
  for (const bad of ['maybe', '', 3, null]) {
    assert.match(parseLevers({ on_embedder_failure: bad }).error, /^on_embedder_failure must be one of required, keyword, off/, String(bad));
    assert.match(parseLevers({ memory: { on_embedder_failure: bad } }).error, /^memory\.on_embedder_failure must be one of required, keyword, off/, String(bad));
  }
});

test('precedence: the spec, then the memory block, then the config file, then the default', () => {
  assert.strictEqual(parseLevers({ on_embedder_failure: 'off', memory: { on_embedder_failure: 'keyword' } }, { config: { path: 'c', memory: { on_embedder_failure: 'required' } } }).on_embedder_failure, 'off');
  assert.strictEqual(parseLevers({ memory: { on_embedder_failure: 'keyword' } }, { config: { path: 'c', memory: { on_embedder_failure: 'off' } } }).on_embedder_failure, 'keyword');
  assert.strictEqual(parseLevers({}, { config: { path: 'c', memory: { on_embedder_failure: 'off' } } }).on_embedder_failure, 'off');
  assert.strictEqual(parseLevers({}, { config: { path: 'c', memory: { on_embedder_failure: 'continue' } } }).on_embedder_failure, 'keyword');
  assert.match(parseLevers({}, { config: { path: 'c', memory: { on_embedder_failure: 'nonsense' } } }).error, /must be one of required, keyword, off/, 'an unusable config value is refused');
});

const C = require('../../src/cli/config.cjs');
const ST = require('../../src/cli/cmd-settings.cjs');
const K = 'memory.on_embedder_failure';
const write = (cwd, value) => ST.writeSetting(C.discover(cwd), K, value, { cwd });

test('the settings CLI lists memory.on_embedder_failure with its three values and writes it at the project root', async () => {
  const d = project();
  try {
    const listed = await ST.run({ argv: [], json: true, cwd: d });
    const row = listed.json.settings.find((r) => r.key === K);
    assert.ok(row, 'listed');
    assert.deepStrictEqual([row.value, row.source], ['required', 'default']);
    assert.deepStrictEqual(row.allowed, ['required', 'keyword', 'off']);
    fs.mkdirSync(`${d}/sub/dir`, { recursive: true });
    const first = write(`${d}/sub/dir`, 'keyword');
    assert.strictEqual(first.code, 0, first.text);
    assert.deepStrictEqual([first.json.path, first.json.created, first.json.new.value], [`${d}/belay.config.json`, true, 'keyword']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(first.json.path, 'utf8')), { memory: { on_embedder_failure: 'keyword' } });
    assert.strictEqual(write(d, 'maybe').code, 2, 'a bad value is a usage error');
    assert.strictEqual(parseLevers({}, { config: { path: 'c', memory: { on_embedder_failure: 'keyword' } } }).on_embedder_failure, 'keyword', 'and a run reads it back');
  } finally { rm(d); }
});

test('parseSpec reads the config mode from the cwd it is given, not the process cwd', () => {
  const d = project();
  try {
    fs.writeFileSync(`${d}/belay.config.json`, JSON.stringify({ memory: { on_embedder_failure: 'off' } }));
    fs.mkdirSync(`${d}/wt`);
    fs.writeFileSync(`${d}/prompt.txt`, 'p\n');
    fs.writeFileSync(`${d}/spec.json`, JSON.stringify({ worktree: `${d}/wt`, prompt_file: `${d}/prompt.txt` }));
    const spec = require('../../src/cli/run-spec.cjs').parseSpec(`${d}/spec.json`, d);
    assert.ok(!spec.error, spec.error);
    assert.strictEqual(spec.levers.on_embedder_failure, 'off');
    const other = require('../../src/cli/run-spec.cjs').parseSpec(`${d}/spec.json`, os.tmpdir());
    assert.notStrictEqual(other.levers && other.levers.on_embedder_failure, 'off');
  } finally { rm(d); }
});

test('the run record and the receipt agree: the resolved mode is recorded on its own, never inside memory_levers', () => {
  const { attachMemory } = require('../../src/cli/run-levers.cjs');
  const cfg = (memory) => ({ path: 'cfg/belay.config.json', memory });
  // spec top level required, config keyword: the run is required, and the row says nothing else about the mode
  const a = parseLevers({ on_embedder_failure: 'required' }, { config: cfg({ on_embedder_failure: 'keyword' }) });
  assert.strictEqual(a.on_embedder_failure, 'required');
  assert.ok(!a.memory_levers && !a.memory_sources, 'a config that sets only this lever makes no memory_levers');
  assert.deepStrictEqual(attachMemory(a), { memory_levers: null, project: null, memory_notice: 'memory_project_unset' }, 'and the run row carries none, as explicit nulls (and the launch notice)');
  // with another lever set, memory_levers exists, has no on_embedder_failure, and the source names the winner
  const b = parseLevers({ on_embedder_failure: 'required' }, { config: cfg({ on_embedder_failure: 'keyword', capture: true }) });
  assert.strictEqual(b.on_embedder_failure, 'required');
  assert.strictEqual(b.memory_levers.capture, true);
  assert.ok(!('on_embedder_failure' in b.memory_levers));
  assert.ok(!('on_embedder_failure' in JSON.parse(attachMemory(b).memory_levers)));
  assert.strictEqual(b.memory_sources.on_embedder_failure, 'spec');
  // config alone wins over the default and is its own source
  const c = parseLevers({ memory: { capture: true } }, { config: cfg({ on_embedder_failure: 'keyword' }) });
  assert.strictEqual(c.on_embedder_failure, 'keyword');
  assert.strictEqual(c.memory_sources.on_embedder_failure, 'cfg/belay.config.json');
  assert.strictEqual(parseLevers({ memory: { capture: true } }).memory_sources.on_embedder_failure, 'default');
});
