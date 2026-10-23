'use strict';
// transcript-usage.cjs — usage of an interactive orchestrator, read from its Claude Code session
// transcript (~/.claude/projects/<encoded cwd>/<session-id>.jsonl). A headless agent gets cost and context
// from its stream-json `result` lines; an interactive session writes none, only assistant lines whose
// message.usage carries the tokens of each API message.
//
// Context: the last assistant message's input + cache_creation + cache_read tokens (sidechain turns, which
// are a sub-agent's own context, and `<synthetic>` messages are skipped), the same sum cmd-agents.cjs
// takes from a stream. The window is NOT in a transcript; the caller borrows it as it does for any agent.
//
// Cost is an ESTIMATE from the transcript, not a figure Claude Code reported: the tokens of each distinct
// message.id (one API message spans several jsonl lines; the last line of an id has its final output
// count, and each id is counted once), priced per message with PRICES. Workers take total_cost_usd from
// their stream; this table exists only for the transcript. A model with no entry in PRICES (an alias such as
// "opus", or an unlisted id) shows its tokens and no dollars. The figures are API-rate estimates: a
// subscription user pays nothing per token.
//
// Reading never writes (invariant 6): the file is opened 'r' and nothing is created beside it. The whole file
// is parsed in 4 MB chunks on every call. A line with no newline yet is taken only if it parses as JSON.
//
// What it cannot see: /clear starts a NEW session file that belay does not know and does not follow, so after a
// /clear the figures stay those of the session belay launched. Compaction summaries and title calls are not
// in the transcript, so the estimate undercounts slightly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Dollars per million tokens, keyed by the exact message.model. Source: Anthropic first-party rates in Claude
// Code's bundled claude-api skill model table (cached 2026-10-06). A model with `tiers` is priced per message by
// its prompt size (input + cache_creation + cache_read): the first tier whose `up_to` is not exceeded.
const R = (input, output, cache_read, cache_write_5m, cache_write_1h) => ({ input, output, cache_read, cache_write_5m, cache_write_1h });
const PRICES = Object.freeze({
  'claude-opus-5-5': R(4, 20, 0.20, 5, 8),
  'claude-sonnet-5-5': R(2, 10, 0.20, 2.50, 4),
  'claude-fable-5-1': R(10, 50, 0.25, 12.50, 20),
  'claude-haiku-5-5': { tiers: [{ up_to: 100000, ...R(0.10, 0.50, 0.01, 0.125, 0.20) }, { up_to: Infinity, ...R(0.50, 2.50, 0.05, 0.625, 1.00) }] },
});

const CHUNK = 4 * 1024 * 1024;
const ASSISTANT = '"type":"assistant"';
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function newState() {
  return { offset: 0, ids: new Map(), byModel: new Map(), last: null, messages: 0, usd: 0, unpriced: new Map(), assumed5m: 0 };
}

function addTo(st, model, u, sign) {
  let m = st.byModel.get(model);
  if (!m) { m = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }; st.byModel.set(model, m); }
  m.input += sign * u.input; m.output += sign * u.output; m.cache_read += sign * u.cache_read; m.cache_creation += sign * u.cache_creation;
}

// false only for a line that looks like an assistant line and does not parse
function priceOf(prices, model, u) {
  const p = prices[model];
  if (!p) return null;
  if (!p.tiers) return p;
  const prompt = u.input + u.cache_read + u.cache_creation;
  return p.tiers.find((t) => prompt <= t.up_to) || null;
}

// Dollars of one message, and whether its cache writes had to be priced all at the 5m rate.
function messageUsd(prices, model, u) {
  const p = priceOf(prices, model, u);
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cc5m * p.cache_write_5m + u.cc1h * p.cache_write_1h) / 1e6;
}

// Subtract (sign -1) or add (+1) one message's tokens, dollars and unpriced mark.
function book(st, m, sign) {
  addTo(st, m.model, m.u, sign);
  if (m.usd === null) {
    const n = (st.unpriced.get(m.model) || 0) + sign;
    if (n > 0) st.unpriced.set(m.model, n); else st.unpriced.delete(m.model);
  } else st.usd += sign * m.usd;
  if (m.assumed) st.assumed5m += sign;
}

