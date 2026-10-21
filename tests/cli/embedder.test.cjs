'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// embedder.test.cjs (CLI) — `belay embedder fetch|verify` (ADR 0027 decision 4) against a local
// node:http server standing in for Hugging Face. BELAY_HF_BASE points the CLI at it and
// BELAY_EMBEDDER_TABLE at a JSON table naming a tiny fake model; BELAY_MODEL_CACHE at a fresh temp
// root. No real network, no real model. The CLI runs as a spawned process, so the server must answer
// from this process's event loop: every spawn here is asynchronous.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const fwd = p => String(p).split(path.sep).join('/');

const FILES = {
  'config.json': Buffer.from('{"fake":true}\n'),
  'onnx/model.bin': crypto.createHash('sha256').update('seed').digest().subarray(0, 24),
};
const ENTRY = {
  id: 'fake-org/fake-model', sha: 'c'.repeat(40), dtype: 'fp32', pooling: 'mean', query_prompt: '', document_prompt: '',
  native_dims: 4, dims: 4, max_tokens: 16, license: 'none',
  files: Object.entries(FILES).map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha256(b) })),
};

// Serves ENTRY's files under /<id>/resolve/<sha>/<path>. `corrupt` names a path served with the same
// size and a different byte; onnx/model.bin is served through a redirect, as HF does for LFS files.
async function withServer(opts, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const prefix = `/${ENTRY.id}/resolve/${ENTRY.sha}/`;
    if (req.url.startsWith('/cdn/')) {
      const p = decodeURIComponent(req.url.slice(5));
      const b = Buffer.from(FILES[p]);
      if (opts.corrupt === p) b[0] ^= 0xff;
      res.writeHead(200, { 'content-length': b.length }); return res.end(b);
    }
    if (!req.url.startsWith(prefix)) { res.writeHead(404); return res.end(); }
    const p = req.url.slice(prefix.length);
    if (!FILES[p]) { res.writeHead(404); return res.end(); }
    if (p === 'config.json' && opts.mode === 'stall') { res.writeHead(200, { 'content-length': 100 }); return res.write('abc'); } // then silence
    if (p === 'config.json' && opts.mode === 'cut') { res.writeHead(200, { 'content-length': 100 }); res.write('abc'); return setTimeout(() => req.socket.destroy(), 50); }
    if (p === 'config.json' && opts.mode === 'slow') { const b = Buffer.from(FILES[p]); return setTimeout(() => { res.writeHead(200, { 'content-length': b.length }); res.end(b); }, 6000); }
    if (p === 'onnx/model.bin') { res.writeHead(307, { location: `/cdn/${encodeURIComponent(p)}` }); return res.end(); }
    const b = Buffer.from(FILES[p]);
    if (opts.corrupt === p) b[0] ^= 0xff;
    res.writeHead(200, { 'content-length': b.length }); res.end(b);
  });
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cache = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-embedder-cli-')));
  const tableFile = `${cache}-table.json`;
  fs.writeFileSync(tableFile, JSON.stringify({ [ENTRY.id]: ENTRY }));
  try { await fn({ base, cache, tableFile, requests }); }
  finally {
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r));
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(tableFile, { force: true });
  }
}

function belay(args, { base, cache, tableFile }, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'embedder', ...args, '--json'], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, BELAY_HF_BASE: base, BELAY_MODEL_CACHE: cache, BELAY_EMBEDDER_TABLE: tableFile, BELAY_TEST_MODE: '1', ...extraEnv },
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      let json = null;
      try { json = JSON.parse(out || err); } catch { /* not json */ }
      resolve({ code, out, err, json });
    });
  });
}

const listAll = dir => {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; out.push(p.slice(dir.length + 1)); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};
const modelDir = cache => `${cache}/${ENTRY.id}@${ENTRY.sha}`;

