'use strict';
// store-invariants.cjs — the store invariant oracle.
// checkStore(dir|db, opts) copies the database and its sidecars into a scratch folder, opens the COPY, runs `PRAGMA quick_check` and six
// row rules, and returns
//   { ok, status, violations:[{rule, ids, seq, detail}], errors:[{rule, reason}], skipped:[{rule, reason}], unproven:[...],
//     evaluated:{rule: n}, extra, rules_run, counts, torn, copies, hashes? }
// status is 'clean', 'violations', 'incomplete' (a rule could not run on a table that exists: a missing column, or it threw) or 'torn'
// (the source changed while it was copied, twice). ok is true only for 'clean'. A rule whose table is absent is `skipped` and named.
// `incomplete` is true whenever any rule errored, even when status is 'violations' (violations rank first in status).
// The copy is bracketed by a size-and-mtime signature of the db and all its sidecars, -shm included: a live reader of the original that only
// touches its shared-memory file can make a consistent copy read as torn. That fails safe (torn is never clean).
// The signature is size plus mtime, so a same-size rewrite inside one file-time tick (a WAL reset, say) can pass unseen: it narrows a torn copy, it does not rule one out.
// The original is never opened (invariant 6). Every table is an append-only version log (rows.cjs), so each rule is a linear scan in seq order.
// Rules (the `rule` field):
//   quick_check         PRAGMA quick_check answers 'ok'.
//   lease_single_live   at every lease row's seq, at most one worker lease per task is live: its latest version unreleased, unexpired at
//                       that row's written_at, and not named by a later grant's `supersedes` (a version written after that grant is live again).
//   lease_supersedes    a lease id's first row names, as `supersedes`, the id of the task's highest-seq lease row before it (null if none).
//   done_evidence       every task row in state 'done' carries results.executable and results.passed (methods-task.cjs evaluate).
//   run_single_end      per (run, epoch), ended_at goes from null to set at most once; a later change of its value is allowed once, by the
//                       operator (the run process closing what the orchestrator ended); later versions with the same value are allowed.
//                       opts.strictRunEnd flags any change after the first null-to-set.
//   worker_no_zombie    a live worker row after a terminal one of the same id must show a new life: a different pid or pid_created. Same pid
//                       with pid_created null on either row is `unproven`, not a violation (adopt() carries started_at over, so it is not evidence).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SUFFIXES = ['', '-wal', '-shm', '-journal'];
const COPIED = ['', '-wal', '-journal']; // the -shm is rebuilt by the first opener of the copy
const TERMINAL = new Set(['stopped', 'dead', 'forgotten']);
const LIVE = new Set(['starting', 'running', 'idle', 'stopping', 'paused']);
const RULES = ['quick_check', 'lease_single_live', 'lease_supersedes', 'done_evidence', 'run_single_end', 'worker_no_zombie'];
const NEEDS = { // the table and columns each rule reads
  lease_single_live: ['lease', ['seq', 'id', 'task_id', 'holder_role', 'released_at', 'expires_at', 'supersedes', 'written_at']],
  lease_supersedes: ['lease', ['seq', 'id', 'task_id', 'supersedes']],
  done_evidence: ['task', ['seq', 'id', 'state', 'results']],
  run_single_end: ['run', ['seq', 'id', 'epoch', 'ended_at', 'written_by']],
  worker_no_zombie: ['worker', ['seq', 'id', 'state', 'pid', 'pid_created']],
};

const resolveDb = (p) => { const r = path.resolve(p); return fs.existsSync(r) && fs.statSync(r).isDirectory() ? path.join(r, 'memory.db') : r; };
const sha256 = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
function hashOf(dbPath) { const out = {}; for (const s of SUFFIXES) out[s || 'db'] = sha256(dbPath + s); return out; }
function sigOf(dbPath) { // size and mtime of the db and its sidecars: cheap, taken before and after every copy
  return SUFFIXES.map((s) => { try { const st = fs.statSync(dbPath + s); return `${s}:${st.size}:${st.mtimeMs}`; } catch { return `${s}:-`; } }).join('|');
}

function openCopy(dbPath, scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'c-'));
  const copy = path.join(dir, 'memory.db');
  const clean = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    for (const s of COPIED) if (fs.existsSync(dbPath + s)) fs.copyFileSync(dbPath + s, copy + s);
    const db = new DatabaseSync(copy); // the copy is ours; opening it normally avoids the read-only mode that misses tables
    return { db, close() { try { db.close(); } catch { /* closed */ } clean(); } };
  } catch (e) { clean(); throw e; }
}

// One copy bracketed by a size-and-mtime signature of the source; null when the source changed meanwhile (the copy is dropped).
function copyOnce(dbPath, scratch, afterCopy) {
  const before = sigOf(dbPath), c = openCopy(dbPath, scratch);
  if (afterCopy) afterCopy(); // test seam: opts.afterCopy runs between the copy and the second signature
  if (sigOf(dbPath) === before) return c;
  c.close();
  return null;
}