// false only for a line that looks like an assistant line and does not parse
function takeLine(st, line, prices) {
  if (!line.includes(ASSISTANT)) return true;
  let j;
  try { j = JSON.parse(line); } catch { return false; }
  if (!j || j.type !== 'assistant' || !j.message || !j.message.usage || typeof j.message.usage !== 'object') return true;
  const msg = j.message;
  const model = typeof msg.model === 'string' ? msg.model : null;
  if (model === null || model === '<synthetic>') return true;
  const uu = msg.usage;
  const cc = num(uu.cache_creation_input_tokens);
  const split = uu.cache_creation && typeof uu.cache_creation === 'object' && !Array.isArray(uu.cache_creation);
  const u = {
    input: num(uu.input_tokens), output: num(uu.output_tokens), cache_read: num(uu.cache_read_input_tokens), cache_creation: cc,
    cc5m: split ? num(uu.cache_creation.ephemeral_5m_input_tokens) : cc, cc1h: split ? num(uu.cache_creation.ephemeral_1h_input_tokens) : 0,
  };
  const m = { model, u, usd: messageUsd(prices, model, u), assumed: !split && cc > 0 };
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  if (id !== null) {
    const prev = st.ids.get(id);
    if (prev) book(st, prev, -1); else st.messages += 1;
    st.ids.set(id, m);
  } else st.messages += 1;
  book(st, m, 1);
  if (j.isSidechain !== true) st.last = { model, context: u.input + u.cache_read + u.cache_creation };
  return true;
}

// Consume [st.offset, size) of the file. Only whole lines advance the offset.
function advance(st, fd, size, prices) {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size - st.offset)));
  let carry = Buffer.alloc(0);
  let pos = st.offset;
  let bytes = 0;
  while (pos < size) {
    const want = Math.min(buf.length, size - pos);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    pos += n; bytes += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0;
    for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
      takeLine(st, data.toString('utf8', start, nl), prices);
      st.offset += nl + 1 - start;
      start = nl + 1;
    }
    carry = Buffer.from(data.subarray(start)); // copied: buf is reused by the next read
  }
  if (carry.length && pos >= size) {
    const text = carry.toString('utf8');
    let whole = false;
    try { JSON.parse(text); whole = true; } catch { /* the writer is mid-line: left for the next read */ }
    if (whole) { takeLine(st, text, prices); st.offset += carry.length; }
  }
  return bytes;
}