test('embedder fetch: a clean fetch writes every file, the manifest last, and a receipt (f1)', async () => {
  await withServer({}, async ctx => {
    const r = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(r.code, 0, `${r.out} ${r.err}`);
    assert.strictEqual(r.json.already_present, false);
    assert.strictEqual(r.json.files.length, 2);
    for (const f of r.json.files) {
      assert.strictEqual(f.sha256, sha256(FILES[f.path]));
      assert.strictEqual(f.bytes, FILES[f.path].length);
      assert.ok(Number.isFinite(f.ms));
      assert.deepStrictEqual(fs.readFileSync(`${modelDir(ctx.cache)}/${f.path}`), FILES[f.path]);
    }
    assert.strictEqual(r.json.total_bytes, Object.values(FILES).reduce((n, b) => n + b.length, 0));
    assert.ok(ctx.requests.some(u => u.startsWith('/cdn/')), 'the redirect was followed');
    const dir = modelDir(ctx.cache);
    const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
    assert.strictEqual(manifest.sha, ENTRY.sha);
    assert.deepStrictEqual(manifest.files.map(f => f.sha256), ENTRY.files.map(f => f.sha256));
    const mt = fs.statSync(`${dir}/manifest.json`).mtimeMs;
    for (const f of ENTRY.files) assert.ok(fs.statSync(`${dir}/${f.path}`).mtimeMs <= mt, `${f.path} was written before the manifest`);
    assert.deepStrictEqual(listAll(ctx.cache).filter(p => p.includes('.tmp')), [], 'no temp directory is left');
    // The text form prints one line per file and a total.
    const text = await new Promise(res => {
      const c = spawn(process.execPath, [CLI, 'embedder', 'verify', '--model', ENTRY.id], { cwd: ROOT, windowsHide: true, env: { ...process.env, BELAY_HF_BASE: ctx.base, BELAY_MODEL_CACHE: ctx.cache, BELAY_EMBEDDER_TABLE: ctx.tableFile, BELAY_TEST_MODE: '1' } });
      let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', code => res({ code, o }));
    });
    assert.strictEqual(text.code, 0);
    assert.match(text.o, /verified fake-org\/fake-model@cccccccc: 2 files/);
  });
});

test('embedder fetch: a sha256 mismatch fails naming the file and leaves no model or temp directory (f2)', async () => {
  await withServer({ corrupt: 'onnx/model.bin' }, async ctx => {
    const r = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(r.code, 1, `${r.out} ${r.err}`);
    assert.ok(r.json.error.includes('onnx/model.bin') && r.json.error.includes('sha256'), r.json.error);
    assert.strictEqual(fs.existsSync(modelDir(ctx.cache)), false, 'no model directory');
    assert.deepStrictEqual(listAll(ctx.cache), [], 'nothing at all is left in the cache: no temp directory, no empty parent');
  });
  // A wrong size is caught too, before the hash is compared, naming the file.
  await withServer({}, async ctx => {
    const bigger = { ...ENTRY, files: ENTRY.files.map(f => f.path === 'config.json' ? { ...f, bytes: f.bytes + 1 } : f) };
    fs.writeFileSync(ctx.tableFile, JSON.stringify({ [ENTRY.id]: bigger }));
    const r = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(r.code, 1);
    assert.ok(r.json.error.includes('config.json') && r.json.error.includes('bytes'), r.json.error);
    assert.deepStrictEqual(listAll(ctx.cache), []);
  });
});

test('embedder fetch: a second fetch makes no request (f3)', async () => {
  await withServer({}, async ctx => {
    const first = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(first.code, 0);
    const before = ctx.requests.length;
    assert.ok(before >= 3);
    const again = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(again.code, 0);
    assert.strictEqual(again.json.already_present, true);
    assert.strictEqual(ctx.requests.length, before, 'no request was made');
  });
});

test('embedder verify: a flipped byte is detected, naming the file, with a non-zero exit (f4)', async () => {
  await withServer({}, async ctx => {
    assert.strictEqual((await belay(['fetch', '--model', ENTRY.id], ctx)).code, 0);
    const ok = await belay(['verify', '--model', ENTRY.id], ctx);
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.json.verified, true);
    const p = `${modelDir(ctx.cache)}/onnx/model.bin`;
    const b = fs.readFileSync(p); b[3] ^= 0x01; fs.writeFileSync(p, b);   // the size is unchanged: only the hash can tell
    const bad = await belay(['verify', '--model', ENTRY.id], ctx);
    assert.strictEqual(bad.code, 1, `${bad.out} ${bad.err}`);
    assert.strictEqual(bad.json.verified, false);
    assert.ok(bad.json.mismatches.some(m => m.includes('onnx/model.bin')));
    assert.strictEqual(bad.json.files.find(f => f.path === 'config.json').ok, true);
    // An absent file is a mismatch too.
    fs.rmSync(p);
    const missing = await belay(['verify', '--model', ENTRY.id], ctx);
    assert.strictEqual(missing.code, 1);
    assert.ok(missing.json.mismatches.some(m => m.includes('onnx/model.bin: absent')));
  });
});

