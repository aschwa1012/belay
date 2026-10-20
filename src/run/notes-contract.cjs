'use strict';
// notes-contract.cjs — ADR 0047 decision 3: the worker contract text for a run with the `notes` lever on. The
// end-of-task question lives in src/run/prompts (one file per wording) so a test can pin it and an evaluation can
// swap it. Two levers choose between wordings and add a turn, both off by default (write ablation):
//   notes_lesson_question  the question aimed at what the worker learned, not at what the next one would get wrong
//   notes_reflection       the question asked again as a turn of its own after the hand-back
// Nothing here reads a store or runs a process; it returns text.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'prompts');
const cache = new Map();
const read = (name) => {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  return cache.get(name);
};

const question = (lv) => read(lv && lv.notes_lesson_question ? 'notes-question-lesson.md' : 'notes-question.md');
// The project's most used subjects, as one line (memory.noteSubjects, chosen by the core): '' when it has none, and then the
// placeholder's whole line goes, so a project with no subjects yet sees no empty line.
const subjectsLine = (subjects) => (Array.isArray(subjects) && subjects.length ? `Subjects already used in this project: ${subjects.join(', ')}.` : '');
// The one rule on findings, stated as what is pushed to a later worker: nothing is, so it must not assume they are covered. The
// task row (`task_list`) still holds them, and a run that keeps mechanical summaries also turns them into rows `memory_summaries`
// returns on request; the line says only that nothing delivers them.
const findingsLine = (lv) => (lv && lv.summaries === 'mechanical'
  ? 'Your findings are not passed to them automatically, though a run summary of them can turn up if they search; do not assume they are covered.'
  : 'Your findings are not passed to them automatically; do not assume they are covered.');
const fill = (template, lv, subjects) => {
  const line = subjectsLine(subjects);
  return template.split('{{question}}').join(question(lv)).split('{{findings}}').join(findingsLine(lv)).split(line ? '{{subjects}}' : '\n{{subjects}}').join(line);
};

// Appended to a worker's opening message; '' with the lever off.
// With the notes sink on, one more line asks for `memory_ids` (the core requires it then).
const withIds = (lv) => (lv.notes_sink && lv.notes_sink !== 'off' ? '\n' + read('notes-memory-ids.md') : '');
const contract = (lv, subjects) => (lv && lv.notes ? fill(read('notes-contract.md'), lv, subjects) + withIds(lv) : '');
// The reflection turn's message; '' unless both levers are on.
const reflection = (lv) => (lv && lv.notes && lv.notes_reflection ? fill(read('notes-reflection.md'), lv, null) : '');

module.exports = { contract, reflection, question };
