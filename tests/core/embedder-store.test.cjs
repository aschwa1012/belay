'use strict';
// embedder-store.test.cjs — review 1 of build step E1 (ADR 0027): which model a store uses (m8), the
// identity written in one transaction and adopted only from the legacy shape (m9), the owner answering
// its pipe while the model loads in a worker thread (m10), the query prompt through the owner (m11), the
// thread ending with its owner and never keeping a process alive, the package pin (S6) and the scan
// ceiling at the check site (S3). Model tests skip with the reason when the model is not fetched.

const nodeTest = require('node:test').test;
const test = (name, fn) => nodeTest(name, { timeout: 240000 }, fn); // model loads under a parallel phase can outrun 60 s
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, optInModel } = require('./helpers.cjs');
optInModel();

const { openCore } = core('index.cjs');
const { Embedder } = core('embedder.cjs');
const { Store } = core('store.cjs');
const { ping } = core('ping.cjs');
const M = core('models.cjs');
const K = core('model-cache.cjs');
const I = core('embed-identity.cjs');

const VOYAGE = M.MODELS[M.DEFAULT_MODEL];
const MINILM = M.MODELS['Xenova/all-MiniLM-L6-v2'];
const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');

function absence(entry) {
  if (!K.packageDir()) return 'the transformers package is not installed at the pinned version (run npm install)';
  const c = K.checkPresent(entry);
  return c.present ? null : `the model ${entry.id} is not in the cache at ${c.dir} (run belay embedder fetch --model ${entry.id})`;
}
const noVoyage = absence(VOYAGE);
const noMiniLM = absence(MINILM);

const vec = (dim, seed = 1) => Array.from({ length: dim }, (_, i) => ((i * seed) % 7) + 1);
const metaOf = c => Object.fromEntries(c.owner.store.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
const seedMeta = (dir, rows) => {
  const s = new Store(path.join(dir, 'memory.db'));
  const put = s.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  for (const [k, v] of rows) put.run(k, v);
  s.close();
};
async function withCore(opts, fn) {
  const dir = sandbox();
  let c = null;
  try {
    if (opts.meta) seedMeta(dir, opts.meta);
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true, ownerOpts: opts.ownerOpts });
    await fn(c, dir);
  } finally {
    if (c) { await c.shutdownOwner(); await c.close(); }
    cleanup(dir);
  }
}

test('embedder: a store holding MiniLM rows and no identity loads MiniLM, never the default (m8)', async () => {
  // Needs no model: with an empty cache the refusal must name MiniLM, and no identity may be written.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-m8-')).split('\\').join('/');
  try {
    await withCore({ ownerOpts: { embedOpts: { cacheDir: empty } } }, async (c) => {
      await c.memory.store({ namespace: 'old', text: 'a supplied MiniLM row', embedding: vec(384), embedding_model: MINILM.id, dim: 384 });
      await assert.rejects(c.memory.store({ namespace: 'old', text: 'a text row' }), x => {
        assert.strictEqual(x.code, 'E_MODEL_ABSENT');
        assert.ok(x.message.includes(MINILM.id), x.message);
        assert.ok(!x.message.includes(VOYAGE.id), 'the default model must not be chosen for a store with MiniLM rows');
        return true;
      });
      assert.strictEqual(metaOf(c).embedding_model, undefined, 'no identity was written');
    });
    // Rows from a model the table does not know: refused naming it.
    await withCore({ ownerOpts: { embedOpts: { cacheDir: empty } } }, async (c) => {
      await c.memory.store({ namespace: 'odd', text: 'a fixture row', embedding: vec(8), embedding_model: 'fixture', dim: 8 });
      await assert.rejects(c.memory.store({ namespace: 'odd', text: 'a text row' }), x => x.code === 'E_MODEL_CHANGED' && x.message.includes('fixture'));
    });
  } finally { cleanup(empty); }
  if (noMiniLM) return;
  await withCore({}, async (c) => {
    await c.memory.store({ namespace: 'old', text: 'a supplied MiniLM row', embedding: vec(384), embedding_model: MINILM.id, dim: 384 });
    const row = await c.memory.store({ namespace: 'old', text: 'The store owner holds the only connection to the database file.' });
    assert.strictEqual(row.action, 'inserted');
    const meta = metaOf(c);
    assert.strictEqual(meta.embedding_model, MINILM.id);
    assert.strictEqual(meta.embedding_dim, '384');
    assert.strictEqual(meta.embedding_sha, MINILM.sha);
  });
});