const rowsOf = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const v = (rule, ids, seq, detail) => ({ rule, ids, seq, detail });
const columns = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));

function quickCheck(db) {
  let rs;
  try { rs = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]); } catch (e) { rs = ['quick_check threw: ' + e.message]; }
  return { violations: rs.length === 1 && rs[0] === 'ok' ? [] : [v('quick_check', [], null, rs.slice(0, 5).join('; '))], evaluated: 1 };
}

function leaseRules(db) {
  const out = [], byId = new Map(), superseded = new Map(), lastOfTask = new Map();
  let prefixes = 0, firsts = 0, excluded = 0;
  for (const l of rowsOf(db, 'SELECT * FROM lease ORDER BY seq')) {
    const first = !byId.has(l.id);
    if (first) {
      firsts++;
      const prev = lastOfTask.get(l.task_id), want = prev ? prev.id : null;
      if ((l.supersedes || null) !== want) out.push(v('lease_supersedes', [l.id], l.seq, `names ${l.supersedes || 'null'}, the task's current lease was ${want || 'none'}`));
    }
    byId.set(l.id, l);
    lastOfTask.set(l.task_id, l);
    if (l.supersedes && first) superseded.set(l.supersedes, l.seq);
    const live = [];
    prefixes++;
    for (const x of byId.values()) {
      if (x.task_id !== l.task_id || x.holder_role !== 'worker' || x.released_at != null) continue;
      const expired = x.expires_at != null && Number(x.expires_at) < Number(l.written_at);
      if (superseded.has(x.id) && superseded.get(x.id) > x.seq) { if (!expired) excluded++; continue; } // superseded by a later grant
      if (!expired) live.push(x.id);
    }
    if (live.length > 1) out.push(v('lease_single_live', live, l.seq, `${live.length} live worker leases on task ${l.task_id}`));
  }
  return {
    lease_single_live: { violations: out.filter((x) => x.rule === 'lease_single_live'), evaluated: prefixes, supersede_exclusions: excluded },
    lease_supersedes: { violations: out.filter((x) => x.rule === 'lease_supersedes'), evaluated: firsts },
  };
}

function doneEvidence(db) {
  const out = [];
  let n = 0;
  for (const t of rowsOf(db, "SELECT seq, id, results FROM task WHERE state = 'done' ORDER BY seq")) {
    n++;
    let r = null;
    try { r = t.results == null ? null : JSON.parse(t.results); } catch { /* unparsable counts as no evidence */ }
    if (!r || r.executable !== true || r.passed !== true) out.push(v('done_evidence', [t.id], t.seq, 'state done without results.executable and results.passed'));
  }
  return { violations: out, evaluated: n };
}

function runSingleEnd(db, strict) {
  const out = [], groups = new Map();
  for (const r of rowsOf(db, 'SELECT seq, id, epoch, ended_at, written_by FROM run ORDER BY seq')) {
    const k = r.id + '#' + r.epoch;
    if (!groups.has(k)) groups.set(k, { prev: null, sets: 0, over: 0, bad: [] });
    const g = groups.get(k);
    if (r.ended_at == null && g.prev != null) g.bad.push(`ended_at went from ${g.prev} back to null at seq ${r.seq} by ${r.written_by}`); // a lost end: a stale copy of the row written over it
    if (r.ended_at != null && r.ended_at !== g.prev) { // a transition of ended_at
      if (g.prev == null) { g.sets++; if (g.sets > 1) g.bad.push(`second null-to-set at seq ${r.seq} by ${r.written_by}`); }
      else {
        g.over++;
        if (strict || r.written_by !== 'operator' || g.over > 1) g.bad.push(`ended_at changed at seq ${r.seq} by ${r.written_by}`);
      }
    }
    g.prev = r.ended_at;
  }
  let ended = 0;
  for (const [k, g] of groups) {
    if (g.sets) ended++;
    if (g.bad.length) out.push(v('run_single_end', [k.split('#')[0]], null, `epoch ${k.split('#')[1]}: ${g.bad.join('; ')}`));
  }
  return { violations: out, evaluated: ended, overwrites: [...groups.values()].filter((g) => g.over).length };
}

function workerZombie(db) {
  const out = [], unproven = [], term = new Map(), flagged = new Set();
  let pairs = 0;
  for (const w of rowsOf(db, 'SELECT seq, id, state, pid, pid_created FROM worker ORDER BY seq')) {
    const t = term.get(w.id);
    if (t && LIVE.has(w.state) && !flagged.has(w.id)) {
      pairs++;
      if (w.pid === t.pid) {
        if (w.pid_created == null || t.pid_created == null) unproven.push({ rule: 'worker_no_zombie', id: w.id, seq: w.seq, reason: `same pid ${w.pid} and a null pid_created: reuse cannot be told from a zombie write` });
        else if (w.pid_created === t.pid_created) { flagged.add(w.id); out.push(v('worker_no_zombie', [w.id], w.seq, `${w.state} row after ${t.state} row (seq ${t.seq}) with the same pid ${w.pid} and creation time`)); }
      }
    }
    if (TERMINAL.has(w.state)) term.set(w.id, w); else if (LIVE.has(w.state)) term.delete(w.id);
  }
  return { violations: out, evaluated: pairs, unproven };
}

