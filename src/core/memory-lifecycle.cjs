'use strict';
// memory-lifecycle.cjs — the notes lifecycle's shared vocabulary and the shape checks of the two hand-backs that
// drive it (the scrubber's `scrub` list and the Opus reviewer's `verdicts`). Pure: no I/O, no store, nothing from the
// embedder, so any path may load it. Code records facts and enforces preconditions; the judgement is a model's.
//
// States of a note: live (project/<p>), warned (run-scoped, a worker's report), held (still in project/<p>, a row in
// held/<p> waits on the reviewer), archived (archive/<p>, out of the index and search, kept, restorable).

const { err } = require('./errors.cjs');
const { validId } = require('./memory-rows.cjs');
const { RESOLVES } = require('./memory-notes.cjs');

// `hold` and `dismiss` are shaped here because the held machinery and the reports' dismissal still use them, but the scrubber's
// hand-back may not carry them (memory.scrubApply refuses both by name): a wrong report is judged by a reviewer, not the scrubber.
const ACTIONS = Object.freeze(['dismiss', 'hold', 'resolve', 'draft', 'relate']);
const HOLD_KINDS = Object.freeze(['wrong', 'superseded', 'duplicate']);
const VERDICTS = Object.freeze(['archive', 'release', 'verify', 'refute', 'still_unsupported']); // archive and release judge a hold with a warning; the other three judge an unsupported note
const SCRUB_MODES = Object.freeze(['off', 'propose', 'apply']);

// A ground is a fact class, never a count of how a note was used. Anything else, use and miss facts included, is
// refused by name (E_GROUND), so a hiding mark cannot rest on "nobody applied it".
const HOLD_GROUNDS = Object.freeze({
  wrong: ['code_contradicts', 'report_confirmed', 'refuted_review'],
  superseded: ['replaced_by_newer'],
  duplicate: ['same_claim'],
});
// Grounds only the harness writes, never the scrubber (checkGround is given HOLD_GROUNDS): `reported` is a report that a note is wrong, held at once.
// Used by the report-time hold (memory-report-hold.cjs) and the facts check (memory-facts.cjs) alone, so a scrub entry naming it is E_GROUND.
const HARNESS_GROUNDS = Object.freeze({ wrong: ['reported'], superseded: ['reported'] });
const DISMISS_GROUNDS = Object.freeze(['report_unfounded', 'code_supports_note', 'report_resolved']);
const USE_OR_MISS = /use|miss|unused|sink|deliver|cite|stale|inert|ignor|apply|applied|popular|idle/i;

const DUP_SIMILARITY = 0.8; // S4: a stored similarity at least this, or a worker report naming the kept note
const SCOPE_MAX = 500, VERDICTS_MAX = 500, CITES_MAX = 6;
const REASON_MAX = 500, WHERE_MAX = 300, QUOTE_MAX = 2000, RULE_MAX = 1000, TARGET_MAX = 200;

const nsOf = (kind, project) => `${kind}/${project}`;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = s => Buffer.byteLength(s, 'utf8');
const bad = (message, detail) => err('E_ARGS', message, detail);

