'use strict';
// tools-notes.cjs — ADR 0047 decisions 3 and 4: what a worker's tool listing says when its run has the `notes` lever
// on. `lease_release` gains `notes` (required, `[]` valid) and `reported_wrong` in its schema, not in prose, and
// `memory_note_resolve` joins the listing. With the lever off none of this is listed and the listing is the one it
// always was. The 5,120 byte worker budget (ADR 0040 section 4) is not loosened: the schema above costs about 1,340
// bytes, so the listing also drops the five tools a worker least needs while it is writing notes (their descriptions
// would not fit otherwise). They stay callable; only the per-turn listing tax goes.

const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const strs = () => ({ type: 'array', items: { type: 'string' } });
const S = (properties, required) => {
  const s = { type: 'object', properties };
  if (required) s.required = required;
  return s;
};
const evidence = { type: 'array', items: S({ where: str(), saw: str() }) };

const LEASE_RELEASE = {
  name: 'lease_release',
  description: 'Release your lease. Returns the released task row; refuses if not the holder. result (max 4KB) hands back branch, head, tests, findings; a review sets verdict holds|refuted and summary. notes is required, [] for most tasks. Pending notes: call memory_note_resolve.',
  inputSchema: S({
    lease_id: str(),
    reason: str(),
    result: { type: 'object' },
    notes: {
      type: 'array',
      items: S({
        kind: { type: 'string', enum: ['lesson', 'flag', 'recurring', 'gotcha'] },
        title: str('The claim, max 160 bytes'),
        basis: { type: 'string', enum: ['observed', 'inferred', 'relayed'] },
        evidence,
        applies_to: strs(),
        subjects: strs(),
      }, ['kind', 'title', 'basis']),
    },
    reported_wrong: { type: 'array', items: S({ id: str(), why: str(), replaced_by: { type: ['string', 'null'] } }, ['id', 'why']) },
  }, ['lease_id', 'notes']),
};

const NOTE_RESOLVE = {
  name: 'memory_note_resolve',
  description: 'Settle pending notes: new, repeats or supersedes an id (with evidence). Returns what each became.',
  inputSchema: S({
    resolutions: {
      type: 'array',
      items: S({ id: str(), resolve: { type: 'string', enum: ['new', 'repeats', 'supersedes'] }, of: str(), title: str(), evidence }, ['id', 'resolve']),
    },
  }, ['resolutions']),
};

// Listed in a notes run's worker listing no more; still routable.
const DROPPED = new Set(['status', 'task_list', 'memory_list', 'memory_stats', 'memory_delete']);

// The worker listing for a notes run, from the ordinary one.
function notesWorkerListing(ordinary) {
  return ordinary.filter((t) => !DROPPED.has(t.name)).map((t) => (t.name === 'lease_release' ? LEASE_RELEASE : t)).concat([NOTE_RESOLVE]);
}

module.exports = { LEASE_RELEASE, NOTE_RESOLVE, DROPPED, notesWorkerListing };