test('embedder fetch: a table entry that escapes the cache, or names a crafted sha, is refused and writes nothing (S4)', async () => {
  await withServer({}, async ctx => {
    const write = (entry) => fs.writeFileSync(ctx.tableFile, JSON.stringify({ [ENTRY.id]: entry }));
    const marker = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-victim-')));
    fs.writeFileSync(`${marker}/precious.txt`, 'keep');
    try {
      const bads = [
        { ...ENTRY, files: [{ ...ENTRY.files[0], path: '../../escaped.txt' }] },
        { ...ENTRY, files: [{ ...ENTRY.files[0], path: 'C:/escaped.txt' }] },
        { ...ENTRY, files: [{ ...ENTRY.files[0], path: 'a\\b.txt' }] },
        { ...ENTRY, files: [{ ...ENTRY.files[0], path: '/abs.txt' }] },
        { ...ENTRY, sha: `/../../${path.basename(marker)}` , files: [] },
        { ...ENTRY, sha: 'z'.repeat(40) },
        { ...ENTRY, files: [{ ...ENTRY.files[0], sha256: 'abc' }] },
        { ...ENTRY, files: [{ ...ENTRY.files[0], bytes: 0 }] },
      ];
      for (const b of bads) {
        write(b);
        const r = await belay(['fetch', '--model', ENTRY.id], ctx);
        assert.strictEqual(r.code, 2, `${JSON.stringify(b).slice(0, 120)} => ${r.out} ${r.err}`);
        assert.ok(r.json.error.includes('unusable'), r.json.error);
        assert.deepStrictEqual(listAll(ctx.cache), [], 'nothing was written to the cache');
        assert.strictEqual(fs.existsSync(`${ctx.cache}/../escaped.txt`), false);
      }
      assert.strictEqual(fs.readFileSync(`${marker}/precious.txt`, 'utf8'), 'keep');
      assert.deepStrictEqual(fs.readdirSync(marker), ['precious.txt']);
      assert.strictEqual(ctx.requests.length, 0);
    } finally { fs.rmSync(marker, { recursive: true, force: true }); }
  });
});

test('embedder: the table file is honoured only under BELAY_TEST_MODE=1 (S4)', async () => {
  await withServer({}, async ctx => {
    const r = await belay(['fetch', '--model', ENTRY.id], ctx, { BELAY_TEST_MODE: '' });
    assert.strictEqual(r.code, 2, 'the fake model is unknown to the real table');
    assert.ok(r.json.error.includes('unknown embedding model'));
    assert.strictEqual(ctx.requests.length, 0);
    assert.deepStrictEqual(listAll(ctx.cache), []);
  });
});

test('embedder fetch: stale temp directories are swept, and a second concurrent fetch fails naming the lock (S5)', async () => {
  await withServer({ mode: 'slow' }, async ctx => {
    const stale = `${ctx.cache}/${ENTRY.id.split('/')[0]}/.tmp-${ENTRY.id.split('/')[1]}@${ENTRY.sha}-1-1`;
    fs.mkdirSync(`${stale}/onnx`, { recursive: true });
    fs.writeFileSync(`${stale}/onnx/partial`, 'x');
    const a = belay(['fetch', '--model', ENTRY.id], ctx);           // holds the lock: config.json is served after 2.5 s
    for (let i = 0; i < 400 && !fs.readdirSync(ctx.cache).some(n => n.startsWith('.fetch-')); i += 1) await new Promise(r => setTimeout(r, 50)); // the first fetch holds its lock (a loaded host can take seconds to start it)
    for (let i = 0; i < 100 && fs.existsSync(stale); i += 1) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(fs.existsSync(stale), false, 'the stale temp directory was removed at the start');
    const lockFile = fs.readdirSync(ctx.cache).find(n => n.startsWith('.fetch-'));
    assert.ok(lockFile, 'a lock file exists while the first fetch runs');
    const b = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(b.code, 1, `${b.out} ${b.err}`);
    assert.ok(b.json.error.includes(lockFile) || b.json.error.includes('.fetch-'), b.json.error);
    assert.strictEqual(fs.existsSync(modelDir(ctx.cache)), false, 'the second fetch touched nothing');
    const first = await a;
    assert.strictEqual(first.code, 0, `${first.out} ${first.err}`);
    assert.ok(fs.existsSync(`${modelDir(ctx.cache)}/manifest.json`), 'the first fetch was not undone by the second');
    assert.deepStrictEqual(fs.readdirSync(ctx.cache).filter(n => n.startsWith('.fetch-')), [], 'the lock is removed');
  });
});

