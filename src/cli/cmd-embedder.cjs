'use strict';
// cmd-embedder.cjs — `belay embedder fetch|verify [--model <id>] [--json]` (ADR 0027 decision 4). Mode W
// for the verb: fetch is the only belay code that touches the network, and it writes the model cache.
//
// fetch: download each file the model table names from <base>/<id>/resolve/<sha>/<path> into a temp
// directory beside the target, check each file's byte count and sha256 against the table, rename the
// directory into place, then write manifest.json last. A mismatch removes the temp directory and fails
// naming the file. A model already present and matching is not fetched again (no request is made).
// verify: re-hash every cached file against the table; exit 1 on any mismatch or absence.
//
// Environment variables for the tests and nothing else. BELAY_HF_BASE (default https://huggingface.co)
// is harmless in production because every byte is checked against the table's size and sha256. The
// other two are honoured ONLY when BELAY_TEST_MODE=1 is also set:
//   BELAY_EMBEDDER_TABLE   a JSON file of { "<id>": <entry> } read instead of models.cjs, so a test can
//                          serve a tiny fake model. Only this module reads it; the embedder never does.
//   BELAY_FETCH_IDLE_MS    the idle read timeout in ms (default 60000)
// Every entry, from the file or from models.cjs, is validated before use (models.cjs validateEntry): a
// sha is 40 hex and a file path is relative, forward-slash, without .. or a drive letter.
// The cache root is BELAY_MODEL_CACHE or the default (model-cache.cjs).
//
// Hygiene: a fetch holds an exclusive lock file <root>/.fetch-<org>__<name>@<sha>.lock (wx, removed in
// finally; a lock whose pid is dead is stolen), and removes stale .tmp-* directories of the same model
// left by an interrupted fetch.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const M = require('../core/models.cjs');
const K = require('../core/model-cache.cjs');

const READ_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;

const USAGE = 'usage: belay embedder fetch|verify [--model <id>] [--json]\n';

const testMode = () => process.env.BELAY_TEST_MODE === '1';
const idleMs = () => (testMode() && Number(process.env.BELAY_FETCH_IDLE_MS) > 0 ? Number(process.env.BELAY_FETCH_IDLE_MS) : READ_TIMEOUT_MS);

function table() {
  const f = testMode() ? process.env.BELAY_EMBEDDER_TABLE : null;
  if (!f) return { models: M.MODELS, def: M.DEFAULT_MODEL };
  const models = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { models, def: Object.keys(models)[0] };
}

