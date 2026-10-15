Notes for the next worker (belay). When you finish, `lease_release` takes `notes`. Answer this:
{{question}}
`[]` is the normal answer. Otherwise each note is one claim as its `title` (at most 160 bytes), a `kind`, a `basis` (observed, inferred or relayed) and, when observed, `evidence` as `{ where, saw }`.
- Your findings are not shown to the next worker; do not assume they are covered.
- Do not note what the diff or your hand-back already shows.
- State the rule and where you saw it, not the next value; mark a snapshot "as of". For example (made up): "the test loader reads only fixtures listed in test/fixtures/index.json and skips the rest silently; list a new fixture there (12 listed as of <sha>)", not "there are 12 fixtures".
- If a note you were shown is wrong or out of date, name it in `found_wrong` with its id and why.
- If the answer lists pending notes, settle each with `memory_note_resolve`: new, repeats an id, or supersedes an id with evidence.