test('embedder fetch: a stall or a cut connection names the file and the reason (S5)', async () => {
  await withServer({ mode: 'stall' }, async ctx => {
    const r = await belay(['fetch', '--model', ENTRY.id], ctx, { BELAY_FETCH_IDLE_MS: '700' });
    assert.strictEqual(r.code, 1, `${r.out} ${r.err}`);
    assert.ok(r.json.error.includes('config.json') && r.json.error.includes('idle timeout') && r.json.error.includes('700 ms'), r.json.error);
    assert.deepStrictEqual(listAll(ctx.cache), []);
  });
  await withServer({ mode: 'cut' }, async ctx => {
    const r = await belay(['fetch', '--model', ENTRY.id], ctx);
    assert.strictEqual(r.code, 1, `${r.out} ${r.err}`);
    assert.ok(r.json.error.includes('config.json'), r.json.error);
    assert.ok(/aborted|reset|hang up|ECONN|closed/i.test(r.json.error), r.json.error);
    assert.deepStrictEqual(listAll(ctx.cache), []);
  });
});

test('embedder fetch: two fetches started together, exactly one proceeds (SF5)', async () => {
  await withServer({ mode: 'slow' }, async ctx => {
    const [a, b] = await Promise.all([belay(['fetch', '--model', ENTRY.id], ctx), belay(['fetch', '--model', ENTRY.id], ctx)]);
    const ok = [a, b].filter(r => r.code === 0 && r.json.already_present === false);
    const refused = [a, b].filter(r => r.code === 1);
    assert.strictEqual(ok.length, 1, `${a.out}${a.err} | ${b.out}${b.err}`);
    assert.strictEqual(refused.length, 1);
    assert.ok(refused[0].json.error.includes('.fetch-'), refused[0].json.error);
    assert.ok(fs.existsSync(`${modelDir(ctx.cache)}/manifest.json`));
    assert.strictEqual(ctx.requests.filter(u => u.endsWith('/config.json')).length, 1, 'the model was fetched once');
  });
});

test('embedder fetch: the lock is written in the exclusive open; an empty lock is held until 10 minutes old (SF5)', () => {
  const { takeLock } = require('../../src/cli/cmd-embedder.cjs');
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-lock-')));
  try {
    const lock = `${dir}/l.lock`;
    // Node's writeFileSync opens and then writes, so an empty file can be seen for an instant; the rule
    // below (an empty lock is held, never stolen, until it is 10 minutes old) is what makes that safe.
    assert.strictEqual(takeLock(lock), true);
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid), 'the pid is in the file from the start');
    assert.strictEqual(takeLock(lock), false, 'a live holder keeps it');
    fs.writeFileSync(lock, '');                                   // what a racing reader saw before: empty
    assert.strictEqual(takeLock(lock), false, 'an empty fresh lock is held, not stolen');
    fs.writeFileSync(lock, 'not a pid');
    assert.strictEqual(takeLock(lock), false, 'an unreadable fresh lock is held');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.strictEqual(takeLock(lock), true, 'an empty or unreadable lock older than 10 minutes is stolen');
    const dead = require('child_process').spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    fs.writeFileSync(lock, String(dead));
    assert.strictEqual(takeLock(lock), true, 'a lock naming a dead pid is stolen');
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('embedder: usage errors exit 2 and an unknown model names the known ids', async () => {
  await withServer({}, async ctx => {
    assert.strictEqual((await belay([], ctx)).code, 2);
    assert.strictEqual((await belay(['frobnicate'], ctx)).code, 2);
    const u = await belay(['fetch', '--model', 'nope/nope'], ctx);
    assert.strictEqual(u.code, 2);
    assert.ok(u.json.error.includes(ENTRY.id));
    assert.strictEqual(ctx.requests.length, 0);
  });
});
