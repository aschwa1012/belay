'use strict';
// tools-notes.cjs — ADR 0047 decisions 3 and 4: what a worker's tool listing says when its run has the `notes` lever
// on. `lease_release` gains `notes` (required, `[]` valid) and `reported_wrong` in its schema, not in prose, and
// `memory_note_resolve` joins the listing. With the lever off none of this is listed and the listing is the one it
// always was. The schema below costs about 1,340 bytes; ADR 0010 amendment 6 raised the worker budget to 7,168 so that
// every tool is listed in every arm.

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

// ADR 0047 decision 1: run summaries found on demand, role both. Listed for the orchestrator and the workers of a notes run.
const SUMMARIES = {
  name: 'memory_summaries',
  description: 'Run summaries by task, run or files, newest first.',
  inputSchema: S({ task_id: str(), run_id: str(), files: strs() }),
};

// The worker listing for a notes run, from the ordinary one: every ordinary tool stays listed (ADR 0010 amendment 6).
function notesWorkerListing(ordinary) {
  return ordinary.map((t) => (t.name === 'lease_release' ? LEASE_RELEASE : t)).concat([NOTE_RESOLVE, SUMMARIES]);
}

module.exports = { LEASE_RELEASE, NOTE_RESOLVE, SUMMARIES, notesWorkerListing };
