'use strict';
// memory-summaries.cjs — ADR 0047 decision 1: with the `notes` lever on, a run summary is written to `summary/<project>`,
// where the index and the default search never look, and is found on demand by this lookup. The briefing on resume
// (continuity.resumeDoc) reads the same `find`. A read: every statement is a SELECT, and nothing here needs the embedder.
//
// `files` are matched worktree-relative: a summary matches when a file it records (the files it modified or looked
// at) is one of the given paths or under one of them. A path recorded absolute is not relativised (the summary does
// not know the worktree), so it matches only when given the same way.

const { err } = require('./errors.cjs');
const { projectOf } = require('./memory-reach.cjs');

const LIMIT_DEFAULT = 10, LIMIT_MAX = 50, SCAN_MAX = 500, FILES_MAX = 50, TEXT_MAX = 4096;
const norm = p => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const under = (file, paths) => { const f = norm(file); return paths.some(p => f === p || f.startsWith(`${p}/`)); };
const parse = s => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const cut = s => (Buffer.byteLength(s, 'utf8') <= TEXT_MAX ? s : Buffer.from(s, 'utf8').subarray(0, TEXT_MAX).toString('utf8'));

// Summaries of a project, newest first. Returns [{ id, title, text, task_id, run_id, worker_id, written_by, created_at,
// files_modified, looked_at }].
function find(E, project, { task_id, run_id, files, limit = LIMIT_DEFAULT } = {}) {
  const where = ['namespace = ?', "type = 'summary'"], params = [`summary/${project}`];
  if (task_id) { where.push('task_id = ?'); params.push(task_id); }
  if (run_id) { where.push('run_id = ?'); params.push(run_id); }
  const paths = files && files.length ? files.map(norm) : null;
  const got = E.store.p(`SELECT id, title, text, task_id, run_id, worker_id, written_by, created_at, body FROM memory_entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id LIMIT ?`).all(...params, paths ? SCAN_MAX : limit);
  const out = [];
  for (const r of got) {
    const b = parse(r.body);
    const modified = (b.done && Array.isArray(b.done.files_modified)) ? b.done.files_modified : [];
    const looked = Array.isArray(b.looked_at) ? b.looked_at : [];
    if (paths && ![...modified, ...looked].some(f => under(f, paths))) continue;
    out.push({ id: r.id, title: r.title, text: cut(r.text), task_id: r.task_id, run_id: r.run_id, worker_id: r.worker_id, written_by: r.written_by, created_at: r.created_at, files_modified: modified, looked_at: looked });
    if (out.length >= limit) break;
  }
  return out;
}

// memory.summaries { task_id?, files?, run_id?, limit? } -> { namespace, summaries, searched }
async function summaries(E, caller, args) {
  const M = require('./methods-memory.cjs');
  const lv = M.leversOf(E, caller);
  if (!(lv && lv.notes === true)) throw err('E_LEVER_OFF', 'memory.summaries needs the run\'s memory.notes lever: without it summaries are in the project and the search', { lever: 'notes' });
  for (const k of ['task_id', 'run_id']) if (args[k] != null && (typeof args[k] !== 'string' || !args[k])) throw err('E_ARGS', `memory.summaries: ${k} must be a non-empty string`, { field: k });
  if (args.files != null && (!Array.isArray(args.files) || !args.files.length || args.files.length > FILES_MAX || args.files.some(f => typeof f !== 'string' || !f.trim()))) {
    throw err('E_ARGS', `memory.summaries: files must be an array of 1 to ${FILES_MAX} paths`, { field: 'files' });
  }
  if (args.limit != null && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= LIMIT_MAX)) throw err('E_ARGS', `memory.summaries: limit must be an integer from 1 to ${LIMIT_MAX}`, { field: 'limit' });
  const project = projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'memory.summaries: this run has no project, so it has no summaries', { field: 'run_id' });
  const limit = args.limit == null ? LIMIT_DEFAULT : args.limit;
  const list = find(E, project, { task_id: args.task_id, run_id: args.run_id, files: args.files, limit });
  return { namespace: `summary/${project}`, summaries: list, searched: { task_id: args.task_id ?? null, run_id: args.run_id ?? null, files: args.files ?? null, limit } };
}

module.exports = { summaries, find, LIMIT_DEFAULT, LIMIT_MAX };
