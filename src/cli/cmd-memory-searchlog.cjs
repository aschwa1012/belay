'use strict';
// cmd-memory-searchlog.cjs — `belay memory search-log --export <file> [--run <id>] [--since <ms|iso>] [--force]` (ADR 0050 decision 7).
// Mode R: it reads the search log (the memory_event rows of kind `search` and `index`) from a COPY of the store and its sidecars
// (copy-read.cjs, invariant 6), never from the owner, so a live owner's event loop is not asked to page a large log. Rows are iterated
// and written to the file one at a time. Each line is one event: its columns, `row_ids` and the `message` JSON object parsed
// (`detail`), oldest first. The one write is the file the operator named: it goes to a temp file beside the target and is moved
// into place, so a failed export leaves no half file. The target may not be inside the data directory, and an existing file needs --force.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withCopy } = require('../core/copy-read.cjs');

const FLUSH_BYTES = 64 * 1024;
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const fail = (code, message, exit) => ({ code: exit, text: `belay memory search-log: ${message}\n`, json: { error: { code, message } } });

function parseJson(s) { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return { unparsed: s }; } }
function lineOf(ev) {
  const { message, row_ids: ids, ...rest } = ev;
  return { ...rest, row_ids: parseJson(ids), detail: parseJson(message) };
}

// The output path, or a refusal: not inside the data dir (by real path, so a link into it does not slip by) and not an existing file
// without --force. Runs before any store is touched.
function target(ctx, dataDir, opts) {
  const out = path.resolve(ctx.cwd, opts.export);
  let parent;
  try { parent = fs.realpathSync(path.dirname(out)); } catch (e) { return { fail: fail('E_NOT_FOUND', `cannot write ${out}: the directory does not exist`, 1) }; }
  let data = path.resolve(dataDir);
  try { data = fs.realpathSync(data); } catch { /* no data dir: nothing can be inside it */ }
  let real = path.join(parent, path.basename(out));
  try { real = fs.realpathSync(real); } catch { /* not there yet */ }
  const rel = path.relative(norm(data), norm(real));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { fail: fail('E_ARGS', `${out} is inside the data directory ${dataDir}; the export goes somewhere else`, 2) };
  if (fs.existsSync(out) && !opts.force) return { fail: fail('E_EXISTS', `${out} exists; pass --force to overwrite it`, 1) };
  return { out };
}

function readInto(dataDir, opts, emit) {
  const src = path.join(dataDir, 'memory.db');
  if (!fs.existsSync(src)) return Promise.resolve({ table_absent: true });
  const { Store } = require('../core/store.cjs');
  return withCopy(dataDir, async (dbPath) => {
    const store = new Store(dbPath);
    try {
      const where = ["kind IN ('search', 'index')"], params = [];
      if (opts.run) { where.push('run_id = ?'); params.push(opts.run); }
      if (opts.since_ms !== undefined) { where.push('written_at >= ?'); params.push(opts.since_ms); }
      try {
        for (const row of store.db.prepare(`SELECT * FROM memory_event WHERE ${where.join(' AND ')} ORDER BY seq`).iterate(...params)) emit(row);
      } catch (e) {
        if (/no such table/i.test(String(e && e.message))) return { table_absent: true };
        throw e;
      }
      return {};
    } finally { try { store.close(); } catch { /* throwaway copy */ } }
  });
}

async function run(ctx, parsed, dataDir) {
  const { opts } = parsed;
  const t = target(ctx, dataDir, opts);
  if (t.fail) return t.fail;
  const tmp = `${t.out}.tmp-${process.pid}`;
  const hash = crypto.createHash('sha256');
  let fd = null, buf = '', count = 0, bytes = 0, extra = {};
  const flush = () => { if (!buf) return; hash.update(buf); bytes += Buffer.byteLength(buf); fs.writeSync(fd, buf); buf = ''; };
  try {
    fd = fs.openSync(tmp, 'wx');
    extra = await readInto(dataDir, opts, (row) => { buf += `${JSON.stringify(lineOf(row))}\n`; count += 1; if (buf.length >= FLUSH_BYTES) flush(); });
    flush();
    fs.closeSync(fd); fd = null;
    if (opts.force) fs.renameSync(tmp, t.out);
    else { fs.linkSync(tmp, t.out); fs.unlinkSync(tmp); } // a link refuses an existing file atomically
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* none made */ }
    const exists = e.code === 'EEXIST';
    return fail(exists ? 'E_EXISTS' : e.code || 'E_INTERNAL', exists ? `${t.out} exists; pass --force to overwrite it` : `cannot write ${t.out}: ${e.code || e.message}`, 1);
  }
  const receipt = { out: t.out, count, bytes, sha256: hash.digest('hex'), run: opts.run || null, since_ms: opts.since_ms ?? null, ...extra };
  return { code: 0, text: `exported ${count} search-log event${count === 1 ? '' : 's'} to ${t.out}  bytes: ${bytes}  sha256: ${receipt.sha256.slice(0, 12)}\n`, json: receipt };
}

module.exports = { run };
