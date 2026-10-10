'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// memory-export-import.test.cjs — `belay memory export` and `belay memory import` (ADR 0043 section 3).
//
// Most cases run the command module in process against a fake core (the `ctx.openCore` seam that
// tests/cli/memory.test.cjs's production code honours under BELAY_TEST_MODE), so a case controls exactly
// what memory.store answers and what it was asked. The fake store does what ADR 0040 says memory.store
// does for an import: it redacts secrets, keeps title/type/body/tags, stamps source and provenance, never
// takes a status from the caller, and converges on (namespace, text).
//
// Cases marked REAL run the real core. Their assertions that depend on the write path of ADR 0040
// (title, body, source and redaction stored) hold only once memory.store has it, so they run when the
// store's source mentions redaction and are reported as skipped until then.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const memory = require('../../src/cli/cmd-memory.cjs');
const R = require('../../src/cli/memory-render.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const REAL_WRITE_PATH = /redact/i.test(fs.readFileSync(`${ROOT}/src/core/methods-memory.cjs`, 'utf8'));
const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const SECRET = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-'); // assembled, so the public-export scan does not read it as a leak

// ---- the fake core -----------------------------------------------------------------------------------------

function fakeCore(seedRows = []) {
  const rows = new Map(seedRows.map(r => [r.id, { status: 'unverified', ...r }]));
  const calls = { store: [], list: [], shutdown: 0, closed: 0 };
  let n = 0;
  const core = {
    rows, calls,
    run: { list: async () => ({ runs: [] }) },
    memory: {
      store: async (a) => {
        calls.store.push(a);
        if (a.text.includes('EXPLODE')) { const e = new Error('the embedder fell over'); e.code = 'E_TIMEOUT'; throw e; }
        const text = a.text.split(SECRET).join('[REDACTED:anthropic_key]');
        const dup = [...rows.values()].find(r => r.namespace === a.namespace && r.text === text);
        if (dup) { Object.assign(dup, { type: a.type || dup.type, tags: a.tags || dup.tags, provenance: a.provenance }); return { id: dup.id, action: 'updated', namespace: a.namespace }; }
        const id = `m-${(n += 1)}`;
        rows.set(id, { id, namespace: a.namespace, text, type: a.type || 'fact', title: a.title || null, body: a.body || null, tags: a.tags || null,
          status: 'unverified', source: a.source, provenance: a.provenance, has_embedding: !a.embed === false, created_at: 1000 + n });
        return { id, action: 'inserted', namespace: a.namespace };
      },
      list: async (a) => {
        calls.list.push(a);
        const ns = a.namespaces || [a.namespace];
        const since = a.filter && a.filter.since_ms;
        const all = [...rows.values()].filter(r => ns.includes(r.namespace) && (since === undefined || r.created_at >= since))
          .sort((x, y) => x.created_at - y.created_at);
        const page = all.slice(a.offset || 0, (a.offset || 0) + Math.min(a.limit || 50, 500));
        return { rows: page.map(r => ({ id: r.id })), total: all.length };
      },
      get_many: async ({ ids }) => {
        if (ids.length > 50) throw new Error('get_many takes at most 50 ids');
        return { rows: ids.map(id => (rows.has(id) ? { ...rows.get(id), found: true } : { id, found: false })), found: 0, missing: [] };
      },
    },
    isOwner: () => true,
    shutdownOwner: async () => { calls.shutdown += 1; },
    close: async () => { calls.closed += 1; },
  };
  return core;
}

async function run(dir, argv, core) {
  let opened = 0;
  const ctx = { argv, cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: true, json: false, openCore: async () => { opened += 1; return core; } };
  const r = await memory.run(ctx);
  return { ...r, opened };
}

const seed = () => [
  { id: 'a1', namespace: 'run/r1', type: 'finding', title: 'TZ is read at load', text: 'src/dates.cjs reads TZ at module load', tags: ['tz'], body: { file: 'src/dates.cjs' }, status: 'verified', status_receipt: 'test:x', created_at: 10 },
  { id: 'a2', namespace: 'run/r1', type: 'decision', title: null, text: 'use stable() for output', tags: null, body: null, created_at: 20 },
  { id: 'a3', namespace: 'run/r1', type: 'fact', title: 'third', text: 'third row text', tags: ['x', 'y'], body: null, created_at: 30 },
];

const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l));

// ---- export ------------------------------------------------------------------------------------------------