function parseArgs(argv) {
  const out = { verb: null, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--model') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) return { error: '--model needs an id' };
      out.model = v; i += 1;
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (!out.verb) out.verb = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (out.verb !== 'fetch' && out.verb !== 'verify') return { error: out.verb ? `unknown subverb ${out.verb}` : 'a subverb is needed: fetch or verify' };
  return out;
}

function get(url, note, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'belay-embedder-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`));
        return resolve(get(new URL(res.headers.location, url).href, note, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${url}`)); }
      resolve(res);
    });
    // Idle timeout: no byte for idleMs() on the socket, whether waiting for headers or for data. `note`
    // records why, so the failure names the timeout and not the 'aborted' it surfaces as.
    req.setTimeout(idleMs(), () => { note.idle = idleMs(); req.destroy(new Error(`idle timeout: no byte for ${idleMs()} ms`)); });
    req.on('error', reject);
  });
}

async function downloadFile(url, dest, file) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const t0 = Date.now();
  const note = { idle: null };
  try { return await downloadFile2(url, dest, file, t0, note); }
  catch (e) {
    if (e.message.startsWith(`${file.path}: `)) throw e; // a size or hash refusal already names the file
    const reason = note.idle ? `idle timeout: no byte for ${note.idle} ms` : `${e.message}${e.code ? ` (${e.code})` : ''}`;
    throw new Error(`${file.path}: ${reason}`);
  }
}

async function downloadFile2(url, dest, file, t0, note) {
  const res = await get(url, note);
  res.on('error', () => {});
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  await pipeline(res, tap, fs.createWriteStream(dest));
  const sha256 = hash.digest('hex');
  if (bytes !== file.bytes) throw new Error(`${file.path}: ${bytes} bytes arrived and the table says ${file.bytes}`);
  if (sha256 !== file.sha256) throw new Error(`${file.path}: sha256 ${sha256} does not match the table's ${file.sha256}`);
  return { path: file.path, bytes, sha256, ms: Date.now() - t0 };
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); let n = 0;
    fs.createReadStream(p).on('data', (d) => { h.update(d); n += d.length; }).on('end', () => resolve({ sha256: h.digest('hex'), bytes: n })).on('error', reject);
  });
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

async function fetchModel(entry, ctx) {
  const t0 = Date.now();
  const root = K.cacheRoot();
  const target = K.modelDir(entry, root);
  const chk = K.checkPresent(entry, root);
  if (chk.present) {
    return { code: 0, verb: 'fetch', model: entry.id, sha: entry.sha, dir: target, already_present: true, files: [], total_bytes: 0, total_ms: Date.now() - t0 };
  }
  const fail = (message, files = []) => ({ code: 1, verb: 'fetch', model: entry.id, sha: entry.sha, dir: target, error: message, files, total_bytes: 0, total_ms: Date.now() - t0 });
  // Exclusive lock: a second concurrent fetch fails naming it and touches nothing.
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.fetch-${entry.id.split('/').join('__')}@${entry.sha}.lock`);
  if (!takeLock(lock)) return fail(`another fetch of ${entry.id} holds the lock ${fwdp(lock)}; nothing was touched`);
  try {
    const again = K.checkPresent(entry, root);   // a fetch that held the lock before us may have finished
    if (again.present) return { code: 0, verb: 'fetch', model: entry.id, sha: entry.sha, dir: target, already_present: true, files: [], total_bytes: 0, total_ms: Date.now() - t0 };
    return await fetchLocked(entry, ctx, { root, target, t0, fail });
  } finally { rmrf(lock); }
}

const fwdp = (p) => String(p).split('\\').join('/');

const STALE_EMPTY_LOCK_MS = 10 * 60 * 1000;

// Create the lock atomically with our pid in the same exclusive open, so no reader ever sees it empty
// from a live holder. A lock naming a dead pid (a killed fetch) is stolen, and only if it still names
// that pid when we remove it. An empty or unreadable lock is HELD unless its mtime is over 10 minutes old.
function takeLock(lock, now = Date.now()) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text = '';
      try { text = fs.readFileSync(lock, 'utf8').trim(); } catch { continue; } // raced away: try again
      const pid = Number(text);
      if (!text || !Number.isInteger(pid) || pid <= 0) {
        let age = 0;
        try { age = now - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age < STALE_EMPTY_LOCK_MS) return false;
      } else {
        let alive = true;
        try { process.kill(pid, 0); } catch (k) { alive = k.code === 'EPERM'; }
        if (alive) return false;
      }
      // Remove only the lock we judged: if another fetch stole it first, it names a different pid now.
      let again = null;
      try { again = fs.readFileSync(lock, 'utf8').trim(); } catch { continue; }
      if (again === text) rmrf(lock);
    }
  }
  return false;
}

async function fetchLocked(entry, ctx, { root, target, t0, fail }) {
  const base = (process.env.BELAY_HF_BASE || 'https://huggingface.co').replace(/\/+$/, '');
  const parent = path.dirname(target);
  // Stale temp directories of this model from an interrupted fetch (no lock is held by anyone else).
  try {
    for (const n of fs.readdirSync(parent)) if (n.startsWith(`.tmp-${path.basename(target)}-`)) rmrf(path.join(parent, n));
  } catch { /* the parent does not exist yet */ }
  const tmp = path.join(parent, `.tmp-${path.basename(target)}-${process.pid}-${Date.now()}`);
  const files = [];
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of entry.files) {
      const url = `${base}/${entry.id}/resolve/${entry.sha}/${f.path}`;
      const r = await downloadFile(url, path.join(tmp, f.path), f);
      files.push(r);
      if (ctx.emit) ctx.emit(`  ${r.path}  ${r.bytes} bytes  sha256 ${r.sha256}  ${r.ms} ms\n`);
    }
    rmrf(target); // an incomplete earlier attempt (no valid manifest) is not a model
    fs.renameSync(tmp, target);
  } catch (e) {
    rmrf(tmp);
    try { fs.rmdirSync(path.dirname(target)); } catch { /* the parent holds other models, or is gone */ }
    return fail(e.message, files);
  }
  const { files: _drop, ...meta } = entry;
  const manifest = { ...meta, fetched_at: new Date().toISOString(), files };
  const mtmp = path.join(target, `${K.MANIFEST}.tmp`);
  fs.writeFileSync(mtmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(mtmp, path.join(target, K.MANIFEST));
  return { code: 0, verb: 'fetch', model: entry.id, sha: entry.sha, dir: target, already_present: false, files, total_bytes: files.reduce((n, f) => n + f.bytes, 0), total_ms: Date.now() - t0 };
}

async function verifyModel(entry) {
  const t0 = Date.now();
  const target = K.modelDir(entry);
  const files = [], bad = [];
  for (const f of entry.files) {
    const p = path.join(target, f.path);
    const s0 = Date.now();
    let r = null;
    try { r = await hashFile(p); } catch { /* absent */ }
    const ok = !!r && r.sha256 === f.sha256 && r.bytes === f.bytes;
    files.push({ path: f.path, bytes: r ? r.bytes : null, sha256: r ? r.sha256 : null, ok, ms: Date.now() - s0 });
    if (!ok) bad.push(!r ? `${f.path}: absent` : `${f.path}: sha256 ${r.sha256} bytes ${r.bytes}, the table says ${f.sha256} and ${f.bytes}`);
  }
  const chk = K.checkPresent(entry);
  if (chk.manifest_sha !== entry.sha) bad.push(`${K.MANIFEST}: names ${chk.manifest_sha || 'no sha'}, the table says ${entry.sha}`);
  return { code: bad.length ? 1 : 0, verb: 'verify', model: entry.id, sha: entry.sha, dir: target, verified: !bad.length, mismatches: bad, files, total_bytes: files.reduce((n, f) => n + (f.bytes || 0), 0), total_ms: Date.now() - t0 };
}

function render(r) {
  const lines = [];
  if (r.verb === 'fetch') {
    if (r.error) lines.push(`belay embedder fetch: FAILED ${r.error}`);
    else if (r.already_present) lines.push(`${r.model}@${r.sha.slice(0, 8)} already present at ${r.dir}; no request made`);
    else lines.push(`fetched ${r.model}@${r.sha.slice(0, 8)} into ${r.dir}: ${r.files.length} files, ${r.total_bytes} bytes, ${r.total_ms} ms`);
  } else {
    for (const f of r.files) lines.push(`  ${f.ok ? 'ok      ' : 'MISMATCH'} ${f.path}  ${f.bytes} bytes  ${f.ms} ms`);
    for (const m of r.mismatches) lines.push(`  ${m}`);
    lines.push(r.verified ? `verified ${r.model}@${r.sha.slice(0, 8)}: ${r.files.length} files, ${r.total_bytes} bytes, ${r.total_ms} ms` : `verify FAILED for ${r.model}@${r.sha.slice(0, 8)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function run(ctx) {
  const a = parseArgs(ctx.argv);
  if (a.error) return { code: 2, text: `belay embedder: ${a.error}\n\n${USAGE}`, json: { error: a.error } };
  const t = table();
  const id = a.model || t.def;
  if (!Object.prototype.hasOwnProperty.call(t.models, id)) {
    const message = `unknown embedding model ${JSON.stringify(id)}; the known ids are ${Object.keys(t.models).join(', ')}`;
    return { code: 2, text: `belay embedder: ${message}\n`, json: { error: message } };
  }
  const entry = t.models[id];
  const problems = M.entryProblems(entry);
  if (!problems.length && entry.id !== id) problems.push(`the entry's id ${JSON.stringify(entry.id)} is not its key ${JSON.stringify(id)}`);
  if (problems.length) {
    const message = `the model table entry ${JSON.stringify(id)} is unusable: ${problems.join('; ')}; nothing was written`;
    return { code: 2, text: `belay embedder: ${message}\n`, json: { error: message, problems } };
  }
  let r;
  try { r = a.verb === 'fetch' ? await fetchModel(entry, ctx) : await verifyModel(entry); }
  catch (e) {
    if (!e.receipt) throw e;
    r = e.receipt;
  }
  return { code: r.code, text: render(r), json: r };
}

module.exports = { run, takeLock };
