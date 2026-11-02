'use strict';
// sweep-store-invariants.cjs — run the store invariant oracle (tests/helpers/store-invariants.cjs) over every kept belay store.
// usage: node scripts/sweep-store-invariants.cjs --root <dir> [--root <dir>]... [--out <file.md>] [--json <file.json>]
//          [--strict-run-end] [--run-dir-fresh-min N] [--scratch <dir>]
// At least one --root is required (no default). A store is a file named memory.db (src/core names it so). Each is read from a copy made
// under a fresh sweep-* folder made inside the scratch path (default: belay-inv-sweep in the OS temp folder). Only that fresh folder is removed, in a finally block; the path the caller names is never emptied or removed.
// The db and its sidecars are hashed and the directory listing compared before and after; a change, or a copy that was torn twice, is
// reported as "source changed" (the oracle writes nothing, so it names a writer) and exits 2. A store whose owner.lock / owner.json / *.lock
// is younger than 10 minutes, or whose db or -wal changed in that time, may have an active writer: it is skipped and listed. With
// --run-dir-fresh-min N the run directory (first folder under a root) is skipped if any file in it changed within N minutes.
// The report carries, per rule, how many things it evaluated, so a rule that met nothing is named vacuous.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkStore, RULES } = require('../tests/helpers/store-invariants.cjs');

const FRESH_MS = 10 * 60 * 1000;
const args = process.argv.slice(2);
const roots = [], o = { strict: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i]);
  else if (args[i] === '--out') o.out = args[++i];
  else if (args[i] === '--json') o.json = args[++i];
  else if (args[i] === '--scratch') o.scratch = args[++i];
  else if (args[i] === '--strict-run-end') o.strict = true;
  else if (args[i] === '--run-dir-fresh-min') o.runDirMin = Number(args[++i]);
}
if (!roots.length) { console.error('usage: sweep-store-invariants.cjs --root <dir> [--root <dir>]... (a root is required)'); process.exit(64); }
const scratchParent = path.resolve(o.scratch || path.join(os.tmpdir(), 'belay-inv-sweep'));

function find(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) find(p, out);
    else if (e.name === 'memory.db') out.push(p);
  }
}

function newest(p) { // newest mtime of a file, or of anything one level inside a directory
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.mtimeMs;
    let m = st.mtimeMs;
    for (const n of fs.readdirSync(p)) { try { m = Math.max(m, fs.statSync(path.join(p, n)).mtimeMs); } catch { /* gone */ } }
    return m;
  } catch { return 0; }
}

function activeReason(db, now) {
  const dir = path.dirname(db);
  for (const n of fs.readdirSync(dir)) {
    if (/^owner\.(lock|json)$/.test(n) || /\.lock$/.test(n)) {
      if (now - newest(path.join(dir, n)) < FRESH_MS) return `${n} younger than 10 min`;
    }
  }
  for (const s of ['', '-wal']) {
    try { if (now - fs.statSync(db + s).mtimeMs < FRESH_MS) return `memory.db${s} written within 10 min`; } catch { /* absent */ }
  }
  return null;
}

const runDirCache = new Map();
function newestDeep(dir) {
  let m = 0, ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return Date.now(); }
  for (const e of ents) { const p = path.join(dir, e.name); try { m = Math.max(m, e.isDirectory() ? newestDeep(p) : fs.statSync(p).mtimeMs); } catch { /* gone */ } }
  return m;
}
function runDirReason(db, now) {
  if (!o.runDirMin) return null;
  const abs = path.resolve(db);
  for (const r of roots.map((x) => path.resolve(x))) {
    const rel = path.relative(r, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.includes(path.sep)) continue;
    const dir = path.join(r, rel.split(path.sep)[0]);
    if (!runDirCache.has(dir)) runDirCache.set(dir, newestDeep(dir));
    return now - runDirCache.get(dir) < o.runDirMin * 60000 ? `a file in run directory ${path.basename(dir)} changed within ${o.runDirMin} min` : null;
  }
  return null;
}

const listing = (dir) => fs.readdirSync(dir).sort().join('|');

const found = [];
for (const r of roots) find(path.resolve(r), found);
const t0 = Date.now(), now = Date.now();
const results = [], skipped = [], changed = [];
fs.mkdirSync(scratchParent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchParent, 'sweep-')); // ours alone: the only thing this script removes
try {
  for (const db of found) {
    let why = null;
    try { why = runDirReason(db, now) || activeReason(db, now); } catch (e) { why = 'unreadable dir: ' + e.message; }
    if (why) { skipped.push({ db, reason: why }); continue; }
    const dir = path.dirname(db), listBefore = listing(dir), t = Date.now();
    let res;
    try { res = checkStore(db, { hashOriginals: true, strictRunEnd: o.strict, scratch }); } catch (e) { results.push({ db, status: 'error', error: e.message, violations: [] }); continue; }
    const same = JSON.stringify(res.hashes.before) === JSON.stringify(res.hashes.after) && listBefore === listing(dir);
    if (!same || res.torn) changed.push(db);
    results.push({ db, ms: Date.now() - t, status: res.status, ok: res.ok, violations: res.violations, errors: res.errors, unproven: res.unproven, evaluated: res.evaluated, extra: res.extra, counts: res.counts, rules_run: res.rules_run.length, skipped_rules: res.skipped.map((s) => s.rule), torn: res.torn, copies: res.copies, unchanged: same });
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); } // the fresh sweep-* folder, never scratchParent