test('embedder: the identity is one transaction, and only the exact legacy MiniLM shape adopts (m9)', async () => {
  const dir = sandbox();
  try {
    const s = new Store(path.join(dir, 'memory.db'));
    // A planted throw between keys leaves no identity key.
    assert.throws(() => I.writeMeta(s.db, [['embedding_model', 'x'], ['embedding_sha', Symbol('boom')]]));
    assert.deepStrictEqual(s.db.prepare('SELECT key FROM meta').all(), [], 'a failed write leaves no key');
    I.writeMeta(s.db, [['embedding_model', 'a'], ['embedding_dim', '1']]);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) n FROM meta').get().n, 2);
    s.close();
  } finally { cleanup(dir); }

  const refused = async (stored, reason) => {
    await assert.rejects(new Embedder().load(stored), x => {
      assert.strictEqual(x.code, 'E_MODEL_CHANGED', x.message);
      if (reason) assert.strictEqual(x.detail.reason, reason);
      return true;
    });
  };
  await refused({ embedding_model: VOYAGE.id }, 'incomplete identity');
  await refused({ canary_sha256: '0'.repeat(64) }, 'incomplete identity');
  await refused({ embedding_model: VOYAGE.id, embedding_dim: '1024', embedding_dtype: 'q4' }, 'incomplete identity');
  await refused({ canary_sha256: '0'.repeat(64), embedding_model: VOYAGE.id, embedding_dim: '1024' }, 'legacy identity of another model');

  // Through the owner: a partial identity is refused and meta is left exactly as it was.
  await withCore({ meta: [['embedding_model', VOYAGE.id]] }, async (c) => {
    await assert.rejects(c.memory.store({ text: 'x' }), x => x.code === 'E_MODEL_CHANGED' && x.detail.reason === 'incomplete identity');
    // The embedder identity is asserted exactly; the G3 stamp (written by the owner's open) apart from it.
    const { schema_version, written_by, memory_fts_version, ...identity } = metaOf(c);
    assert.deepStrictEqual(identity, { embedding_model: VOYAGE.id });
    assert.strictEqual(schema_version, '2');
    assert.match(written_by, /^belay@\S+\+\S+$/);
  });
  if (noVoyage) return;
  // A moved library on a passing canary is recorded once, in meta.
  const dir2 = sandbox();
  let c = null;
  try {
    c = await openCore({ dataDir: dir2, caller: callerFor('orchestrator'), embed: true });
    await c.memory.store({ namespace: 'lib', text: 'first' });
    const real = metaOf(c).embedding_library;
    c.owner.store.db.prepare("UPDATE meta SET value = '0.0.1' WHERE key = 'embedding_library'").run();
    await c.shutdownOwner(); await c.close();
    c = await openCore({ dataDir: dir2, caller: callerFor('orchestrator'), embed: true });
    await c.memory.store({ namespace: 'lib', text: 'second' });
    assert.strictEqual(metaOf(c).embedding_library, real, 'the new library is recorded');
    assert.strictEqual(c.owner.embedInfo.library_changed.from, '0.0.1');
  } finally { if (c) { await c.shutdownOwner(); await c.close(); } cleanup(dir2); }
});

