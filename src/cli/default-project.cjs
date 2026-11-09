'use strict';
// default-project.cjs — ADR 0041 amendment (ADR 0088): the project name a run or `belay init` uses when none is set. From the
// `origin` remote's owner and repository, read as text from the git config on disk (no git process, no network); else the folder's name.
// The name is made to fit the project rule (lower-case letters, digits, dot, underscore, dash). Returns { name, source }: always a valid key.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fit(s) {
  const t = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 64).replace(/[^a-z0-9]+$/, '');
  return PROJECT_RE.test(t) ? t : null;
}

// The nearest `.git` at or above dir: { top, gitDir } where gitDir is the repository's own folder, or null.
function findGit(dir) {
  for (let d = path.resolve(dir), prev = null; d !== prev; prev = d, d = path.dirname(d)) {
    const g = path.join(d, '.git');
    let st;
    try { st = fs.statSync(g); } catch { continue; }
    if (st.isDirectory()) return { top: d, gitDir: g };
    try { // a linked worktree: ".git" is a file naming its folder
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      if (m) return { top: d, gitDir: path.resolve(d, m[1].trim()) };
    } catch { /* unreadable: keep looking */ }
  }
  return null;
}

function configOf(gitDir) {
  let dir = gitDir;
  try { dir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
  try { return fs.readFileSync(path.join(dir, 'config'), 'utf8'); } catch { return ''; }
}

// owner/repo of the url of [remote "origin"], or null.
function originOf(config) {
  const m = /^\s*\[remote\s+"origin"\]([^[]*)/m.exec(config);
  const u = m && /^\s*url\s*=\s*(.+?)\s*$/m.exec(m[1]);
  if (!u) return null;
  const tail = u[1].replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '').replace(/^[^/@\s]+@[^:/\s]+:/, '');
  const parts = tail.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function derive(dir) {
  const git = findGit(dir);
  const remote = git ? originOf(configOf(git.gitDir)) : null;
  const fromRemote = remote ? fit(remote.replace('/', '-')) : null;
  if (fromRemote) return { name: fromRemote, source: `git remote origin ${remote}` };
  const top = git ? git.top : path.resolve(dir);
  const folder = path.basename(top);
  const fromFolder = fit(folder);
  if (fromFolder) return { name: fromFolder, source: `folder name ${folder}` };
  // A folder name with nothing a project key may hold (only symbols, or letters with no ASCII form): a name from a hash of the folder path.
  const name = 'project-' + crypto.createHash('sha256').update(top.split(path.sep).join('/')).digest('hex').slice(0, 8);
  return { name, source: `hash of the folder path ${top.split(path.sep).join('/')} (the folder name ${folder} has no usable characters)` };
}

module.exports = { derive, originOf, fit };
