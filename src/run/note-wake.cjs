'use strict';
// note-wake.cjs — wave 4: the refuted-note wake. When a review refutes a note, the core writes a `note_refuted` receipt in the
// refuting transaction; this reads those receipts for the run and builds ONE wake per poll and review from the core's own facts
// (memory.noteRefutation): the notes, the review's receipt id, the tasks shown them (running or finished, cited or not), the reviews
// of those tasks, and the notes those workers wrote. Facts only: no worker or reviewer words (see refutedWake). It is the existing
// wake mechanism's input, nothing new on the wire: the headless launcher writes the text to the orchestrator's stdin and the
// interactive launcher publishes it on the wake pipe, exactly as for a worker's turn. The launcher passes `enabled` from the spec (the run's notes lever); off, it reads nothing and never touches the run row.

const { refutedWake } = require('./note-review-text.cjs');

function createNoteWatcher({ core, runId, enabled = false }) {
  const seen = new Set();
  // New wakes since the last poll, oldest first: [{ event: 'note_refuted', worker_id, turn, id, text, note_ids }]. A read that fails
  // is retried on the next poll; a note that can no longer be read is woken with a bare line, once.
  async function poll() {
    if (!enabled) return [];
    let evs;
    try { evs = ((await core.memory.events({ run_id: runId, kinds: ['note_refuted'] })) || {}).events || []; } catch { return []; }
    const groups = new Map(); // review ref -> { rs, evs }
    for (const ev of evs) {
      if (seen.has(ev.id) || !(ev.ok === 1 || ev.ok === true)) continue;
      const noteId = Array.isArray(ev.row_ids) ? ev.row_ids[0] : null;
      if (!noteId) { seen.add(ev.id); continue; }
      let r;
      try { r = await core.memory.noteRefutation({ note_id: noteId }); } catch (e) {
        if (!e || e.code !== 'E_NOT_FOUND') continue;
        r = { note: { id: noteId }, review: null, shown: [], notes_written_by_shown: [] };
      }
      const ref = (r.review && r.review.ref) || 'unknown';
      if (!groups.has(ref)) groups.set(ref, { rs: [], evs: [] });
      groups.get(ref).rs.push(r); groups.get(ref).evs.push(ev);
    }
    const out = [];
    for (const g of groups.values()) {
      const w = refutedWake(g.rs, g.evs.map((e) => e.id));
      for (const ev of g.evs) seen.add(ev.id);
      out.push({ event: 'note_refuted', worker_id: `note:${g.rs[0].note.id}`, turn: 0, seq: g.evs[0].seq, id: w.id, text: w.text, note_id: g.rs[0].note.id, note_ids: g.rs.map((r) => r.note.id) });
    }
    out.push(...(await alarms()));
    return out;
  }
  // The run-close scrub's runaway alarm (memory.scrubApply's `alarm`): one wake per receipt, in belay's own words (the receipt's message
  // holds counts and a command, no model text). At a normal run close the orchestrator is already gone and the receipt is read in
  // `belay notices`; a scrub run by hand while the run is live wakes it.
  async function alarms() {
    let evs;
    try { evs = ((await core.memory.events({ run_id: runId, kinds: ['scrub_alarm'] })) || {}).events || []; } catch { return []; }
    const out = [];
    for (const ev of evs) {
      if (seen.has(ev.id) || !(ev.ok === 1 || ev.ok === true)) continue;
      seen.add(ev.id);
      out.push({ event: 'scrub_alarm', worker_id: `scrub:${runId}`, turn: 0, seq: ev.seq, id: `scrub-alarm:${ev.id}`, text: `belay: ${String(ev.message || 'a scrub made many hold marks')}`.slice(0, 600), note_ids: Array.isArray(ev.row_ids) ? ev.row_ids : [] });
    }
    return out;
  }
  return { poll };
}

module.exports = { createNoteWatcher };
