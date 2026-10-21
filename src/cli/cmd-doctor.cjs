'use strict';
// cmd-doctor.cjs — CLI slice 3a, mode R unless --fix. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit, always returning the
// receipt that proves what happened (invariant 5). The acceptance criterion is
// tests/cli/slice-3a.test.cjs, written before this file and not edited to make it pass.
//
// command table §3: reads config, store and substrate binaries; per check a verdict and the
// evidence; read-only unless --fix. Two rules shape every line below.
//
// P8, the truth ladder: no check prints a bare word. `verdict` is never returned without `evidence`
// saying what established it — a path that was stat'd, a parse that failed and why, a directory that
// was looked for and is not there. The default is read-only: a diagnostic that repairs things
// nobody asked it to is worse than none.
//
// The 300 ms cold-start budget (command table §5) is why nothing here spawns. A substrate binary is
// checked by stat, and the evidence says so in as many words: this establishes that a file is on
// disk at the path the launch table names, not that it runs. `belay mcp status --deep` is the
// command that pays a process to find out whether something answers.

const fs = require('node:fs');

const C = require('./config.cjs');

const OK = 'ok';
const MISSING = 'missing';
const ERROR = 'error';

function statOf(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// One row. `fixable` is stated on every check so that `--fix` never has to guess, and so that a
// reader can see which findings it would have left alone.
function row(check, verdict, evidence, extra = {}) {
  return { check, verdict, evidence, fixable: false, ...extra };
}

function configChecks(found) {
  const out = [];
  if (found.found) {
    out.push(row('config-present', OK, `read ${found.path}`, { path: found.path }));
    out.push(found.parse_error
      ? row('config-parses', ERROR, found.parse_error, { path: found.path })
      : row('config-parses', OK, `parsed as a JSON object with ${Object.keys(found.config).length} key(s)`, { path: found.path }));
  } else {
    out.push(row('config-present', MISSING,
      `no ${C.CONFIG_NAME} in ${found.searched.length} director${found.searched.length === 1 ? 'y' : 'ies'} up to ${found.stopped_because}; last looked at ${found.searched[found.searched.length - 1] || found.stopped_at}`,
      { searched: found.searched, fix: 'belay init' }));
    out.push(row('config-parses', MISSING, 'there is no config file to parse'));
  }
  return out;
}

function storeChecks(dataDir) {
  const dir = statOf(dataDir);
  const out = [];
  if (dir && dir.isDirectory()) {
    out.push(row('data-dir', OK, `${dataDir} exists`, { path: dataDir }));
  } else if (dir) {
    out.push(row('data-dir', ERROR, `${dataDir} exists but is not a directory`, { path: dataDir }));
  } else {
    // The one finding --fix can repair: creating an empty directory is not a repair of anyone's
    // data.
    out.push(row('data-dir', MISSING, `${dataDir} does not exist`, { path: dataDir, fixable: true, fix: 'mkdir' }));
  }

  const dbPath = `${dataDir}/memory.db`;
  const db = statOf(dbPath);
  out.push(db
    ? row('store-db', OK, `memory.db is ${db.size} bytes`, { path: dbPath, bytes: db.size })
    // No store is the normal state before anything has run. It is reported, not scolded: the core
    // creates it on first write (api.md §1) and invariant 2 forbids a read path from doing so.
    : row('store-db', MISSING, `no memory.db at ${dbPath}; the store is created by the first write, and no read path may create it`, { path: dbPath }));
  return out;
}

function substrateChecks(found) {
  const L = require('../run/launch.cjs');
  const ED = require('../run/exe-discovery.cjs');
  const out = [];
  for (const [check, which] of [['claude-binary', 'claude'], ['codex-binary', 'codex']]) {
    const eff = C.effective(found, ED.SPECS[which].key, {});
    const r = ED.resolveTool(which, { configured: eff && eff.resolved ? eff.resolved : null });
    if (!r.path) { out.push(row(check, MISSING, r.error, { path: null })); continue; }
    const st = statOf(r.path);
    const from = r.source === 'config' ? `configured in ${eff.source}` : r.source === 'env' ? `from ${ED.SPECS[which].env}` : 'found on PATH';
    out.push(st
      ? row(check, OK, `a file of ${st.size} bytes is at ${r.path} (${from}); stat only, so this does not establish that it runs`, { path: r.path, source: r.source, bytes: st.size })
      : row(check, MISSING, `nothing at ${r.path} (${from})`, { path: r.path, source: r.source }));
  }
  const adapter = L.mcpServerPath();
  const st = statOf(adapter);
  out.push(st
    ? row('mcp-adapter', OK, `the belay MCP adapter is at ${adapter}, ${st.size} bytes`, { path: adapter, bytes: st.size })
    : row('mcp-adapter', ERROR, `the belay MCP adapter is missing from ${adapter}; this is a broken installation, not a configuration problem`, { path: adapter }));
  return out;
}

// ADR 0027: is the embedding package installed and the default model in belay's cache? Stat only. It
// never requires embedder.cjs or the library (invariant 9), and absence is a finding that names its fix,
// not a failure: a harness without an embedder still runs, and its vector calls are refused E_MODEL_ABSENT.
function embedderChecks() {
  const M = require('../core/models.cjs');
  const K = require('../core/model-cache.cjs');
  const entry = M.MODELS[M.DEFAULT_MODEL];
  const found = K.packageInfo();
  const pkg = K.packageDir();
  const chk = K.checkPresent(entry);
  if (pkg && chk.present) {
    return [row('embedder', OK, `${K.PKG_NAME} is at ${pkg} and ${entry.id}@${entry.sha.slice(0, 8)} is in the model cache at ${chk.dir} (stat only: every file at the table's size and the manifest naming the table's commit; nothing was hashed or loaded)`, { path: chk.dir, package: pkg })];
  }
  const fixes = [];
  if (!pkg) fixes.push('npm install');
  if (!chk.present) fixes.push(`belay embedder fetch`);
  const why = [
    pkg ? null : (found ? `${K.PKG_NAME} at ${found.dir} is version ${found.version} and belay pins ${K.PKG_VERSION}` : `${K.PKG_NAME} is not installed in belay's node_modules`),
    chk.present ? null : `${entry.id} is not in the model cache at ${chk.dir} (${[...chk.missing, ...chk.wrong_size.map(p => `${p} wrong size`)].join(', ')})`,
  ].filter(Boolean).join('; ');
  return [row('embedder', MISSING, `${why}; vector calls are refused E_MODEL_ABSENT until fixed: run ${fixes.join(' then ')}`, { path: chk.dir, package: pkg, fix: fixes.join(' then ') })];
}

// ADR 0043 decision 3: is the keyword index there? Reads `meta.memory_fts_version` out of a copy of the
// store (invariant 6: never the live file, no sidecar), with a plain handle so nothing migrates the copy.
// '1' is present, '0' is an owner that found no FTS5 in this SQLite, no marker is an index nobody built yet.
// Imports no embedder: the copy reader and node:sqlite only.
const ABSENT = 'absent (no owner has opened this store since the index landed)';

async function memoryIndexCheck(dataDir) {
  const dbPath = `${dataDir}/memory.db`;
  if (!statOf(dbPath)) return row('memory-index', MISSING, `${ABSENT}; there is no memory.db at ${dbPath} yet`, { path: dbPath, state: 'absent' });
  try {
    const { withCopy } = require('../core/copy-read.cjs');
    const { DatabaseSync } = require('node:sqlite');
    const marker = await withCopy(dataDir, async (copy) => {
      const db = new DatabaseSync(copy);
      try {
        if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return null;
        const r = db.prepare("SELECT value FROM meta WHERE key = 'memory_fts_version'").get();
        return r ? String(r.value) : null;
      } finally { db.close(); }
    });
    if (marker === '1') return row('memory-index', OK, 'present (meta.memory_fts_version is 1, read from a copy of the store; the index itself was not opened)', { path: dbPath, state: 'present' });
    if (marker === '0') return row('memory-index', ERROR, 'unsupported (FTS5 not compiled): meta.memory_fts_version is 0, so keyword and hybrid search report E_NO_INDEX on this machine', { path: dbPath, state: 'unsupported' });
    return row('memory-index', MISSING, `${ABSENT}${marker === null ? '' : `; meta.memory_fts_version is ${JSON.stringify(marker)}, which this build does not know`}`, { path: dbPath, state: 'absent' });
  } catch (e) {
    return row('memory-index', ERROR, `the store could not be copied and read: ${e.message}`, { path: dbPath });
  }
}

function applyFix(checks) {
  const fixed = [];
  for (const c of checks) {
    if (!c.fixable || c.verdict === OK) continue;
    if (c.check === 'data-dir') {
      fs.mkdirSync(c.path, { recursive: true });
      c.verdict = OK;
      c.evidence = `${c.path} did not exist and --fix created it`;
      c.fixed = true;
      fixed.push(c.check);
    }
  }
  return fixed;
}

// A warning in the table's own terms: `missing` (nothing is broken, a thing is not set), with the fix line.
function memoryProjectCheck(found) {
  const n = require('../core/memory-notice.cjs').noticeForConfig(found);
  return n
    ? row('memory-project', MISSING, `${n.title} (checked in the config file only; a run whose spec sets memory.project has notes on). ${n.why} ${n.fix}`, { fix: n.config_line, notice: n })
    : row('memory-project', OK, 'notes are off, or memory.project is set in the config file');
}

async function run(ctx) {
  if (ctx.argv.length) {
    const message = `unknown argument ${ctx.argv[0]}`;
    return {
      code: 2,
      text: `belay doctor: ${message}\n\nusage: belay doctor [--fix] [--data <dir>] [--json]\n`,
      json: { error: message },
    };
  }

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);
  const checks = [...configChecks(found), ...storeChecks(dataDir), ...substrateChecks(found), ...embedderChecks(), await memoryIndexCheck(dataDir), memoryProjectCheck(found)];

  const fixed = ctx.fix ? applyFix(checks) : [];

  const counts = { ok: 0, missing: 0, error: 0 };
  for (const c of checks) counts[c.verdict] = (counts[c.verdict] || 0) + 1;

  const payload = {
    // An inspection that ran is a success even when everything it found is broken: a dead system is
    // a valid answer (ADR 0010 §2), and an unconfigured directory is a finding rather than a usage
    // error. `code` stays 0 and the verdict lives in the rows.
    checks,
    counts,
    data_dir: dataDir,
    config_path: found.path,
    mode: ctx.fix ? 'fix' : 'read-only',
    fixed,
  };
  if (ctx.json) return { code: 0, text: '', json: payload };

  const width = Math.max(...checks.map((c) => c.check.length));
  const lines = [
    found.found ? `config: ${found.path}` : 'config: none found',
    `store:  ${dataDir}`,
    `mode:   ${payload.mode}`,
    '',
    ...checks.map((c) => `  ${c.verdict.padEnd(7)} ${c.check.padEnd(width)}  ${c.evidence}`),
    '',
    `${counts.ok} ok, ${counts.missing || 0} missing, ${counts.error || 0} error`
      + (fixed.length ? `; --fix repaired ${fixed.join(', ')}` : ''),
    '',
  ];
  return { code: 0, text: lines.join('\n'), json: payload };
}

module.exports = { run };
