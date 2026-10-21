'use strict';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (tests/core/spawn-register-isolation.test.cjs)
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// memory-search-log.test.cjs — `belay memory search-log --export` (ADR 0050 decision 7): the search log as JSON Lines, a read of the
// store copy that creates nothing in the store directory, the run and since filters, the refusal to overwrite, and the help text.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { setup, RUNS } = require('../core/lifecycle-env.cjs');
const SL = require('../../src/core/search-log.cjs');
const { Engine } = require('../../src/core/engine.cjs');
const R = require('../../src/cli/memory-render.cjs');
const { CLI } = require('./stop-helpers.cjs');

let T, outDir;
const listing = (d) => fs.readdirSync(d).sort().join(',');
before(async () => {
  T = await setup();
  const OWN = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: {} }, establishedBy: 'test' });
  const rec = (run, query, kind, extra = {}) => SL.record(OWN, T.who.tool(run), { kind, query, mode: 'semantic', k: 3, ranks: [{ id: 'n1', before: 2, after: 1 }], ms: { total: 4 }, ...extra });
  rec('plain', 'first query', 'search');
  rec('plain', 'index build', 'index');
  rec('apply', 'other run query', 'search');
  T.store.db.prepare("UPDATE memory_event SET written_at = 1000 WHERE seq = (SELECT MIN(seq) FROM memory_event WHERE kind = 'search')").run();
  outDir = fs.mkdtempSync(`${require('node:os').tmpdir()}/belay-sl-`);
});
after(async () => { await T.close(); fs.rmSync(outDir, { recursive: true, force: true }); });

const belay = (...args) => spawnSync(process.execPath, [CLI, 'memory', 'search-log', '--data', T.dir, '--json', ...args], { encoding: 'utf8', env: { ...process.env } });
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('exports every search and index event as one JSON object per line with its detail parsed', () => {
  const f = `${outDir}/all.jsonl`;
  const before = listing(T.dir);
  const r = belay('--export', f);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const evs = lines(f);
  assert.strictEqual(evs.length, 3);
  assert.deepStrictEqual(evs.map(e => e.kind), ['search', 'index', 'search']);
  assert.strictEqual(evs[0].detail.query, 'first query');
  assert.deepStrictEqual(evs[0].detail.ranks, [{ id: 'n1', before: 2, after: 1 }]);
  assert.strictEqual(evs[0].message, undefined, 'the raw message is replaced by detail');
  const receipt = JSON.parse(r.stdout);
  assert.strictEqual(receipt.count, 3);
  assert.strictEqual(receipt.bytes, fs.statSync(f).size);
  assert.strictEqual(listing(T.dir), before, 'a read creates no file in the store directory');
});

test('--run keeps one run, --since keeps the later events', () => {
  const a = `${outDir}/run.jsonl`, b = `${outDir}/since.jsonl`;
  assert.strictEqual(belay('--export', a, '--run', RUNS.apply).status, 0);
  assert.deepStrictEqual(lines(a).map(e => e.detail.query), ['other run query']);
  assert.strictEqual(belay('--export', b, '--since', '2000').status, 0);
  assert.strictEqual(lines(b).length, 2, 'the event stamped 1000 is older than the cut');
  assert.strictEqual(belay('--export', `${outDir}/bad.jsonl`, '--since', 'yesterday').status, 2);
});

test('an existing file is refused unless --force is given', () => {
  const f = `${outDir}/exists.jsonl`;
  fs.writeFileSync(f, 'keep me\n');
  const r = belay('--export', f);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(JSON.parse(r.stderr).error.code, 'E_EXISTS');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'keep me\n');
  assert.strictEqual(belay('--export', f, '--force').status, 0);
  assert.strictEqual(lines(f).length, 3);
});

test('--export is required, and the usage text lists the verb', () => {
  const r = spawnSync(process.execPath, [CLI, 'memory', 'search-log', '--data', T.dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /needs --export <file>/);
  assert.match(r.stderr, /search-log --export <file>/);
  assert.match(R.usageText(), /belay memory search-log --export <file> \[--run <id>\] \[--since <ms\|iso>\] \[--force\]/);
});