function checkStore(target, opts = {}) {
  const dbPath = resolveDb(target);
  if (!fs.existsSync(dbPath)) throw new Error('no database at ' + dbPath);
  const scratch = opts.scratch || path.join(os.tmpdir(), 'belay-inv');
  const hashes = opts.hashOriginals ? { before: hashOf(dbPath) } : null;
  const res = { ok: false, status: 'clean', violations: [], errors: [], skipped: [], unproven: [], evaluated: {}, extra: {}, rules_run: [], counts: {}, torn: false, copies: 1 };
  let c = copyOnce(dbPath, scratch, opts.afterCopy);
  if (!c) { res.copies = 2; c = copyOnce(dbPath, scratch, opts.afterCopy); } // retry once
  if (!c) {
    res.torn = true; res.status = 'torn';
    res.errors.push({ rule: 'copy', reason: 'the source changed during the copy, twice: no consistent copy was taken' });
    if (hashes) res.hashes = { ...hashes, after: hashOf(dbPath) };
    return res;
  }
  try {
    const have = new Set(rowsOf(c.db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
    for (const t of ['run', 'worker', 'task', 'lease']) if (have.has(t)) res.counts[t] = c.db.prepare('SELECT count(*) c FROM ' + t).get().c;
    const outs = {};
    for (const rule of RULES) {
      if (rule === 'quick_check') { outs[rule] = quickCheck(c.db); continue; }
      const [table, need] = NEEDS[rule];
      if (!have.has(table)) { res.skipped.push({ rule, reason: 'no table ' + table }); continue; }
      const cols = columns(c.db, table), miss = need.filter((x) => !cols.has(x));
      if (miss.length) { res.errors.push({ rule, reason: `table ${table} lacks column ${miss.join(', ')}` }); continue; }
      try {
        if (rule.startsWith('lease_')) { if (!outs.__lease) outs.__lease = leaseRules(c.db); outs[rule] = outs.__lease[rule]; }
        else if (rule === 'done_evidence') outs[rule] = doneEvidence(c.db);
        else if (rule === 'run_single_end') outs[rule] = runSingleEnd(c.db, !!opts.strictRunEnd);
        else outs[rule] = workerZombie(c.db);
      } catch (e) { res.errors.push({ rule, reason: 'threw: ' + String(e.message).slice(0, 120) }); }
    }
    for (const rule of RULES) {
      const o = outs[rule];
      if (!o) continue;
      res.rules_run.push(rule);
      res.violations.push(...o.violations);
      res.evaluated[rule] = o.evaluated;
      if (o.unproven) res.unproven.push(...o.unproven);
      for (const k of ['supersede_exclusions', 'overwrites']) if (o[k] != null) res.extra[k] = o[k];
    }
  } finally { c.close(); }
  res.status = res.violations.length ? 'violations' : res.errors.length ? 'incomplete' : 'clean';
  res.incomplete = res.errors.length > 0; // set whatever the status: a store with violations and errored rules is both
  res.ok = res.status === 'clean';
  if (hashes) res.hashes = { ...hashes, after: hashOf(dbPath) };
  return res;
}

// Teardown use: throws when the store in dir (or at a db path) breaks a rule; a missing store, an incomplete or a torn check is not a failure here.
// Every store under dir (the sandbox itself, or a data folder inside it, at most 4 levels down), for a sandbox teardown.
function assertStoresUnder(dir, opts = {}) {
  const found = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory() && depth < 4 && e.name !== 'node_modules' && e.name !== '.git') walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name === 'memory.db') found.push(path.join(d, e.name));
    }
  })(dir, 0);
  for (const f of found) assertStoreInvariants(f, opts);
  return found.length;
}

function assertStoreInvariants(target, opts = {}) {
  if (!fs.existsSync(resolveDb(target))) return null;
  const r = checkStore(target, opts);
  const skip = new Set(opts.ignoreRules || []);
  r.violations = r.violations.filter((x) => !skip.has(x.rule));
  if (r.violations.length) throw new Error('store invariants broken in ' + target + ': ' + r.violations.slice(0, 5).map((x) => x.rule + ' ' + (x.ids || []).join(',') + ' (' + x.detail + ')').join('; '));
  return r;
}

module.exports = { assertStoresUnder, assertStoreInvariants, checkStore, hashOf, sigOf, sha256, resolveDb, RULES, SUFFIXES };
