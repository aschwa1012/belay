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

test('a target inside the data directory is refused before anything is read, and nothing in the directory changes', () => {
  const snap = () => fs.readdirSync(T.dir).sort().map(n => `${n}:${fs.statSync(`${T.dir}/${n}`).size}`).join(',');
  const before = snap();
  for (const f of [`${T.dir}/memory.db`, `${T.dir}/new.jsonl`, `${T.dir}/sub/../memory.db`]) {
    const r = belay('--export', f, '--force');
    assert.strictEqual(r.status, 2, f + r.stderr);
    assert.strictEqual(JSON.parse(r.stderr).error.code, 'E_ARGS');
  }
  assert.strictEqual(snap(), before);
  assert.ok(fs.statSync(`${T.dir}/memory.db`).size > 0, 'the database is intact');
});

test('--force replaces a file through a temp file and leaves none behind', () => {
  const f = `${outDir}/forced.jsonl`;
  fs.writeFileSync(f, 'old\n');
  assert.strictEqual(belay('--export', f, '--force').status, 0);
  assert.strictEqual(lines(f).length, 3);
  assert.deepStrictEqual(fs.readdirSync(outDir).filter(n => n.includes('.tmp-')), []);
});

test('with a live owner the export reads a copy and never connects to the owner', async () => {
  const { Owner } = require('../../src/core/owner.cjs');
  const od = fs.mkdtempSync(`${require('node:os').tmpdir()}/belay-sl-own-`);
  const o = new Owner(od, { embed: false });
  await o.start();
  let connections = 0;
  o.server.on('connection', () => { connections += 1; });
  try {
    const f = `${outDir}/owned.jsonl`;
    const r = await new Promise((resolve) => {
      const c = require('node:child_process').spawn(process.execPath, [CLI, 'memory', 'search-log', '--data', od, '--json', '--export', f], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', d => { out += d; }); c.on('exit', code => resolve({ code, out }));
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(connections, 0, 'the owner was not asked');
    assert.strictEqual(JSON.parse(r.out).count, 0);
  } finally { await o.stop(); fs.rmSync(od, { recursive: true, force: true }); }
});

const BS = String.fromCharCode(92);
const SLC = require('../../src/cli/cmd-memory-searchlog.cjs');
const inProc = (file, extra = {}) => SLC.run({ cwd: outDir }, { opts: { export: file, ...extra } }, T.dir);

test('a file whose name merely starts with two dots, inside the data dir, is refused too', async () => {
  const r = await inProc(`${T.dir}/..foo.jsonl`);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.error.code, 'E_ARGS');
  assert.ok(!fs.existsSync(`${T.dir}/..foo.jsonl`));
});

test('a case variant, a junction and an 8.3 alias of the data directory are all refused', async (t) => {
  const os = require('node:os');
  const refusals = [];
  if (process.platform === 'win32') refusals.push([`${T.dir.toUpperCase()}/memory.db`, 'case variant']);
  const link = `${outDir}/junction`;
  fs.symlinkSync(T.dir, link, 'junction');
  refusals.push([`${link}/memory.db`, 'junction']);
  let short = null;
  if (process.platform === 'win32') {
    const cmd = `${outDir}/short.cmd`;
    fs.writeFileSync(cmd, ['@echo off', 'for %%I in ("%~1") do @echo %%~sI', ''].join(`${String.fromCharCode(13)}${String.fromCharCode(10)}`));
    const win = T.dir.split('/').join(BS);
    const out = spawnSync('cmd', ['/c', cmd, win], { encoding: 'utf8' }).stdout.trim();
    if (out && out.toLowerCase() !== win.toLowerCase() && /~d/.test(out)) short = out;
    if (short) refusals.push([`${short}${BS}memory.db`, '8.3 alias']);
  }
  const before = fs.statSync(`${T.dir}/memory.db`).size;
  for (const [f, what] of refusals) {
    const r = await inProc(f, { force: true });
    assert.strictEqual(r.code, 2, `${what}: ${f}`);
  }
  assert.strictEqual(fs.statSync(`${T.dir}/memory.db`).size, before);
  if (process.platform === 'win32' && !short) t.diagnostic('8.3 short names are disabled on this volume: the alias case was skipped');
  void os;
});

test('without hard links on the target volume the export falls back to an exclusive copy, and still refuses an existing file', async () => {
  const real = SLC.ops.linkSync;
  SLC.ops.linkSync = () => { throw Object.assign(new Error('no links here'), { code: 'EPERM' }); };
  try {
    const f = `${outDir}/nolink.jsonl`;
    const r = await inProc(f);
    assert.strictEqual(r.code, 0, JSON.stringify(r.json));
    assert.strictEqual(lines(f).length, 3);
    assert.deepStrictEqual(fs.readdirSync(outDir).filter(n => n.includes('.tmp-')), []);
    assert.strictEqual((await inProc(f)).code, 1, 'an existing file is still refused');
  } finally { SLC.ops.linkSync = real; }
});

test('a temp file left by a dead export of the same target is removed', async () => {
  const dead = `${outDir}/stale.jsonl.tmp-2147483000`, live = `${outDir}/stale.jsonl.tmp-${process.ppid}`;
  fs.writeFileSync(dead, 'x'); fs.writeFileSync(live, 'y');
  const rs = await inProc(`${outDir}/stale.jsonl`); assert.strictEqual(rs.code, 0, JSON.stringify(rs.json));
  assert.ok(!fs.existsSync(dead));
  assert.ok(fs.existsSync(live), 'a live pid\'s file is not touched');
  fs.rmSync(live);
});