// Build 12 w2-flakes review-1 B2: the embedder child is fork()ed synchronously on the owner's loop on first
// use, and one CreateProcess takes 80-365 ms, which stalled the owner past this test's 250 ms bound (about 1
// run in 5). Build 12b E2: memory.warm starts the child before any caller talks to the owner (the run's
// warm-up does this), and the core re-pings a live owner once with a 2,000 ms bound before calling it lost.
// An UNWARMED owner (a CLI-elected one) still pays the fork stall at its first vector call; the core's 2,000 ms
// re-ping covers it (embedder-wait.test.cjs). This test models a run that has warmed: the fork stall happens in the warm call, the load that follows is
// what this test watches. The assertion is the product's claim and is unchanged.
test('embedder: the owner answers its pipe within 250 ms while the model loads, and the thread ends with the owner (m10)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  await withCore({}, async (c, dir) => {
    // The owner shares this process's event loop, so a stall anywhere in the load shows up as a gap
    // between ticks of this timer, whether or not a ping happened to be in flight during it.
    let last = Date.now(), gap = 0;
    const beat = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now; }, 20);
    await c.memory.warm({}); // the run's warm-up: elects the owner and forks the child here, then returns
    await new Promise(r => setTimeout(r, 600)); // the fork's own stall is over before the watch begins; the load itself continues
    last = Date.now(); gap = 0;
    const first = c.memory.store({ namespace: 'm10', text: 'a row that makes the owner load the model' });
    let done = false;
    first.then(() => { done = true; }, () => { done = true; });
    let n = 0, max = 0, seen = false;
    const bad = [];
    while (!done) {
      const r = await ping(dir, 2000);
      // The very first ping can land before the owner's pipe is listening; count from the first answer.
      if (r.ok) seen = true;
      if (!done && seen) { n += 1; max = Math.max(max, r.ms); if (!r.ok) bad.push(r.reason); }
      await new Promise(res => setTimeout(res, 20));
    }
    await first;
    clearInterval(beat);
    assert.ok(gap < 250, `the owner's event loop stalled for ${gap} ms during the load`);
    assert.deepStrictEqual(bad, [], 'every ping during the load was answered');
    assert.ok(n >= 3, `only ${n} pings landed during the load; it was not in flight long enough to prove anything`);
    assert.ok(max < 250, `the slowest ping during the load took ${max} ms`);
    assert.ok(c.owner.embedderObj.child, 'the embedder runs in a child process');
  });
  // shutdownOwner ended the thread.
});

test('embedder: the child process is ended by close() and by the owner stop, and never keeps a process alive', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const e = new Embedder();
  await e.load(null);
  assert.ok(e.child);
  await e.close();
  assert.strictEqual(e.child, null);
  await assert.rejects(e.embed('x'), x => x.code === 'E_MODEL_ABSENT');
  let obj = null;
  await withCore({}, async (c) => { await c.memory.store({ text: 'x' }); obj = c.owner.embedderObj; assert.ok(obj.child); });
  assert.strictEqual(obj.child, null, 'owner stop closed the embedder process');
  const r = spawnSync(process.execPath, [`${ROOT}/tests/core/fixtures/embed-exit.cjs`], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.strictEqual(r.status, 0, `the process did not end by itself: ${r.stdout} ${r.stderr} ${r.error}`);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { dim: 1024, len: 1024 });
});

test('embedder: a query is embedded with the query prompt through the owner, not as a document (S2)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const text = 'which process opens the sqlite file?';
  const ref = new Embedder();
  await ref.load(null);
  const q = (await ref.embed(text, { as: 'query' })).embedding;
  const d = (await ref.embed(text, { as: 'document' })).embedding;
  await ref.close();
  const expected = I.cosine(q, d);
  assert.ok(expected < 0.999, 'the prompts must matter for this test to mean anything');
  await withCore({}, async (c) => {
    await c.memory.store({ namespace: 'q', text });
    const s = await c.memory.search({ namespace: 'q', query: text, k: 1, mode: 'semantic' });
    assert.ok(Math.abs(s.results[0].score - expected) < 1e-3, `the score ${s.results[0].score} is not the query-vs-document cosine ${expected}`);
  });
});

test('embedder: a package of another version, or one outside belay\'s node_modules, is E_MODEL_ABSENT (S6)', async () => {
  assert.strictEqual(K.packageInfo().dir, `${ROOT}/node_modules/${K.PKG_NAME}`.split('\\').join('/'), 'the default lookup is belay\'s own node_modules only');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pkg-')).split('\\').join('/');
  try {
    fs.writeFileSync(`${other}/package.json`, JSON.stringify({ name: K.PKG_NAME, version: '4.2.0' }));
    assert.strictEqual(K.packageDir(other), null);
    await assert.rejects(new Embedder({ pkg: other }).load(null), x => {
      assert.strictEqual(x.code, 'E_MODEL_ABSENT');
      assert.ok(x.message.includes('4.2.0') && x.message.includes(M.PKG_VERSION), x.message);
      return true;
    });
  } finally { cleanup(other); }
});

