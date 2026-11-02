'use strict';
// tree-guards.cjs — the guards a worktree removal takes before git is asked (ADR 0065 amendment 3): the pin that keeps a removed
// tree's head, the comparison of a worker's directory with a tree by real path, and the walk for links that stops on an error.
// Shared by every removal through removeTree (the run's close, the prune, `belay worktree remove`, the integration's removal).

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const G = require('./git.cjs');

const same = (a, b) => G.samePath(a, b);
const below = (p, dir) => { const a = G.fwd(p).replace(/\/+$/, ''), b = G.fwd(dir).replace(/\/+$/, ''); return same(a, b) || same(a.slice(0, b.length + 1), `${b}/`); };
const real = (p) => { try { return G.fwd(fs.realpathSync.native(p)); } catch { return null; } };

// The nearest ancestor of `p` that exists, resolved; null when none does.
function nearestReal(p) {
  let cur = path.resolve(p);
  for (;;) {
    const r = real(cur);
    if (r) return r;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// Whether a worker's recorded directory is `dir` or under it, by the recorded spelling or by real path (an 8.3 name, a junction, a
// subst drive, a `//?/` prefix or a trailing dot is another spelling of the same place). A directory that cannot be resolved (it was
// deleted) counts as possibly in the tree only when `runLive` says its run is live and its nearest existing ancestor resolves to the
// tree or under it: { match, unresolved }.
function workerInTree(cwd, dir, runLive) {
  if (below(cwd, dir)) return { match: true, unresolved: false };
  const rd = real(dir);
  if (!rd) return { match: false, unresolved: false };
  const rw = real(cwd);
  if (rw) return { match: below(rw, rd), unresolved: false };
  if (!runLive) return { match: false, unresolved: false };
  const anc = nearestReal(cwd);
  return anc && below(anc, rd) ? { match: true, unresolved: true } : { match: false, unresolved: false };
}

// Every link in `root` that is not in `recorded`, found by lstat and never followed. A directory or entry that cannot be read is an
// error, not a gap: a link in it would stop git removing the tree, or be followed (19-S5-3). A path that vanished meanwhile is not.
function strayLinks(root, recorded) {
  const known = new Set((recorded || []).map((j) => G.fwd(j.path).toLowerCase()));
  const found = [], stack = [root];
  const walkFailed = (p, e) => err('E_PRECONDITION', `${G.fwd(p)} could not be read (${e.code || e.message}), so belay cannot tell whether it holds a link; nothing was removed`, { walk_failed: true, path: G.fwd(p), error: e.code || e.message });
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw walkFailed(dir, e); }
    for (const d of entries) {
      const p = G.fwd(path.join(dir, d.name));
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw walkFailed(p, e); }
      if (st.isSymbolicLink()) { if (!known.has(p.toLowerCase())) found.push({ path: p }); continue; }
      if (st.isDirectory() && d.name !== '.git') stack.push(p);
    }
  }
  return found;
}

// Writes refs/belay/kept/<owner>/<sha12> at the tree's HEAD, so removing the tree (which deletes its own HEAD, index and reflog)
// leaves the commits named by a ref. `git update-ref <ref> <sha> ""` creates the ref only if it does not exist, in SHA-1 and SHA-256
// repositories alike; one that exists at the same sha (the name carries the sha) counts as pinned. The ref is read back. Throws
// E_GIT with detail.pin_failed when the head cannot be read or the ref cannot be written, naming the remedy.
async function pinHead(rec, owner) {
  const fail = (why) => err('E_GIT', `the head of ${rec.path} could not be pinned (${why}), so the tree was not removed; copy out what you want from it and delete it by hand, then run belay worktree remove <task-id> to record the removal`, { pin_failed: true, path: rec.path, owner, reason: why });
  const h = await G.run(rec.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = h.ok ? h.stdout.trim() : '';
  if (!sha) throw fail('HEAD names no commit: unborn or unreadable');
  const ref = `refs/belay/kept/${owner}/${sha.slice(0, 12)}`;
  const ok = await G.run(rec.repo, ['check-ref-format', ref]);
  if (!ok.ok) throw fail(`${ref} is not a valid ref name`);
  const w = await G.run(rec.repo, ['update-ref', ref, sha, '']);
  const back = await G.run(rec.repo, ['rev-parse', '--verify', '--quiet', ref]);
  if (!back.ok || back.stdout.trim() !== sha) throw fail(w.ok ? `${ref} reads back as another value` : `git update-ref: ${(w.stderr || '').split('\n')[0]}`);
  return { ref, sha };
}

module.exports = { workerInTree, strayLinks, pinHead, below, real };