const perRule = Object.fromEntries(RULES.map((r) => [r, { stores_evaluated: 0, evaluated: 0, stores_with_violations: 0, violations: 0, stores_absent: 0, stores_errored: 0 }]));
for (const r of results) {
  for (const [rule, n] of Object.entries(r.evaluated || {})) { perRule[rule].evaluated += n; if (n) perRule[rule].stores_evaluated++; }
  for (const x of r.violations || []) perRule[x.rule].violations++;
  for (const rule of new Set((r.violations || []).map((x) => x.rule))) perRule[rule].stores_with_violations++;
  for (const s of r.skipped_rules || []) perRule[s].stores_absent++;
  for (const e of r.errors || []) if (perRule[e.rule]) perRule[e.rule].stores_errored++;
}
const vacuous = RULES.filter((r) => perRule[r].evaluated === 0);
const rowTotals = {}, populated = {};
for (const r of results) for (const [t, n] of Object.entries(r.counts || {})) { rowTotals[t] = (rowTotals[t] || 0) + n; if (n) populated[t] = (populated[t] || 0) + 1; }
const bad = results.filter((r) => r.violations && r.violations.length);
const perRoot = {};
for (const r of roots.map((x) => path.resolve(x))) {
  const inRoot = (p) => !path.relative(r, path.resolve(p)).startsWith('..');
  perRoot[r] = { found: found.filter(inRoot).length, checked: results.filter((x) => inRoot(x.db)).length, skipped: skipped.filter((x) => inRoot(x.db)).length };
}
const unprovenN = results.reduce((a, r) => a + (r.unproven || []).length, 0);
const summary = {
  per_root: perRoot, found: found.length, checked: results.length, skipped_active: skipped.length,
  statuses: results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
  with_violations: bad.length, incomplete_stores: results.filter((r) => r.errors && r.errors.length).length, source_changed_or_torn: changed.length, unproven_pairs: unprovenN, vacuous_rules: vacuous,
  elapsed_ms: Date.now() - t0, strict_run_end: o.strict, row_totals: rowTotals, stores_with_rows: populated,
};

const lines = ['# store-invariants sweep', '', '```json', JSON.stringify(summary, null, 1), '```', '', '## Per rule', '',
  '| rule | evaluated (units) | stores evaluated | violations | stores with violations | stores: table absent | stores: rule errored |', '|---|---|---|---|---|---|---|'];
for (const r of RULES) { const p = perRule[r]; lines.push(`| ${r} | ${p.evaluated} | ${p.stores_evaluated} | ${p.violations} | ${p.stores_with_violations} | ${p.stores_absent} | ${p.stores_errored} |`); }
lines.push('', 'Units: quick_check 1 per store; lease_single_live lease-row prefixes; lease_supersedes first rows of a lease id; done_evidence done rows; run_single_end epochs ended; worker_no_zombie live-after-terminal pairs.');
if (vacuous.length) lines.push('', `Vacuous (evaluated nothing in this sweep): ${vacuous.join(', ')}.`);
lines.push('', '## Violations', '', '| store | rule | ids | seq | detail |', '|---|---|---|---|---|');
for (const r of bad) for (const x of r.violations) lines.push(`| ${r.db} | ${x.rule} | ${(x.ids || []).slice(0, 4).join(', ')} | ${x.seq} | ${String(x.detail).replace(/\|/g, '/')} |`);
if (!bad.length) lines.push('| (none) | | | | |');
const incomplete = results.filter((r) => r.errors && r.errors.length);
lines.push('', '## Incomplete (a rule could not run on a table that exists)', '', '| store | rule | reason |', '|---|---|---|');
for (const r of incomplete) for (const e of r.errors) lines.push(`| ${r.db} | ${e.rule} | ${e.reason} |`);
if (!incomplete.length) lines.push('| (none) | | |');
lines.push('', '## Skipped (possible active writer)', '', '| store | reason |', '|---|---|');
for (const s of skipped) lines.push(`| ${s.db} | ${s.reason} |`);
if (!skipped.length) lines.push('| (none) | |');
if (changed.length) { lines.push('', '## Source changed during or after the copy (torn copy; the oracle writes nothing)', ''); for (const c of changed) lines.push('- ' + c); }
const text = lines.join('\n') + '\n';
if (o.out) fs.writeFileSync(o.out, text);
if (o.json) fs.writeFileSync(o.json, JSON.stringify({ summary, perRule, skipped, results }, null, 1));
console.log(text.split('\n').slice(0, 60).join('\n'));
process.exit(changed.length ? 2 : 0);
