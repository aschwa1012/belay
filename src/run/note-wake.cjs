'use strict';
// note-wake.cjs — wave 4: the refuted-note wake. When a review refutes a note, the core writes a `note_refuted` receipt in the
// refuting transaction; this reads those receipts for the run and builds one wake each from the core's own facts
// (memory.noteRefutation): the note, the reviewer's reason and checked cites, the tasks shown the note and whether a finished one
// cited it, and the notes those workers wrote. It is the existing wake mechanism's input, nothing new on the wire: the headless
// launcher writes the text to the orchestrator's stdin and the interactive launcher publishes it on the wake pipe, exactly as
// for a worker's turn. The text is data (invariant 8); the orchestrator decides what to do.

const { refutedWake } = require('./note-review-text.cjs');

function createNoteWatcher({ core, runId }) {
  const seen = new Set();
  // New wakes since the last poll, oldest first: [{ event: 'note_refuted', worker_id, turn, id, text, note_id }]. A read that fails
  // is retried on the next poll; a note that can no longer be read is woken with a bare line, once.
  async function poll() {
    let evs;
    try { evs = ((await core.memory.events({ run_id: runId, kinds: ['note_refuted'] })) || {}).events || []; } catch { return []; }
    const out = [];
    for (const ev of evs) {
      if (seen.has(ev.id) || !(ev.ok === 1 || ev.ok === true)) continue;
      const noteId = Array.isArray(ev.row_ids) ? ev.row_ids[0] : null;
      if (!noteId) { seen.add(ev.id); continue; }
      let w;
      try { w = refutedWake(await core.memory.noteRefutation({ note_id: noteId }), ev.id); } catch (e) {
        if (!e || e.code !== 'E_NOT_FOUND') continue;
        w = { id: `note-refuted:${ev.id}`, text: `belay: note ${noteId} was refuted by a review, and it can no longer be read from the store.` };
      }
      seen.add(ev.id);
      out.push({ event: 'note_refuted', worker_id: `note:${noteId}`, turn: 0, seq: ev.seq, id: w.id, text: w.text, note_id: noteId });
    }
    return out;
  }
  return { poll };
}

module.exports = { createNoteWatcher };
