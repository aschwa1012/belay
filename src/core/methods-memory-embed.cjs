'use strict';
// methods-memory-embed.cjs — memory.embedNote, the write behind `belay memory embed`: one note of a project namespace that
// was stored without a vector (a hand-back under on_embedder_failure keyword) gets its vector, and the near-duplicate check
// its hand-back skipped is run now, by the same code and the same lever values as a normal hand-back (findMatches).
//
// Nothing is merged or deleted. A note with close matches is recorded the way a hand-back records it: moved to
// `pending/<project>` with `body.matches`, for memory.noteResolve to settle. Judging the matches is the model's work.
//
// The operator starts this and nothing else does: no warm-up, run start or search calls it. The embedder is asked
// directly, not through withEmbedding, so a failure here is reported to the operator and never reaches a run's
// embedder-failure guard (which would pause an unrelated live run).

const { err } = require('./errors.cjs');
const { findMatches } = require('./methods-memory-notes.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');

const pendingNs = project => `pending/${project}`;

function levers(args) {
  const t = args.notes_match_threshold === undefined ? DEFAULTS.notes_match_threshold : args.notes_match_threshold;
  const n = args.notes_match_n === undefined ? DEFAULTS.notes_match_n : args.notes_match_n;
  if (typeof t !== 'number' || !(t > 0 && t <= 1)) throw err('E_ARGS', 'memory.embedNote: notes_match_threshold must be a number above 0 and at most 1', { field: 'notes_match_threshold' });
  if (!Number.isInteger(n) || n < 1 || n > 10) throw err('E_ARGS', 'memory.embedNote: notes_match_n must be an integer from 1 to 10', { field: 'notes_match_n' });
  return { notes_match_threshold: t, notes_match_n: n };
}

// A note the project still holds as live: not refuted and not replaced. Only such a note is compared and held for review.
function isLive(E, row) {
  if ((row.status || 'unverified') === 'refuted') return false;
  return !E.store.p('SELECT 1 AS x FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(row.id, row.namespace);
}

async function embedNote(E, caller, args = {}) {
  if (typeof args.id !== 'string' || !args.id) throw err('E_ARGS', 'memory.embedNote needs a note id', { field: 'id' });
  const lv = levers(args);
  const row = E.store.p('SELECT * FROM memory_entries WHERE id = ?').get(args.id);
  if (!row) throw err('E_NOT_FOUND', `no memory row ${args.id}`, { id: args.id });
  if (row.type !== 'note' || !row.namespace.startsWith('project/')) throw err('E_ARGS', `${args.id} is not a note of a project namespace (it is a ${row.type} row in ${row.namespace}), and memory.embedNote embeds only those`, { id: args.id });
  if (row.embedding != null) return { id: row.id, action: 'already_embedded', embedded: false, namespace: row.namespace };
  const project = row.namespace.slice('project/'.length);
  const live = isLive(E, row);

  const embedder = await E.getEmbedder();
  const e = await embedder.embed(row.text, { as: 'document' });
  const emb = { embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim };
  // Compared before the row has a vector, so it cannot match itself.
  const matches = live ? await findMatches(E, caller, project, emb, lv) : [];

  const pending = matches.length > 0;
  const done = E.store.tx(() => {
    if (!E.store.setEmbedding(row.id, emb)) return false;
    if (pending) {
      const to = pendingNs(project);
      const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(to);
      if (!m) E.store.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(to, emb.embedding_model, emb.dim);
      else if (m.embedding_model !== emb.embedding_model || m.dim !== emb.dim) throw err('E_MODEL', `namespace ${to} is bound to ${m.embedding_model}/${m.dim} and this vector is ${emb.embedding_model}/${emb.dim}`, { namespace: to, bound: m });
      E.store.moveRow(row.id, row.namespace, to);
      E.store.patchBody(row.id, b => { b.state = 'pending'; b.matches = matches; return b; });
    }
    return true;
  });
  if (!done) return { id: row.id, action: 'already_embedded', embedded: false, namespace: row.namespace };
  E.noteWrite();
  return {
    id: row.id, action: 'embedded', embedded: true, state: pending ? 'pending' : 'stored', namespace: pending ? pendingNs(project) : row.namespace,
    title: row.title, compared: live, matches, embedding_model: emb.embedding_model, dim: emb.dim, ...lv,
  };
}

module.exports = { embedNote };
