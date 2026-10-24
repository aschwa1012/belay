'use strict';
// copy-sweep.cjs — reclaim the temp copies a killed read left behind (copy-read.cjs).
//
// A read killed mid-read never reaches withCopy's `finally`, so its temp dir (a full store copy)
// stays. Copies live under one parent, `<tmp>/belay-ro/<pid>-<random>`, so a sweep reads only that
// small directory. An entry goes only if its pid is dead (exact pid check) AND it is older than 60 s;
// a reused pid keeps a dir, the safe direction. The current process's own pid is always alive to
// `process.kill(pid, 0)`, so that one check also protects the process's own entries.
// Bounded: at most MAX_EXAMINE dead-pid candidates are examined (live, foreign-named and fresh
// entries do not use the cap, so stuck entries at the front cannot starve the rest), at most
// MAX_NAMES names are looked at, and the time budget caps both. Every error is swallowed: a failed
// sweep never fails the read. It creates nothing: a read creates no file (invariant 2).

const fs = require('node:fs');
const path = require('node:path');

const PARENT = 'belay-ro';
const ENTRY_RE = /^(\d+)-[A-Za-z0-9]{6}$/;
const MAX_EXAMINE = 20;
const MAX_NAMES = 200;
const MIN_AGE_MS = 60 * 1000;
const TIME_BUDGET_MS = 40;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } }

function sweep(root, opts = {}) {
  const now = opts.now !== undefined ? opts.now : Date.now();
  const alive = opts.alive || pidAlive;
  const started = Date.now();
  const out = { examined: 0, removed: 0 };
  try {
    const parent = path.join(root, PARENT);
    let names = [];
    try { names = fs.readdirSync(parent); } catch { return out; }
    let looked = 0;
    for (const name of names) {
      if (out.examined >= MAX_EXAMINE || ++looked > MAX_NAMES || Date.now() - started > TIME_BUDGET_MS) break;
      try {
        const m = ENTRY_RE.exec(name);
        if (!m || alive(Number(m[1]))) continue;
        out.examined++;
        const p = path.join(parent, name);
        if (now - fs.statSync(p).mtimeMs < MIN_AGE_MS) continue;
        if (rm(p)) out.removed++;
      } catch { /* next entry */ }
    }
  } catch { /* a failed sweep never fails the read */ }
  return out;
}

module.exports = { sweep, pidAlive, PARENT, MAX_EXAMINE, MAX_NAMES, MIN_AGE_MS };
