'use strict';
// note-shown.cjs — how much of a note a capped brief shows its reviewer, and what it hides. Pure: a note in, a list out.
//
// A reviewer's brief caps a note so that eight of them fit a prompt: the text at TEXT_CAP bytes, each `saw` at SAW_CAP bytes, and
// the first EVIDENCE_SHOWN evidence entries. `confirmed` is a claim that the evidence agrees with every specific value the note
// states, so it is allowed only for a note the reviewer was shown whole. The run's brief (note-review-text.cjs capNote) and the
// core's check (methods-memory-note-review.cjs) read these same numbers, so they cannot drift apart.

const TEXT_CAP = 400, SAW_CAP = 200, EVIDENCE_SHOWN = 3;
const bytes = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

// What a capped brief leaves out of `n` ({ text, evidence: [{ where, saw }] }): [] when the whole note was shown.
function hiddenParts(n) {
  const out = [];
  if (bytes(n && n.text) > TEXT_CAP) out.push(`text (${bytes(n.text)} bytes, ${TEXT_CAP} shown)`);
  const ev = n && Array.isArray(n.evidence) ? n.evidence : [];
  ev.slice(0, EVIDENCE_SHOWN).forEach((e, i) => { if (e && typeof e === 'object' && bytes(e.saw) > SAW_CAP) out.push(`evidence[${i}].saw (${bytes(e.saw)} bytes, ${SAW_CAP} shown)`); });
  if (ev.length > EVIDENCE_SHOWN) out.push(`evidence[${EVIDENCE_SHOWN}..${ev.length - 1}] (${ev.length - EVIDENCE_SHOWN} entries not shown)`);
  return out;
}

module.exports = { TEXT_CAP, SAW_CAP, EVIDENCE_SHOWN, hiddenParts };
