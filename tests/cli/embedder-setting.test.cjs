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
const S = require('../../src/cli/embedder-setting.cjs');

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
  assert.strictEqual(parseLevers({ on_embedder_failure: 'off', memory: { on_embedder_failure: 'keyword' } }, { configMode: 'required' }).on_embedder_failure, 'off');
  assert.strictEqual(parseLevers({ memory: { on_embedder_failure: 'keyword' } }, { configMode: 'off' }).on_embedder_failure, 'keyword');
  assert.strictEqual(parseLevers({}, { configMode: 'off' }).on_embedder_failure, 'off');
  assert.strictEqual(parseLevers({}, { configMode: 'continue' }).on_embedder_failure, 'keyword');
  assert.strictEqual(parseLevers({}, { configMode: 'nonsense' }).on_embedder_failure, 'required', 'an unusable config value is ignored, not trusted');
});

const C = require('../../src/cli/config.cjs');
const K = S.CONFIG_KEY;
const write = (cwd, value, key = K) => S.writeSetting(C.discover(cwd), key, value, { cwd });

test('writeSetting: creates the config file at the project root, keeps other keys, and returns { code, text, json } with the old and new value', () => {
  const d = project();
  try {
    fs.mkdirSync(`${d}/sub/dir`, { recursive: true });
    const first = write(`${d}/sub/dir`, 'keyword');
    assert.strictEqual(first.code, 0);
    assert.deepStrictEqual(first.json, { key: K, path: `${d}/belay.config.json`, created: true, old: null, new: 'keyword' });
    assert.match(first.text, /memory\.on_embedder_failure: unset -> keyword/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(first.json.path, 'utf8')), { memory: { on_embedder_failure: 'keyword' } });
    fs.writeFileSync(first.json.path, JSON.stringify({ dataDir: '.belay', memory: { project: 'demo', on_embedder_failure: 'keyword' } }));
    const second = write(`${d}/sub`, 'off');
    assert.deepStrictEqual([second.code, second.json.created, second.json.old, second.json.new], [0, false, 'keyword', 'off']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(first.json.path, 'utf8')), { dataDir: '.belay', memory: { project: 'demo', on_embedder_failure: 'off' } });
    assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left');
    assert.strictEqual(write(d, 'continue').json.new, 'keyword', 'the old name is stored as the new');
    assert.strictEqual(S.readConfigMode(`${d}/sub`), 'keyword', 'and read back as a default for a run');
  } finally { rm(d); }
});

test('writeSetting refuses with code 2 and writes nothing: a bad key, a bad value, a block that does not validate, a broken file; a failed write is code 1', () => {
  const d = project();
  try {
    for (const bad of ['maybe', '', undefined, 'Off']) assert.strictEqual(write(d, bad).code, 2, String(bad));
    assert.strictEqual(write(d, 'off', 'memory.alpha').code, 2, 'a key it does not write');
    assert.match(write(d, 'maybe').json.error, /must be one of required, keyword, off/);
    assert.ok(!fs.existsSync(`${d}/belay.config.json`), 'a refused value creates no file');
    fs.writeFileSync(`${d}/belay.config.json`, JSON.stringify({ memory: { notes: true } })); // notes needs a project: the block does not validate
    const invalid = write(d, 'off');
    assert.strictEqual(invalid.code, 2);
    assert.match(invalid.json.error, /memory\.notes needs memory\.project/);
    fs.writeFileSync(`${d}/belay.config.json`, '{ not json');
    const broken = write(d, 'off');
    assert.strictEqual(broken.code, 2);
    assert.match(broken.json.error, /not valid JSON/);
    assert.strictEqual(fs.readFileSync(`${d}/belay.config.json`, 'utf8'), '{ not json', 'a broken file is left as it was');
    assert.strictEqual(S.readConfigMode(d), null);
    fs.writeFileSync(`${d}/belay.config.json`, '{"memory":{"on_embedder_failure":"keyword"}}');
    const real = S.seams.rename;
    S.seams.rename = () => { throw new Error('disk full'); };
    let failed;
    try { failed = write(d, 'off'); } finally { S.seams.rename = real; }
    assert.strictEqual(failed.code, 1);
    assert.match(failed.json.error, /disk full/);
    assert.strictEqual(JSON.parse(fs.readFileSync(`${d}/belay.config.json`, 'utf8')).memory.on_embedder_failure, 'keyword', 'a failed write leaves the old value');
    assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), [], 'and no temp file');
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