test('memory.search: the scan ceiling at the check site follows the namespace\'s dims (S3)', async () => {
  await withCore({}, async (c) => {
    for (let i = 0; i < 1001; i += 1) {
      await c.memory.store({ namespace: 'big', text: `row ${i}`, embedding: [1, 0], embedding_model: 'fixture', dim: 2 });
    }
    // Bind the namespace to 19,200 dims: ceiling floor(50000 * 384 / 19200) = 1000 rows, and 1001 rows exceed it.
    c.owner.store.db.prepare("UPDATE namespace_models SET dim = 19200 WHERE namespace = 'big'").run();
    await assert.rejects(c.memory.search({ namespace: 'big', query_embedding: vec(19200), embedding_model: 'fixture' }), x => {
      assert.strictEqual(x.code, 'E_NAMESPACE_TOO_LARGE');
      assert.strictEqual(x.detail.ceiling, 1000);
      assert.strictEqual(x.detail.rows, 1001);
      return true;
    });
  });
});

test('embedder: stopping an owner mid-embed exits 0 within 5 s and the embedder child is gone (m11)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const { spawn } = require('node:child_process');
  const { pidAlive } = core('lock.cjs');
  const dir = sandbox();
  try {
    const child = spawn(process.execPath, [`${ROOT}/tests/core/fixtures/owner-embed-stop.cjs`, dir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(res => child.once('exit', (code, signal) => res({ code, signal, at: Date.now() })));
    let out = '', err = '', stoppingAt = null, info = null;
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => {
      out += d;
      for (const line of out.split('\n')) { if (line.includes('"stopping"') && !info) { info = JSON.parse(line); stoppingAt = Date.now(); } }
    });
    const killer = setTimeout(() => { try { process.kill(child.pid); } catch { /* gone */ } }, 120000);
    const r = await exited;
    clearTimeout(killer);
    assert.ok(info, `the fixture never had an embed in flight: ${out} ${err}`);
    assert.strictEqual(info.owner_pid, child.pid);
    assert.strictEqual(r.code, 0, `the owner exited ${r.code}/${r.signal}: ${out} ${err}`);
    assert.ok(r.at - stoppingAt < 5000, `the owner took ${r.at - stoppingAt} ms to exit after the stop`);
    assert.strictEqual(pidAlive(info.embedder_pid), false, 'the embedder child is gone');
    assert.match(out, /"stopped":true/);
  } finally { cleanup(dir); }
});

test('embedder: a child that dies after a good load makes later calls say so, and stats show it (SF1)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  await withCore({}, async (c) => {
    await c.memory.store({ namespace: 'sf1', text: 'first' });
    const o = c.owner.embedderObj;
    const pid = o.pid;
    assert.ok((await c.memory.stats({})).owner.embedder.pid === pid, 'stats report the embedder pid');
    process.kill(pid); // exact pid of the child this owner started
    for (let i = 0; i < 100 && !o.exit; i += 1) await new Promise(r => setTimeout(r, 50));
    assert.ok(o.exit, 'the exit was observed');
    await assert.rejects(c.memory.store({ namespace: 'sf1', text: 'second' }), x => {
      assert.strictEqual(x.code, 'E_MODEL_ABSENT');
      assert.match(x.message, /embedder process \(pid \d+\) exited/);
      assert.ok(!/before it finished loading/.test(x.message), x.message);
      return true;
    });
    await assert.rejects(c.memory.search({ namespace: 'sf1', query: 'first', mode: 'semantic' }), x => x.code === 'E_MODEL_ABSENT');
    const s = (await c.memory.stats({})).owner;
    assert.strictEqual(s.embedder_error.code, 'E_MODEL_ABSENT');
    assert.strictEqual(s.embedder, null);
    assert.strictEqual(o.pid, pid, 'no second child was started: the outcome is sticky');
  });
});

test('embedder: a failure after a good load is coded, closes the child and publishes nothing (SF2)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const { pidAlive } = core('lock.cjs');
  const real = I.writeMeta;
  let pid = null;
  try {
    I.writeMeta = () => { throw new Error('planted meta write failure'); };
    await withCore({}, async (c) => {
      await assert.rejects(c.memory.store({ namespace: 'sf2', text: 'x' }), x => {
        assert.strictEqual(x.code, 'E_INTERNAL');
        assert.match(x.message, /planted meta write failure/);
        return true;
      });
      pid = c.owner.embedderObj.pid;
      const s = (await c.memory.stats({})).owner;
      assert.strictEqual(s.embedder_error.code, 'E_INTERNAL');
      assert.strictEqual(s.embedder, null, 'nothing half-published');
      await assert.rejects(c.memory.search({ namespace: 'sf2', query: 'x', mode: 'semantic' }), x => x.code === 'E_INTERNAL', 'sticky, with the same code');
    });
  } finally { I.writeMeta = real; }
  assert.strictEqual(pidAlive(pid), false, 'the child was closed');
});

