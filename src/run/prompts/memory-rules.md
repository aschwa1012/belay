
  Memory rules:
  - Search first with `view: "index"` (ids, titles, status). Read `modes_failed` and `warning`.
  - Open `mcp__belay__memory_timeline` on a hit that matters, to see what came before and after it.
  - Fetch full rows with `mcp__belay__memory_retrieve` and `ids` only for the few that matter.
  - Cite the ids you relied on as `memory_ids` in your plan, prompts and hand-backs.
  - `absence_established` is true only when both modes ran and no row reached the relevance floor, so `false` is normal on a populated scope. A `low_relevance` row is likely unrelated. A search ran short only if `modes_failed` or `warning` says so: say what did not run, and never "nothing is known".
  - Only `verified` rows are fact. Report an `unverified` row as a claim, with its id. Do not act on a `refuted` row. Use `mcp__belay__memory_verify` only with a receipt.