test('export: a header line, then the full rows oldest first, no vectors; the same rows give the same bytes', async () => {
  const dir = sandbox();
  try {
    const core = fakeCore(seed().map(r => ({ ...r, has_embedding: true })));
    const a = await run(dir, ['export', '--namespace', 'run/r1'], core);
    assert.strictEqual(a.code, 0);
    const [header, ...rows] = lines(a.text);
    assert.deepStrictEqual(header, { export: 1, written_by: 'operator', schema_version: 1, count: 3 });
    assert.deepStrictEqual(rows.map(r => r.id), ['a1', 'a2', 'a3']);
    assert.strictEqual(rows[0].text, 'src/dates.cjs reads TZ at module load');
    assert.deepStrictEqual(rows[0].body, { file: 'src/dates.cjs' });
    for (const r of rows) { assert.ok(!('has_embedding' in r) && !('embedding' in r) && !('found' in r), 'no vector and no read-side fields'); }
    const b = await run(dir, ['export', '--namespace', 'run/r1'], core);
    assert.strictEqual(b.text, a.text, 'no clock in the output');
    assert.deepStrictEqual(a.json.header, header);
    assert.strictEqual(a.json.rows.length, 3);
  } finally { cleanup(dir); }
});

test('export: --since filters by created_at, --out writes the file and a receipt, and an existing file is never overwritten', async () => {
  const dir = sandbox();
  try {
    const core = fakeCore(seed());
    const r = await run(dir, ['export', '--namespace', 'run/r1', '--since', '20', '--out', 'seed.jsonl'], core);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(core.calls.list[0].filter, { since_ms: 20 });
    const file = fs.readFileSync(`${dir}/seed.jsonl`);
    assert.deepStrictEqual(lines(file.toString()).map(x => x.id || x.count), [2, 'a2', 'a3']);
    assert.strictEqual(r.json.sha256, crypto.createHash('sha256').update(file).digest('hex'));
    assert.strictEqual(r.json.bytes, file.length);
    assert.match(r.text, /exported 2 rows to .*seed\.jsonl/);
    const again = await run(dir, ['export', '--namespace', 'run/r1', '--out', 'seed.jsonl'], core);
    assert.strictEqual(again.code, 1);
    assert.match(again.text, /exists; export never overwrites/);
    assert.deepStrictEqual(fs.readFileSync(`${dir}/seed.jsonl`), file, 'the first file is untouched');
  } finally { cleanup(dir); }
});

test('export: more rows than one list page and one get_many chunk are all exported once', async () => {
  const dir = sandbox();
  try {
    const many = Array.from({ length: 1203 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, namespace: 'project/p', type: 'fact', text: `row ${i}`, created_at: i }));
    const core = fakeCore(many);
    const r = await run(dir, ['export', '--namespace', 'project/p'], core);
    assert.strictEqual(r.code, 0);
    const [header, ...rows] = lines(r.text);
    assert.strictEqual(header.count, 1203);
    assert.deepStrictEqual(rows.map(x => x.id), many.map(x => x.id));
    assert.strictEqual(core.calls.list.length, 3, 'three pages of at most 500');
  } finally { cleanup(dir); }
});

// ---- import ------------------------------------------------------------------------------------------------

