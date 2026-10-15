'use strict';
// methods-memory-embed.cjs — memory.embedNote, the write behind `belay memory embed`: one note of a project namespace that
// was stored without a vector (a hand-back under on_embedder_failure keyword) gets its vector, and the near-duplicate check
// its hand-back skipped is run now, by the same code and the same lever values as a normal hand-back (findMatches).
//
// The note is live already, so it never moves: it stays in `project/<project>`, searchable and in the index. Close matches are
// recorded in `body.matches` (the hand-back's shape) and in one `note_matches` memory_event, for a model to judge later (the
// note review or the archive reviewer). Nothing is moved, merged, archived or deleted here.
//
// The operator starts this and nothing else does: no warm-up, run start or search calls it. The embedder is asked
// directly, not through withEmbedding, so a failure here is reported to the operator and never reaches a run's
// embedder-failure guard (which would pause an unrelated live run).

const { err } = require('./errors.cjs');
const { findMatches } = require('./methods-memory-notes.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');

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

  const embedRun = typeof args.embed_run === 'string' && args.embed_run ? args.embed_run : null;
  const done = E.store.tx(() => {
    if (!E.store.setEmbedding(row.id, emb)) return false;
    if (matches.length) {
      E.store.patchBody(row.id, b => { b.matches = matches; return b; });
      recordEventSync(E, caller, { kind: 'note_matches', key: `note:${row.id}`, row_ids: [row.id, ...matches.map(m => m.id)], ok: true,
        message: JSON.stringify({ note_id: row.id, matches: matches.map(m => ({ id: m.id, similarity: m.similarity })), notes_match_threshold: lv.notes_match_threshold, notes_match_n: lv.notes_match_n, embed_run: embedRun }) });
    }
    return true;
  });
  if (!done) return { id: row.id, action: 'already_embedded', embedded: false, namespace: row.namespace };
  E.noteWrite();
  return {
    id: row.id, action: 'embedded', embedded: true, state: 'stored', namespace: row.namespace,
    title: row.title, compared: live, matches, embedding_model: emb.embedding_model, dim: emb.dim, ...lv,
  };
}

module.exports = { embedNote };
