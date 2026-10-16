Notes for the next worker (belay). When you finish, `lease_release` takes `notes`. Answer this:
{{question}}
Notes are for a later worker who has not met what you met. They are found by matching the later worker's task text against your note, so a note helps only if it is worded like that task.
Write a note when you hit something the code or tests did not warn you about and the next person would hit it too. Do not note what you built, or what your diff or hand-back already shows. `[]` is the normal answer: it is right when nothing surprised you.
Each note has a `kind` (lesson, flag, recurring or gotcha), a `basis` (observed, inferred or relayed) and, when observed, `evidence` as `{ where, saw }`. Evidence is kept for checking, not for finding.
- `title` (at most 160 bytes): the fact, in one sentence, with where it holds.
- `when` (at most 160 bytes): the task that would trip on it, as a task line ("add a migration", "dedupe emails"). Use the words someone assigning that work would use, not the finding's.
- `subjects` (0 to 3): reuse a listed subject if one fits.
{{subjects}}
- If a note you were shown is wrong or out of date, name it in `reported_wrong` with its id and why.
- If the answer lists pending notes, settle each with `memory_note_resolve`: new, repeats an id, or supersedes an id with evidence.