test('import: round trip. An export imports into another store with the namespace map applied, type/title/body/tags kept, source operator, provenance from the file hash and the original id, status not imported', async () => {
  const dir = sandbox();
  try {
    await run(dir, ['export', '--namespace', 'run/r1', '--out', 'x.jsonl'], fakeCore(seed()));
    const sha12 = crypto.createHash('sha256').update(fs.readFileSync(`${dir}/x.jsonl`)).digest('hex').slice(0, 12);
    const target = fakeCore();
    const r = await run(dir, ['import', 'x.jsonl', '--namespace-map', 'run/r1=project/tally'], target);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.inserted, r.json.updated, r.json.refused], [3, 0, []]);
    assert.strictEqual(r.json.status_ignored, 1, 'the verified row carried a status that was not imported');
    assert.match(r.text, /inserted: 3  updated: 0  refused: 0  status ignored on 1 row/);
    const stored = [...target.rows.values()];
    assert.deepStrictEqual(stored.map(x => x.namespace), ['project/tally', 'project/tally', 'project/tally']);
    const a1 = stored[0];
    assert.deepStrictEqual([a1.type, a1.title, a1.tags, a1.body], ['finding', 'TZ is read at load', ['tz'], { file: 'src/dates.cjs' }]);
    assert.strictEqual(a1.source, 'operator');
    assert.strictEqual(a1.provenance, `import:${sha12}:a1`);
    assert.ok(stored.every(x => x.status === 'unverified'), 'a verified row arrives unverified');
    assert.ok(target.calls.store.every(a => !('status' in a) && !('id' in a) && !('created_at' in a)), 'no status, id or time is passed to memory.store');
    assert.strictEqual(r.json.rows.length, 3);
    assert.deepStrictEqual(r.json.rows.map(x => x.action), ['inserted', 'inserted', 'inserted']);
    assert.strictEqual(target.calls.shutdown, 1, 'the owner this command elected is shut down');
    assert.strictEqual(target.calls.closed, 1);

    const again = await run(dir, ['import', 'x.jsonl', '--namespace-map', 'run/r1=project/tally'], target);
    assert.deepStrictEqual([again.json.inserted, again.json.updated], [0, 3], 'importing twice converges on the same rows');
    assert.strictEqual(target.rows.size, 3);
  } finally { cleanup(dir); }
});

test('import: redaction is the core\'s, applied to what the file holds (the store sees the raw line; the fake redacts as ADR 0040 says; REAL variant below)', async () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(`${dir}/s.jsonl`, `${JSON.stringify({ namespace: 'project/t', type: 'finding', text: `calls need key ${SECRET} to work` })}\n`);
    const target = fakeCore();
    const r = await run(dir, ['import', 's.jsonl'], target);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(target.calls.store[0].text.includes(SECRET), 'the CLI hands the text to memory.store unchanged: redaction is not done twice or skipped here');
    const row = [...target.rows.values()][0];
    assert.ok(!row.text.includes(SECRET));
    assert.match(row.text, /\[REDACTED:anthropic_key\]/);
  } finally { cleanup(dir); }
});

test('import: a header-less seed file, --namespace as the default, --no-embed, and rows the file cannot make are listed by line', async () => {
  const dir = sandbox();
  try {
    const file = [
      JSON.stringify({ type: 'finding', title: 'one', text: 'first seed' }), // no namespace: the default
      '{ not json',
      JSON.stringify({ namespace: 'project/t', type: 'fact' }), // no text
      '',
      JSON.stringify({ namespace: 'project/t', text: 'EXPLODE in the store' }),
      JSON.stringify({ namespace: 'project/t', text: 'x', tags: 'not-an-array' }),
      JSON.stringify({ namespace: 'project/t', text: 'y', body: [1] }),
      JSON.stringify([1, 2]),
      JSON.stringify({ text: 'z', status: 'verified' }), // default ns, status ignored
    ].join('\n');
    fs.writeFileSync(`${dir}/seed.jsonl`, file);
    const target = fakeCore();
    const r = await run(dir, ['import', 'seed.jsonl', '--namespace', 'project/default', '--no-embed'], target);
    assert.strictEqual(r.code, 1, 'a refused line makes the exit non-zero');
    assert.deepStrictEqual([r.json.inserted, r.json.updated], [2, 0]);
    assert.deepStrictEqual(r.json.refused.map(x => [x.line, x.code]), [[2, 'E_PARSE'], [3, 'E_ARGS'], [5, 'E_TIMEOUT'], [6, 'E_ARGS'], [7, 'E_ARGS'], [8, 'E_ARGS']]);
    assert.match(r.json.refused[1].message, /text must be a non-empty string/);
    assert.match(r.text, /refused line 5: E_TIMEOUT \(the embedder fell over\)/);
    assert.deepStrictEqual([...target.rows.values()].map(x => x.namespace), ['project/default', 'project/default']);
    assert.ok(target.calls.store.filter(a => a.text !== 'EXPLODE in the store').every(a => a.embed === false), '--no-embed passes embed: false');
    assert.strictEqual(r.json.status_ignored, 1);
  } finally { cleanup(dir); }
});

test('import: without --no-embed the store is asked to embed (no embed argument at all)', async () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(`${dir}/e.jsonl`, `${JSON.stringify({ namespace: 'project/t', text: 'embed me' })}\n`);
    const target = fakeCore();
    await run(dir, ['import', 'e.jsonl'], target);
    assert.ok(!('embed' in target.calls.store[0]));
  } finally { cleanup(dir); }
});

