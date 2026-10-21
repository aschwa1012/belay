'use strict';
// cmd-memory-searchlog.cjs — `belay memory search-log --export <file> [--run <id>] [--since <ms|iso>] [--force]` (ADR 0050 decision 7).
// Mode R: it reads the search log (the memory_event rows of kind `search` and `index`) through memory.events on the store copy
// and starts no process. The one write is the export file the operator named, which an existing file blocks unless --force is given.
// Each line is one event: its columns, with the `message` JSON object parsed into `detail`. Oldest first.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = ['search', 'index'];

function lineOf(ev) {
  const { message, ...rest } = ev;
  let detail = null;
  if (typeof message === 'string') { try { detail = JSON.parse(message); } catch { detail = { unparsed: message }; } }
  return { ...rest, detail };
}

// Refuses an existing file before any store is opened; returns the resolved path or a failure.
function target(ctx, opts) {
  const out = path.resolve(ctx.cwd, opts.export);
  if (fs.existsSync(out) && !opts.force) {
    const message = `${out} exists; pass --force to overwrite it`;
    return { fail: { code: 1, text: `belay memory search-log: ${message}\n`, json: { error: { code: 'E_EXISTS', message } } } };
  }
  return { out };
}

async function doSearchLog(core, parsed, ctx) {
  const { opts } = parsed;
  const t = target(ctx, opts);
  if (t.fail) return t.fail;
  const args = { kinds: KINDS };
  if (opts.run) args.run_id = opts.run;
  const res = await core.memory.events(args);
  const evs = (res.events || []).filter(e => opts.since_ms === undefined || e.written_at >= opts.since_ms);
  const body = evs.map(e => JSON.stringify(lineOf(e))).join('\n');
  const text = body ? `${body}\n` : '';
  try {
    fs.writeFileSync(t.out, text, { flag: opts.force ? 'w' : 'wx' });
  } catch (e) {
    const exists = e.code === 'EEXIST';
    const message = exists ? `${t.out} exists; pass --force to overwrite it` : `cannot write ${t.out}: ${e.code || e.message}`;
    return { code: 1, text: `belay memory search-log: ${message}\n`, json: { error: { code: exists ? 'E_EXISTS' : e.code || 'E_INTERNAL', message } } };
  }
  const receipt = { out: t.out, count: evs.length, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), run: opts.run || null, since_ms: opts.since_ms ?? null, ...(res.table_absent ? { table_absent: true } : {}) };
  return { code: 0, text: `exported ${evs.length} search-log event${evs.length === 1 ? '' : 's'} to ${t.out}  bytes: ${receipt.bytes}  sha256: ${receipt.sha256.slice(0, 12)}\n`, json: receipt };
}

module.exports = { doSearchLog };