// Where a session transcript may live: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/. The path comes from a marker
// file in a directory anyone may write, so it is checked before anything touches it: a name ending .jsonl,
// lexically and then really (symlinks and junctions resolved) under the projects directory, and a regular file.
// A named pipe (//./pipe/x) or a directory is never opened.
function projectsRootOf(env = process.env, home = os.homedir()) {
  return path.join((env && env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude'), 'projects');
}
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const under = (root, file) => { const r = norm(path.resolve(root)); const f = norm(path.resolve(file)); return f.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

// null when the path may be read, else the reason it may not (always naming the root it was checked against).
// Opens nothing and follows no link: after the lexical checks, which refuse a pipe path before any filesystem call,
// the only calls are realpath of the DIRECTORY (compared with the real root) and lstat of the file itself, which
// does not follow it. A symlink or junction at the file is refused, so a link to a pipe is never stat-connected.
function refusal(file, root) {
  const at = ` (checked ${root})`;
  if (typeof file !== 'string' || !file) return `no session file path${at}`;
  if (!/\.jsonl$/i.test(file)) return `the session file name does not end in .jsonl${at}`;
  if (!under(root, file)) return `the session file is not under the Claude projects directory${at}`;
  let dir;
  try { dir = fs.realpathSync(path.dirname(file)); } catch (e) { return e.code === 'ENOENT' ? null : `the session file's directory cannot be resolved${at}`; }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return `the projects directory cannot be resolved${at}`; }
  if (!under(realRoot, path.join(dir, path.basename(file)))) return `the session file's directory resolves outside the Claude projects directory${at}`;
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? null : `the session file cannot be examined${at}`; }
  if (st.isSymbolicLink()) return `the session file is a link${at}`;
  if (!st.isFile()) return `the session file is not a regular file${at}`;
  return null;
}

// readUsage(file, prices?, { projectsRoot? }) -> { exists, refused, error, bytes_read, messages, model_seen, context_tokens, tokens, cost_usd, unpriced_models }
// Every call parses the whole file (50 MB in about 55 ms): the panel starts a new process per poll, so a cache of
// offsets would never be reused and there is none. Not followed: /clear starts a NEW session file that belay does not
// know; the figures stay those of the session belay launched. Not in the transcript: compaction summaries and title
// calls, so the estimate undercounts slightly.
function readUsage(file, prices = PRICES, opts = {}) {
  const none = { exists: false, refused: null, error: null, bytes_read: 0, messages: 0, model_seen: null, context_tokens: null, tokens: null, cost_usd: null, unpriced_models: [], cache_write_assumed_5m: 0 };
  const root = opts.projectsRoot || projectsRootOf();
  const why = refusal(file, root);
  if (why) return { ...none, refused: why };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return e.code === 'ENOENT' ? none : { ...none, error: e.code || 'unreadable' }; }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ...none, refused: 'the session file is not a regular file' };
    // The file opened is the file that was checked: the same device and inode as the real path, which is no link.
    const same = fs.statSync(fs.realpathSync(file), { bigint: true });
    const fsb = fs.fstatSync(fd, { bigint: true });
    if (same.ino !== fsb.ino || same.dev !== fsb.dev) return { ...none, refused: `the session file changed between the check and the open (checked ${root})` };
    const st = newState();
    const bytes_read = advance(st, fd, fst.size, prices);
    const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    for (const t of st.byModel.values()) { tokens.input += t.input; tokens.output += t.output; tokens.cache_read += t.cache_read; tokens.cache_creation += t.cache_creation; }
    const unpriced = [...st.unpriced.keys()];
    return {
      exists: true, refused: null, error: null, bytes_read, messages: st.messages,
      model_seen: st.last ? st.last.model : null, context_tokens: st.last ? st.last.context : null,
      tokens: st.messages ? tokens : null, cost_usd: st.messages && !unpriced.length ? st.usd : null, unpriced_models: unpriced, cache_write_assumed_5m: st.assumed5m,
    };
  } catch (e) {
    return { ...none, error: e.code || 'unreadable' };
  } finally { fs.closeSync(fd); }
}

function readSmall(file) {
  try { const st = fs.statSync(file); return st.isFile() && st.size <= 1024 * 1024 ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

// The session transcript of this run's interactive orchestrator: { file, refused }. Sources, in order: the launch
// marker (run-start.json, this run and epoch: its session_file, else a search for its session_id), then the
// closing receipt (run.json, this run: orchestrator.interactive.session_file). A path that fails `refusal` is
// never looked at (not even for existence); `refused` lists why.
function sessionFileOf(orchDir, run, opts = {}) {
  const root = opts.projectsRoot || projectsRootOf();
  const refused = [];
  const ok = (f) => { const why = refusal(f, root); if (why) { refused.push(why); return false; } return fs.existsSync(f); };
  const m = readSmall(`${orchDir}/run-start.json`);
  if (m && m.run_id === run.id && m.epoch === run.epoch) {
    if (typeof m.session_file === 'string' && ok(m.session_file)) return { file: m.session_file, refused };
    if (typeof m.session_id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(m.session_id)) {
      try {
        const found = require('../run/interactive-surface.cjs').findSessionFile({ projectsDir: opts.projectsRoot, cwd: '', sessionId: m.session_id });
        if (found && ok(found)) return { file: found, refused };
      } catch { /* fall through to the receipt */ }
    }
  }
  const r = readSmall(`${orchDir}/run.json`);
  const f = r && r.run_id === run.id && r.orchestrator && r.orchestrator.interactive && r.orchestrator.interactive.session_file;
  return { file: typeof f === 'string' && ok(f) ? f : null, refused };
}

module.exports = { readUsage, sessionFileOf, projectsRootOf, PRICES };