test('import: a missing file, an empty file, an unsupported header and a newer schema fail before any store is opened', async () => {
  const dir = sandbox();
  try {
    const target = fakeCore();
    const cases = [
      [['import', 'nope.jsonl'], /cannot read .*nope\.jsonl: ENOENT/, null],
      [['import', 'empty.jsonl'], /holds no rows/, ''],
      [['import', 'only-header.jsonl'], /holds no rows/, `${JSON.stringify({ export: 1, written_by: 'operator', schema_version: 1, count: 0 })}\n`],
      [['import', 'v2.jsonl'], /unsupported export version 2/, `${JSON.stringify({ export: 2, schema_version: 1 })}\n${JSON.stringify({ text: 'a', namespace: 'n' })}\n`],
      [['import', 'new.jsonl'], /schema 9, newer than this build's 1/, `${JSON.stringify({ export: 1, schema_version: 9 })}\n${JSON.stringify({ text: 'a', namespace: 'n' })}\n`],
    ];
    for (const [argv, re, content] of cases) {
      if (content !== null) fs.writeFileSync(`${dir}/${argv[1]}`, content);
      const r = await run(dir, argv, target);
      assert.strictEqual(r.code, 1, argv.join(' '));
      assert.match(r.text, re);
      assert.strictEqual(r.opened, 0, `${argv[1]}: no core was opened`);
    }
    assert.strictEqual(target.calls.store.length, 0);
  } finally { cleanup(dir); }
});

test('import and export: usage errors exit 2 and open nothing', async () => {
  const dir = sandbox();
  try {
    const target = fakeCore();
    for (const argv of [
      ['import'], ['import', 'a', 'b'], ['import', 'a', '--namespace-map', 'nope'], ['import', 'a', '--namespace-map', '=x'], ['import', 'a', '--namespace-map', 'x='],
      ['import', 'a', '--namespace-map', 'x=y', '--namespace-map', 'x=z'], ['import', 'a', '--namespace', 'p', '--namespace', 'q'], ['import', 'a', '--out', 'b'],
      ['export', '--no-embed'], ['export', '--namespace-map', 'a=b'], ['export', '--since', 'yesterday'], ['export', '--out'], ['export', 'a', 'b'],
    ]) {
      const r = await run(dir, argv, target);
      assert.strictEqual(r.code, 2, argv.join(' '));
      assert.strictEqual(r.opened, 0);
    }
  } finally { cleanup(dir); }
});

test('mapNamespace: an exact match, else the longest mapped prefix, else the row\'s own', () => {
  const m = new Map([['run/r1', 'project/tally'], ['run', 'old'], ['seed', 'project/seed'], ['seed/deep', 'x']]);
  assert.strictEqual(R.mapNamespace('run/r1', m), 'project/tally');
  assert.strictEqual(R.mapNamespace('run/r2', m), 'old/r2');
  assert.strictEqual(R.mapNamespace('seed/a/b', m), 'project/seed/a/b');
  assert.strictEqual(R.mapNamespace('seed/deep/z', m), 'x/z');
  assert.strictEqual(R.mapNamespace('seeded', m), 'seeded', 'a prefix must end at a slash');
  assert.strictEqual(R.mapNamespace('project/other', m), 'project/other');
});

// ---- the real core -----------------------------------------------------------------------------------------

async function plantReal(dataDir) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-x', pid: process.pid } });
  const ids = [];
  try {
    await core.run.attach({ adapter_pid: process.pid });
    for (const [i, text] of ['first finding about dates', 'second finding about money', 'third, with a tag'].entries()) {
      const s = await core.memory.store({ namespace: 'run/run-x', text, type: i === 1 ? 'decision' : 'finding', tags: i === 2 ? ['t'] : undefined, embedding: vec(i), embedding_model: 'fixture', dim: 384 });
      ids.push(s.id);
    }
  } finally { await core.shutdownOwner(); await core.close(); }
  return ids;
}

// The real core answers import's stores with a supplied vector, so no model is needed. Everything else the
// command sends reaches the real memory.store.
function realWithVectors(dataDir) {
  return async (opts) => {
    const core = await openCore(opts);
    const store = core.memory.store.bind(core.memory);
    let n = 0;
    core.memory.store = (a) => store({ ...a, embedding: vec((n += 1) + 10), embedding_model: 'fixture', dim: 384 });
    return core;
  };
}

