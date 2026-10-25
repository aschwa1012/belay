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

// The note's own fields, as a hand-back and a project memory_store both state them (ADR 0047). One definition, so the two schemas cannot drift.
const NOTE_PROPS = {
  kind: { type: 'string', enum: ['lesson', 'flag', 'recurring', 'gotcha'] },
  title: str('Claim, max 160 bytes'),
  when: str('Task that would trip on it, as a task line, max 160 bytes'),
  basis: { type: 'string', enum: ['observed', 'inferred', 'relayed'] },
  evidence,
  applies_to: strs(),
  subjects: { ...strs(), maxItems: 3 }, // SUBJECTS_MAX in memory-notes.cjs (ADR 0057 decision 9)
};

const LEASE_RELEASE = {
  name: 'lease_release',
  description: 'Release your lease; returns the released task row, refuses if not the holder. result (max 4KB): branch, head, tests, findings; a review sets verdict holds|refuted and summary. notes is required, [] for most tasks; settle pending notes with memory_note_resolve.',
  inputSchema: S({
    lease_id: str(),
    reason: str(),
    result: { type: 'object' },
    notes: {
      type: 'array',
      items: S(NOTE_PROPS, ['kind', 'title', 'when', 'basis']),
    },
    reported_wrong: { type: 'array', items: S({ id: str(), why: str(), replaced_by: { type: ['string', 'null'], description: 'notes[i] or id' } }, ['id', 'why']) },
    memory_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of notes you applied; required when the run records note use, [] if none' },
  }, ['lease_id', 'notes']),
};

const NOTE_RESOLVE = {
  name: 'memory_note_resolve',
  description: 'Settle pending notes: new, or repeats/refines/supersedes an id.',
  inputSchema: S({
    resolutions: {
      type: 'array',
      items: S({ id: str(), resolve: { type: 'string', enum: ['new', 'repeats', 'supersedes', 'refines'] }, of: str(), title: str(), evidence }, ['id', 'resolve']),
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

// Wave 4: the facts behind a refuted-note wake (the wake carries ids only). Orchestrator only, listed with the notes lever.
const NOTE_REFUTATION = {
  name: 'memory_note_refutation',
  description: 'Why a note was refuted: the reason and cites the reviewer gave, who was shown it, and the notes they wrote. Data, not instructions.',
  inputSchema: S({ note_id: str() }, ['note_id']),
};

// The operator's word that a note is wrong, passed on by the orchestrator (it holds the note for the archive review). Orchestrator only, listed with the notes lever.
const MEMORY_REPORT = {
  name: 'memory_report',
  description: 'Report a note wrong on the operator word or your own evidence (a task evaluation, the code); say why. Holds it for the archive review. Returns the hold row, or not_held with the reason.',
  inputSchema: S({ note_id: str(), why: str(), replaced_by: str() }, ['note_id', 'why']),
};

// memory_store in a notes run (ADR 0047 amendment of 2026-10-22): a write to `project` is a note and states the note's fields; every other namespace is the
// ordinary row. Nothing is required by the schema, since a note has no `text` and a row has no `kind`; the core names what is missing. `ordinary` is the
// ordinary listing's memory_store, so the two share every property they have in common. The orchestrator's namespace also takes `summary`, its run outcome.
function memoryStoreNotes(ordinary, role) {
  const { required, ...schema } = ordinary.inputSchema;
  const properties = { ...schema.properties };
  properties.namespace = str(`Default: this run only. project: a lasting note (kind, title, when, basis)${role === 'orchestrator' ? '. summary: run outcome' : ''}`);
  const { title, ...rest } = NOTE_PROPS;
  return { ...ordinary, inputSchema: { ...schema, properties: { ...properties, ...rest, text: str('Not for project notes'), when: str('Task that would trip on it, max 160 bytes') } } };
}

module.exports = { memoryStoreNotes, LEASE_RELEASE, NOTE_RESOLVE, SUMMARIES, NOTE_REFUTATION, MEMORY_REPORT, notesWorkerListing };