test('memory.search: a vector call that times out against a live owner is E_TIMEOUT naming its pid, not a copy fallback (SF3)', async () => {
  const { startOwnerProcess, stopOwnerProcesses } = require('./helpers.cjs');
  const { err } = core('errors.cjs');
  const dir = sandbox();
  let c = null;
  try {
    const o = await startOwnerProcess(dir);
    c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    await c.memory.search({ namespace: 'n', query_embedding: [1, 0], embedding_model: 'm' }); // dials the owner
    assert.ok(c.client, 'the core is a client of the live owner');
    c.client.call = async () => { throw err('E_TIMEOUT', 'the owner did not answer in time'); };
    await assert.rejects(c.memory.search({ namespace: 'n', query: 'which process?', mode: 'semantic' }), x => {
      assert.strictEqual(x.code, 'E_TIMEOUT', `${x.code}: ${x.message}`);
      assert.strictEqual(x.detail.owner_pid, o.info.pid);
      assert.ok(x.detail.timeout_ms >= 100000, 'the bound is the 100 s vector bound');
      assert.ok(!/no owner answered/.test(x.message), x.message);
      return true;
    });
  } finally {
    if (c) { try { await c.close(); } catch { /* best effort */ } }
    await stopOwnerProcesses(dir);
    cleanup(dir);
  }
});

test('embedder: the package is looked up in the repository root\'s node_modules only, never an ancestor (SF6)', () => {
  assert.strictEqual(K.packageInfo().dir, `${ROOT}/node_modules/${K.PKG_NAME}`);
  // A copy of the lookup module in <T>/proj/src/core, with the package only in an ANCESTOR <T>/node_modules.
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sf6-')).split('\\').join('/');
  try {
    fs.mkdirSync(`${T}/proj/src/core`, { recursive: true });
    for (const f of ['model-cache.cjs', 'models.cjs', 'errors.cjs']) fs.copyFileSync(`${ROOT}/src/core/${f}`, `${T}/proj/src/core/${f}`);
    fs.mkdirSync(`${T}/node_modules/${K.PKG_NAME}`, { recursive: true });
    fs.writeFileSync(`${T}/node_modules/${K.PKG_NAME}/package.json`, JSON.stringify({ name: K.PKG_NAME, version: M.PKG_VERSION }));
    const copy = require(`${T}/proj/src/core/model-cache.cjs`);
    assert.strictEqual(copy.packageInfo(undefined, {}), null, 'an ancestor node_modules must not be searched');
    fs.mkdirSync(`${T}/proj/node_modules/${K.PKG_NAME}`, { recursive: true });
    fs.writeFileSync(`${T}/proj/node_modules/${K.PKG_NAME}/package.json`, JSON.stringify({ name: K.PKG_NAME, version: M.PKG_VERSION }));
    assert.strictEqual(copy.packageInfo(undefined, {}).dir, `${T}/proj/node_modules/${K.PKG_NAME}`);
  } finally { cleanup(T); }
});

test('embedder: rows of a model the table does not know fail closed, naming it and a re-embed (SF7)', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sf7-')).split('\\').join('/');
  try {
    await withCore({ ownerOpts: { embedOpts: { cacheDir: empty } } }, async (c) => {
      await c.memory.store({ namespace: 'a', text: 'a foreign row', embedding: vec(8), embedding_model: 'openai/text-embedding-3-small', dim: 8 });
      for (const ns of ['a', 'other']) {
        await assert.rejects(c.memory.store({ namespace: ns, text: 'text call' }), x => {
          assert.strictEqual(x.code, 'E_MODEL_CHANGED');
          assert.ok(x.message.includes('openai/text-embedding-3-small') && x.message.includes('without a re-embed'), x.message);
          assert.strictEqual(x.detail.needs, 're-embed');
          return true;
        });
      }
      assert.strictEqual(metaOf(c).embedding_model, undefined);
    });
  } finally { cleanup(empty); }
});