test('REAL export: a dead store is read from its copy, creating nothing, and the rows come out whole without vectors', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const ids = await plantReal(dataDir);
    const before = listRecursive(dataDir);
    const r = spawnSync(process.execPath, [CLI, 'memory', 'export', 'run-x', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.deepStrictEqual(listRecursive(dataDir), before, 'reading never writes');
    const [header, ...rows] = lines(r.stdout);
    assert.strictEqual(header.count, 3);
    assert.deepStrictEqual(rows.map(x => x.id).sort(), [...ids].sort());
    assert.deepStrictEqual(rows.map(x => x.text), ['first finding about dates', 'second finding about money', 'third, with a tag']);
    assert.deepStrictEqual(rows.map(x => x.type), ['finding', 'decision', 'finding']);
    for (const x of rows) assert.ok(!('embedding' in x) && !('has_embedding' in x));
  } finally { cleanup(dir); }
});

test('REAL import: an exported file round trips into another data dir through the real memory.store', async () => {
  const dir = sandbox();
  try {
    await plantReal(`${dir}/a/.belay`);
    const out = spawnSync(process.execPath, [CLI, 'memory', 'export', 'run-x', '--out', `${dir}/x.jsonl`, '--data', `${dir}/a/.belay`], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    const target = `${dir}/b/.belay`;
    const ctx = { argv: ['import', `${dir}/x.jsonl`, '--namespace-map', 'run/run-x=project/tally'], cwd: dir, dataDir: target, dataDirGiven: true, json: false, openCore: realWithVectors(target) };
    const r = await memory.run(ctx);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.inserted, r.json.updated, r.json.refused.length], [3, 0, 0]);

    const core = await openCore({ dataDir: target, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    try {
      const { rows } = await core.memory.list({ namespace: 'project/tally', limit: 10 });
      assert.strictEqual(rows.length, 3);
      const got = await core.memory.get_many({ ids: rows.map(x => x.id) });
      const byText = Object.fromEntries(got.rows.map(x => [x.text, x]));
      assert.strictEqual(byText['second finding about money'].type, 'decision');
      assert.deepStrictEqual(byText['third, with a tag'].tags, ['t']);
      assert.match(byText['first finding about dates'].provenance, /^import:[0-9a-f]{12}:/);
      assert.ok(got.rows.every(x => (x.status || 'unverified') === 'unverified'));
    } finally { await core.shutdownOwner(); await core.close(); }

    const again = await memory.run({ ...ctx, openCore: realWithVectors(target) });
    assert.deepStrictEqual([again.json.inserted, again.json.updated], [0, 3], 'a second import converges');
    const owner = fs.existsSync(`${target}/owner.lock`);
    assert.strictEqual(owner, false, 'no owner outlives the command');
  } finally { cleanup(dir); }
});

test('REAL import: the stored row carries source operator, the title, the body and the redacted text (needs the ADR 0040 write path)', { skip: REAL_WRITE_PATH ? false : 'memory.store has no write path for title, body, source and redaction yet; re-run once it lands' }, async () => {
  const dir = sandbox();
  try {
    const target = `${dir}/.belay`;
    fs.writeFileSync(`${dir}/s.jsonl`, `${JSON.stringify({ namespace: 'project/t', type: 'finding', title: 'a title', body: { file: 'a.cjs' }, text: `needs ${SECRET} here`, status: 'verified' })}\n`);
    const r = await memory.run({ argv: ['import', `${dir}/s.jsonl`], cwd: dir, dataDir: target, dataDirGiven: true, json: false, openCore: realWithVectors(target) });
    assert.strictEqual(r.code, 0, r.text);
    const core = await openCore({ dataDir: target, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    try {
      const row = (await core.memory.get_many({ ids: [r.json.rows[0].id] })).rows[0];
      assert.strictEqual(row.source, 'operator');
      assert.strictEqual(row.title, 'a title');
      assert.deepStrictEqual(row.body, { file: 'a.cjs' });
      assert.ok(!row.text.includes(SECRET), 'the secret is not stored');
      assert.match(row.text, /\[REDACTED:/);
      assert.ok(row.redactions && Object.keys(row.redactions).length, 'the redaction is recorded on the row');
      assert.strictEqual(row.status, 'unverified');
    } finally { await core.shutdownOwner(); await core.close(); }
  } finally { cleanup(dir); }
});