function checkText(v, name, max, at) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${at}${name} must be a non-empty string`, { field: name });
  if (bytes(v) > max) throw bad(`${at}${name} is over ${max} bytes`, { field: name, max });
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
}

function checkCites(list, at, required) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list) || list.length > CITES_MAX) throw bad(`${at}cites must be an array of at most ${CITES_MAX} { where, quote }`, { field: 'cites' });
  if (required && !list.length) throw bad(`${at}cites needs at least one { where, quote }: a mark that hides or changes a note cites what was read, verbatim`, { field: 'cites' });
  return list.map((c, i) => {
    if (!isObj(c)) throw bad(`${at}cites[${i}] must be an object { where, quote }`, { field: 'cites', index: i });
    for (const k of Object.keys(c)) if (k !== 'where' && k !== 'quote') throw bad(`${at}cites[${i}].${k} is not a field; use where and quote`, { field: 'cites', index: i });
    const where = checkText(c.where, `cites[${i}].where`, WHERE_MAX, at);
    if (typeof c.quote !== 'string' || !c.quote.trim()) throw bad(`${at}cites[${i}].quote must be a non-empty string: a verbatim line`, { field: 'cites', index: i });
    if (bytes(c.quote) > QUOTE_MAX) throw bad(`${at}cites[${i}].quote is over ${QUOTE_MAX} bytes`, { field: 'cites', index: i });
    return { where, quote: c.quote };
  });
}

function checkGround(ground, allowed, at, required) {
  if (ground === undefined || ground === null) {
    if (required) throw err('E_GROUND', `${at}ground is required; one of ${allowed.join(', ')}`, { allowed });
    return null;
  }
  if (typeof ground !== 'string' || !ground) throw err('E_GROUND', `${at}ground must be a string`, { allowed });
  if (!allowed.includes(ground)) {
    const why = USE_OR_MISS.test(ground) ? ' (a ground that rests on how a note was delivered, used or missed is never accepted: use and miss facts say nothing about whether a note is true)' : '';
    throw err('E_GROUND', `${at}ground ${JSON.stringify(ground).slice(0, 80)} is not allowed here; use one of ${allowed.join(', ')}${why}`, { ground: String(ground).slice(0, 80), allowed });
  }
  return ground;
}

const ENTRY_KEYS = ['id', 'action', 'kind', 'of', 'resolve', 'relation', 'keep', 'ground', 'reason', 'cites', 'draft'];

// The scrubber's hand-back: `scrub: [{ id, action, kind?, of?, resolve?, ground, reason, cites, draft? }]`.
//   dismiss  { ground in DISMISS_GROUNDS, cites? }
//   hold     { kind: wrong | superseded | duplicate, of? (required for superseded and duplicate), ground, cites }
//   resolve  { resolve: new | repeats | supersedes | refines, of (all but new), reason }: a pending note; cites are shape-checked, then dropped
//   relate   { relation: new | repeats | supersedes | refines, of, keep? (repeats: id | of), reason }: two live notes; cites likewise
//   draft    { draft: { rule, target } }
// A whole-call shape refusal: nothing is written for a list with one malformed entry.
function checkScrub(list, maxItems) {
  if (!Array.isArray(list)) throw bad('scrub must be an array of entries', { field: 'scrub' });
  if (list.length > maxItems) throw bad(`scrub holds ${list.length} entries and one scrub may carry at most ${maxItems} (the lever scrub_max_items); the rest are carried over`, { field: 'scrub', max: maxItems });
  const seen = new Set();
  return list.map((e, i) => {
    const at = `scrub[${i}]: `;
    if (!isObj(e)) throw bad(`${at}an entry must be an object`, { index: i });
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) throw bad(`${at}${k} is not a field; use ${ENTRY_KEYS.join(', ')}`, { field: k, index: i });
    if (!validId(e.id)) throw bad(`${at}id must be a note id`, { field: 'id', index: i });
    if (seen.has(e.id)) throw bad(`${at}id ${e.id} appears twice in one scrub`, { field: 'id', index: i });
    seen.add(e.id);
    if (!ACTIONS.includes(e.action)) throw bad(`${at}action must be one of ${ACTIONS.join(', ')}`, { field: 'action', index: i });
    if (e.of !== undefined && e.of !== null && (!validId(e.of) || e.of === e.id)) throw bad(`${at}of must be the id of another note`, { field: 'of', index: i });
    for (const [k, owner] of [['kind', 'hold'], ['resolve', 'resolve'], ['relation', 'relate'], ['keep', 'relate'], ['draft', 'draft']]) {
      if (e[k] !== undefined && e.action !== owner) throw bad(`${at}${k} belongs to action ${owner}`, { field: k, index: i });
    }
    const out = { id: e.id, action: e.action, reason: checkText(e.reason, 'reason', REASON_MAX, at), of: e.of || null };
    if (e.action === 'dismiss') {
      if (out.of) throw bad(`${at}a dismissal names no other note`, { field: 'of', index: i });
      out.ground = checkGround(e.ground, DISMISS_GROUNDS, at, true);
      out.cites = checkCites(e.cites, at, false);
    } else if (e.action === 'hold') {
      if (!HOLD_KINDS.includes(e.kind)) throw bad(`${at}kind must be one of ${HOLD_KINDS.join(', ')}`, { field: 'kind', index: i });
      if (e.kind !== 'wrong' && !out.of) throw bad(`${at}a ${e.kind} hold names the note it stands against in of`, { field: 'of', index: i });
      out.kind = e.kind;
      out.ground = checkGround(e.ground, HOLD_GROUNDS[e.kind], at, true);
      // A duplicate needs no verbatim cites: its facts are S4's (a stored similarity or a worker report, both notes live) and a
      // reason stating the shared claim. Any cites given are ignored, not stored and not checked.
      // Same at the review: the shape of any cites given is checked (as checkVerdicts does), then they are dropped.
      out.cites = e.kind === 'duplicate' ? (checkCites(e.cites, at, false), []) : checkCites(e.cites, at, true);
    } else if (e.action === 'resolve') {
      if (!RESOLVES.includes(e.resolve)) throw bad(`${at}resolve must be one of ${RESOLVES.join(', ')}`, { field: 'resolve', index: i });
      if (e.resolve === 'new' && out.of) throw bad(`${at}resolve new names no other note`, { field: 'of', index: i });
      if (e.resolve !== 'new' && !out.of) throw bad(`${at}resolve ${e.resolve} names the live note in of`, { field: 'of', index: i });
      out.resolve = e.resolve;
      out.ground = checkGround(e.ground, [...DISMISS_GROUNDS, ...Object.values(HOLD_GROUNDS).flat()], at, false);
      // Supersedes and refines are note-to-note text judgements: the reason states the new information or the caveat, and any cites given are
      // shape-checked and dropped, as a duplicate's are.
      out.cites = (checkCites(e.cites, at, false), []);
    } else if (e.action === 'relate') {
      if (!RESOLVES.includes(e.relation)) throw bad(`${at}relation must be one of ${RESOLVES.join(', ')}`, { field: 'relation', index: i });
      if (!out.of) throw bad(`${at}relate names the other live note in of`, { field: 'of', index: i });
      if (e.keep !== undefined && (e.relation !== 'repeats' || !['id', 'of'].includes(e.keep))) throw bad(`${at}keep is id or of, and only for repeats`, { field: 'keep', index: i });
      out.relation = e.relation;
      out.ground = null;
      out.cites = (checkCites(e.cites, at, false), []);
      if (e.keep) out.keep = e.keep;
    } else {
      if (out.of) throw bad(`${at}a draft names no other note`, { field: 'of', index: i });
      if (!isObj(e.draft)) throw bad(`${at}draft must be { rule, target }`, { field: 'draft', index: i });
      for (const k of Object.keys(e.draft)) if (k !== 'rule' && k !== 'target') throw bad(`${at}draft.${k} is not a field; use rule and target`, { field: 'draft', index: i });
      out.draft = { rule: checkText(e.draft.rule, 'draft.rule', RULE_MAX, at), target: checkText(e.draft.target, 'draft.target', TARGET_MAX, at) };
      out.cites = checkCites(e.cites, at, false);
    }
    return out;
  });
}

// The reviewer's verdicts on held notes: `verdicts: [{ id, verdict: archive | release, reason, cites? }]` where `id`
// is the held note. An archive of a wrong or superseded note cites what it read (S3); an archive of a duplicate states `same_claim: true`
// instead; a release needs neither.
function checkVerdicts(list) {
  if (!Array.isArray(list) || !list.length || list.length > VERDICTS_MAX) throw bad(`verdicts must be an array of 1 to ${VERDICTS_MAX} entries`, { field: 'verdicts' });
  const seen = new Set();
  return list.map((v, i) => {
    const at = `verdicts[${i}]: `;
    if (!isObj(v)) throw bad(`${at}a verdict must be an object { id, verdict, reason, cites }`, { index: i });
    for (const k of Object.keys(v)) if (!['id', 'verdict', 'reason', 'cites', 'same_claim'].includes(k)) throw bad(`${at}${k} is not a field; use id, verdict, reason, cites, same_claim`, { field: k, index: i });
    if (!validId(v.id)) throw bad(`${at}id must be the id of a held note`, { field: 'id', index: i });
    if (seen.has(v.id)) throw bad(`${at}id ${v.id} appears twice in one call`, { field: 'id', index: i });
    seen.add(v.id);
    if (!VERDICTS.includes(v.verdict)) throw bad(`${at}verdict must be one of ${VERDICTS.join(', ')}`, { field: 'verdict', index: i });
    if (v.same_claim !== undefined && typeof v.same_claim !== 'boolean') throw bad(`${at}same_claim must be true or false`, { field: 'same_claim', index: i });
    // Whether an archive needs cites depends on the hold's kind, which only reviewApply knows: a duplicate needs same_claim true and no cites,
    // wrong and superseded need cites. reviewApply enforces both.
    return { id: v.id, verdict: v.verdict, reason: checkText(v.reason, 'reason', REASON_MAX, at), cites: checkCites(v.cites, at, false), ...(v.same_claim === undefined ? {} : { same_claim: v.same_claim }) };
  });
}


module.exports = {
  ACTIONS, HOLD_KINDS, VERDICTS, SCRUB_MODES, HOLD_GROUNDS, HARNESS_GROUNDS, DISMISS_GROUNDS, DUP_SIMILARITY, SCOPE_MAX, VERDICTS_MAX,
  RULE_MAX, TARGET_MAX, nsOf, isObj, bytes, bad, checkText, checkCites, checkGround, checkScrub, checkVerdicts, RESOLVES,
};
