'use strict';
// note-shown.cjs — how much of a note a capped brief shows its reviewer, and what it hides. Pure: a note in, a list out.
//
// A reviewer's brief caps a note so that eight of them fit a prompt: the text at TEXT_CAP bytes, each `saw` at SAW_CAP bytes, and
// the first EVIDENCE_SHOWN evidence entries. `confirmed` is a claim that the evidence agrees with every specific value the note
// states, so it is allowed only for a note the reviewer was shown whole. The run's brief (note-review-text.cjs capNote) and the
// core's check (methods-memory-note-review.cjs) read these same numbers, so they cannot drift apart.

const TEXT_CAP = 400, SAW_CAP = 200, EVIDENCE_SHOWN = 3;
// How many notes the brief lists: VERDICTS_FIT verdicts of about 330 bytes fit a 4096 byte hand-back beside the verdict and summary, and each
// report listed (at most REPORTS_FIT) takes one place. A note past that is not in the brief, so its reviewer saw nothing of it.
const VERDICTS_FIT = 8, REPORTS_FIT = 4;
const noteFit = (reports) => (reports ? VERDICTS_FIT - Math.min(reports, REPORTS_FIT) : VERDICTS_FIT);
const bytes = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

// What a capped brief leaves out of `n` ({ text, when?, evidence: [{ where, saw }] }): [] when the whole note was shown.
// The stored `text` of a note with a `when` is derived from its title, when, subjects and applies_to, and the brief shows each of those in
// full, so a long `text` hides nothing there. A note without a `when` (v1) keeps its text as its one body, and the cap hides the rest of it.
function hiddenParts(n) {
  const out = [];
  const derived = !!(n && typeof n.when === 'string' && n.when.trim());
  if (!derived && bytes(n && n.text) > TEXT_CAP) out.push(`text (${bytes(n.text)} bytes, ${TEXT_CAP} shown)`);
  const ev = n && Array.isArray(n.evidence) ? n.evidence : [];
  ev.slice(0, EVIDENCE_SHOWN).forEach((e, i) => { if (e && typeof e === 'object' && bytes(e.saw) > SAW_CAP) out.push(`evidence[${i}].saw (${bytes(e.saw)} bytes, ${SAW_CAP} shown)`); });
  if (ev.length > EVIDENCE_SHOWN) out.push(`evidence[${EVIDENCE_SHOWN}..${ev.length - 1}] (${ev.length - EVIDENCE_SHOWN} entries not shown)`);
  return out;
}

module.exports = { TEXT_CAP, SAW_CAP, EVIDENCE_SHOWN, VERDICTS_FIT, REPORTS_FIT, noteFit, hiddenParts };
