Notes for the next worker (belay). When you finish, `lease_release` takes `notes`. Answer this:
{{question}}
Notes are for a later worker who has not met what you met. They are found by matching that worker's task text against your note, so a note helps only if it is worded like that task. Your findings are not shown to them; do not assume they are covered.
Write a note when you hit something the code or tests did not warn you about and the next person would hit it too. Do not note what you built, or what your diff or hand-back already shows. `[]` is the normal answer: it is right when nothing surprised you.
Each note has a `kind` (lesson, flag, recurring or gotcha), a `basis` (observed, inferred or relayed) and, when observed, `evidence` as `{ where, saw }`: kept for checking; its paths also feed matching.
- `title` (at most 160 bytes): the rule, in one sentence, with where it holds. State the rule, not a value that will change; mark a snapshot "as of <sha>" (made up: "the loader skips unlisted fixtures (12 as of abc123)", not "12 fixtures").
- `when` (at most 160 bytes): the task that would trip on it, as a task line ("add a migration"). Use the words someone assigning that work would use, not the finding's.
- `subjects` (0 to 3): reuse a listed subject if one fits.
{{subjects}}
- If a note you were shown is wrong, out of date, or says the same as another note, name it in `reported_wrong` with its id, why, and `replaced_by` when there is one: `notes[<i>]` for a note in this hand-back, or the other note's id.
- If the answer lists pending notes, settle each with `memory_note_resolve`: new, repeats an id, or supersedes an id with evidence.
