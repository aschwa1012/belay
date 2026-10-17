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
//
// Two things embed here. A note with no vector is embedded from the text of its own template: a note that has a `when` from its
// title and When: line (template v2), an older one from its stored text (v1). And `reembed: 'v2'` (belay memory embed --reembed
// --template v2) replaces the vector of a note that already has one with a v2 vector, only when the note has a `when` to build
// it from; a v1 note without one stays v1 and the answer says so. Neither moves, merges or deletes anything.

const { err } = require('./errors.cjs');
const { findMatches } = require('./methods-memory-notes.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const NT = require('./memory-notes.cjs');

const bodyOf = (row) => { try { return row.body ? JSON.parse(row.body) : {}; } catch { return {}; } };

// The text a stored note is embedded from, and the template it is: from the fields, never from the keyword text.
function embedSource(row, want) {
  const b = bodyOf(row);
  if (want === 'v2' || (want === undefined && typeof b.when === 'string' && b.when)) {
    if (typeof b.when !== 'string' || !b.when) return null;
    return { template: 'v2', text: NT.embedText({ title: row.title, when: b.when }, 'v2') };
  }
  return { template: 'v1', text: row.text };
}

// One note's vector replaced by a v2 one. Skipped, with the reason, when it cannot be: no vector yet, already v2, or no when.
async function reembedNote(E, row, args) {
  if (args.reembed !== 'v2') throw err('E_ARGS', 'memory.embedNote reembed must be v2: it is the only template a stored note can be rebuilt as', { field: 'reembed' });
  const skip = (reason) => ({ id: row.id, action: 'skipped', embedded: false, reembedded: false, reason, from: row.text_template || 'v1', namespace: row.namespace, title: row.title });
  if (row.embedding == null) return skip('no_vector');
  if ((row.text_template || 'v1') === 'v2') return skip('already_v2');
  const src = embedSource(row, 'v2');
  if (!src) return skip('no_when');
  const embedder = await E.getEmbedder();
  const e = await embedder.embed(src.text, { as: 'document' });
  const done = E.store.tx(() => E.store.replaceEmbedding(row.id, { embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim, text_template: 'v2' }));
  if (!done) return skip('no_vector');
  E.noteWrite();
  return { id: row.id, action: 'reembedded', embedded: true, reembedded: true, from: done.template, to: 'v2', namespace: row.namespace, title: row.title, embedding_model: e.embedding_model, dim: e.dim };
}

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
  if (args.reembed !== undefined) return reembedNote(E, row, args);
  if (row.embedding != null) return { id: row.id, action: 'already_embedded', embedded: false, namespace: row.namespace };
  const project = row.namespace.slice('project/'.length);
  const live = isLive(E, row);

  const embedder = await E.getEmbedder();
  const src = embedSource(row);
  const e = await embedder.embed(src.text, { as: 'document' });
  const emb = { embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim, text_template: src.template };
  // Compared before the row has a vector, so it cannot match itself.
  const matches = live ? await findMatches(E, caller, project, emb, lv, src.template) : [];

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
