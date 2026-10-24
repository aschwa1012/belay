# Changelog

## 0.3.0

Notes: short facts a worker hands back at the end of a task, kept in the
project's memory and found by later workers. Experimental, and on by default
once a memory project is named. They work end to end in one 40-task build on
real Claude Code; nothing here claims they make workers better.

Upgrade warning (from 0.2.0)
- with notes on, project memory works only as notes: a memory_store into the
  project by a worker or the orchestrator is written as a note and must carry
  a note's fields, and the orchestrator's run outcomes go to
  summary/<project>. Rows already in the project that are not notes are no
  longer shown to workers or the orchestrator; the belay memory commands
  still show them
- project_writes together with notes is refused: a 0.2.0 config that sets
  project_writes and a project fails until it also sets "notes": false
- a note reported wrong is left out of workers' reads until it is settled
  (memory.held_visibility: withhold, the default; warn keeps it visible with
  its warning)
- if your config file or run spec already sets memory.project, notes are now
  on for those runs: workers are asked for notes at the end of each task, and
  a run whose notes need checking ends with a small Haiku scrub (at most $0.10
  and 300 s). Set "notes": false in the memory block (or run
  belay settings memory.notes false) to keep 0.2.0's behaviour
- with no project set, belay run, status, doctor, settings and the panel show
  a notice that memory notes are off for this project; memory.notes false
  silences it
- on_embedder_failure now takes required (the default), keyword or off; the
  0.2.0 values stop and continue are still accepted as required and keyword.
  A failed embedder pauses the run, as 0.2.0's stop did; new is that a
  worker's memory search inside the run fails instead of falling back to
  keyword search
- keyword search matches any of the query's terms (0.2.0 required every
  term) and ranks by relevance; hybrid search and the index also drop common
  English stopwords and terms found in half the rows or more, so the same
  query can return more rows, in a different order
- belay's write commands are refused inside a worker's environment, so a
  script a worker runs can no longer call, for example, belay memory verify
- every write to a run that has ended is refused
- copy the orchestrator prompt template again: both changed (workers are
  spawned with an agent_type, and the prompts cover notes). An old copy still
  runs, but its workers get no per-type defaults
- commands that need the operator's authority (writes, run control,
  operator-only reads) take about 1 s longer, once per connection, while
  belay checks the calling process
- the store keeps schema version 2; the first 0.3.0 run adds columns in place.
  Going back to 0.2.0 on the same store is not tested: back up .belay\ first

Added, on by default once memory.project is set
- notes: at the end of a task a worker hands back up to 10 notes (a
  one-line claim, the situation that would run into it, how it knows, and the
  evidence it saw); belay stores each with the worker, task, run and changed
  files, and later workers find them with memory search
- duplicate handling at write: a note close to an existing one is held until
  the worker says whether it is new, a repeat, a replacement or a refinement
- review of notes by the task's own reviewer, whose verdicts (confirmed,
  refuted, unsupported) must quote what it checked; only a cited review
  verdict makes a note verified
- reports: a worker that finds a note wrong reports it on hand-back, and the
  note is held at once for the archive review. A report that names a
  replacement holds it as superseded by that note only when the replacement
  passes the similarity check (a shared path or subject, or a stored
  similarity of at least 0.8); otherwise the note is held as wrong, and the
  result records that the superseded hold was refused. The task reviewer's
  verdict on a report is recorded on the hold as advice. A task reviewer's
  cited refuted verdict on a note is a report too, and leaves the note's
  status as it was
- belay memory report <note-id> --reason <text> [--replaced-by <note-id>]:
  the operator reports a note wrong, and it is held exactly as a worker's
  report holds it, --replaced-by included. A reporter's repeat replaces its
  earlier report. Refused inside a worker
- the orchestrator's memory_report tool, listed only when notes are on, so
  you can ask the orchestrator to dispute a note. In a notes run the
  orchestrator has no memory_verify (the adapter refuses it); it disputes a
  note with memory_report
- held visibility (memory.held_visibility): withhold, the default, leaves a
  reported note out of workers' index and search until the archive review or
  the operator settles it, while the orchestrator still sees it with its
  warning; warn keeps it visible to workers with its warning
- a breaker on reports (memory.held_breaker_count, default 5, and
  memory.held_breaker_share, default 0.2): once a run's reports have held
  more notes than the smaller of the count and the share of the project's
  live notes, the share part never below 3, its further reports still hold
  but do not withhold, and the panel flags the run
- the panel's held line shows how long the oldest held note has waited. Notes
  that await you are a compact list under it (up to 5 rows, then
  "+N more · belay memory held --awaiting"); a row opens to its full title
  and reason. Archive, release and reoffer are settled inside the pane: a
  reason field, then a confirm line, and only the confirm runs belay memory
  held settle. A settled note shows its outcome at once and cannot be settled
  twice from the panel. The panel's section headings and colours follow the
  Claude Code theme
- the archive review (belay memory review, or the panel's review button,
  never at run close unless archive_review_auto is set; Opus 5.5, capped at
  $2 per review): it archives a held note only on its own cites that show it
  wrong, releases it only as a cited verify that shows it right, or leaves it
  held as undecided for you
- belay memory held lists held notes (--awaiting for those waiting on you);
  belay memory held settle <note> --archive|--release|--reoffer --reason
  settles one by hand. A released note's reports are settled; the note is not
  verified. --if-awaiting makes the settle a check-and-set: it is refused,
  with nothing written, unless the note still awaits you; the panel always
  passes it
- the held count by ground (reported wrong, duplicate, superseded, ...) and
  how many await you, in belay status, belay notices and the panel
- the run-close scrub: Haiku 5.5 checks how the run's notes relate to the
  stored ones (repeats, replaces, refines), only when the run has notes to
  check, capped at $0.10 and 300 s. It only proposes (scrub_action: propose);
  nothing is archived or merged without you (belay memory proposals)
- operator commands for notes: memory proposals, restore, resolve, promote
  (a note nominated for CLAUDE.md, on your approval only), archive purge
  (archived notes only, with --confirm), embed; memory scrub and memory
  review by hand

Added
- in an interactive run the panel's orchestrator row shows context tokens, an
  estimated cost (shown as ≈$, at API rates, estimated from Claude Code's
  session transcript) and the prompt-cache timer. /clear starts a new
  transcript, which belay does not follow, so the figures stay those of the
  session belay launched
- the panel's review button during a live run acts for that run when it is the
  only run with notes on (see the known limit below)
- belay settings writes memory lever defaults and per-agent-type model and
  effort defaults (agents.<type>.model, effort, codex_model) to the config
  file; a run spec's own values win. The shipped orchestrator prompts spawn
  each worker with an agent_type: with no model given, coders and testers run
  Sonnet 5.5, reviewers and researchers Opus 5.5 at effort high
- belay resume <run> --embedder keyword|off: go on with a run paused by an
  embedder failure, ranking by keywords only or with memory off; the choice
  is also written to the config file as memory.on_embedder_failure, so later
  runs inherit it
- caller identity bound to the process: the store owner checks which process
  is calling instead of believing the role a request names. A worker's shell
  and the processes it starts can no longer act as the operator, nor can other
  stores' workers, the orphans of workers that exited, or a failed start's
  leftover key; an unreadable register refuses. The CLI refuses write
  commands inside a worker's environment
- a task holds its files only while its run is live, so a task left
  unfinished by a crashed run no longer blocks later runs (E_FILES_OVERLAP)

Removed
- the per-task note-review job of pre-release builds. Its keys note_review
  (true), note_review_model and note_review_cost_cap_usd are refused with a
  message that says why, never ignored; note_review: false is accepted and
  does nothing

Fixed
- belay run removes its previous launch marker before it starts, so a marker
  left by an earlier launch of the same run can no longer answer for the new
  one
- two processes racing to take over a stale store lock could both win; a
  takeover now claims the specific stale lock it judged, by token, and only
  one process can claim it. Found by CI on a slow hosted runner
- the store owner announces that it is listening in a new file that no reader
  can hold open; a start that cannot announce it fails cleanly instead of
  running unreachable
- a worker whose turn ended just after a stop began was briefly marked running
  again before it stopped. The 0.2.0 notes described this as "two stops of the
  same worker can both run"; the stops were always merged into one
- a restarted worker whose first turn ended very quickly was reported as
  timed out, after a wait of the whole first-turn timeout; restart now
  reports the turn that already ended
- about a second after a resume, a resumed worker was marked paused again
  while it ran, and messages to it were refused; a worker restarted after a
  stop was marked stopped the same way. A relaunch now clears how the last
  process ended
- process snapshots hold under load, so kills, parks and restarts no longer
  fail on a busy machine
- a run closes an orchestrator adapter that attaches after the run ended, and
  stays closed
- every write of a run that has ended is refused
- tests no longer read old code from git history, assume Claude Code is
  installed, or rely on fixed sleeps, so the suite passes in any clone and on
  slow machines; Windows CI runs it on every push to main and every pull
  request
- task.evaluate now refuses a task whose dependency is not done
  (E_DEPENDENCY_OPEN, the same rule task.assign applies, a refuted review
  included) before it runs any command. Before, a task whose checks passed
  became done with a dependency still open, and that opened the gate of its
  own dependents
- task.evaluate now refuses a task that is already done (E_TASK_DONE) and
  writes nothing. Before, a later run wrote its results over a done task, so
  a failing re-run erased the passing evidence while the task stayed done
- a worker's `allowed_tools` now narrows its built-in tools to the ones it
  names (plus its belay tools). Before, it only pre-approved them, so every
  worker had Read, Edit, Write, Glob, Grep and Bash whatever it was given. A
  name that is not one of those six or an `mcp__` tool (web tools among
  them) is refused, the narrowing survives a restart, a resume and an adopt,
  and the orchestrator can no longer pass `tools`, `sandbox` or
  `max_budget_usd` to a spawn
- worker ids and run ids must now be safe path names: letters, digits, `.`,
  `_` and `-`, starting with a letter or digit, at most 64 characters (run
  ids at most 40), no `..`, no trailing dot and no Windows device name. A
  spawn also refuses an id that already belongs to another worker,
  case-insensitively. Before, a worker id with `../` could make a spawn write
  outside the data folder. **If a run spec names a `run_id` longer than 40
  characters, or with other characters, shorten it.**

Measured
- one 40-task build of a small command-line product, driven through belay on
  real Claude Code 2.1.293 by a pre-release 0.3.0 build (before the report
  flow below changed; that flow was then checked with its own real smoke
  run), with the 0.3.0 defaults and a project set, one task per run in
  sequence (parallel tasks in one run are not measured yet): every
  task landed and every run ended normally; $103.79 in all, $6.57 of it
  attempts voided by a bug in the test driver, none caused by belay. 101 notes
  were written, 72 were returned by memory search to a worker other than the
  writer, 30 were verified (29 by a task's reviewer, 1 by the archive
  review); the six run-close scrubs
  cost $0.012 together. There was no notes-off line, so this says nothing
  about whether notes help
- one paired run, 8 pairs of Sonnet 5.5 sessions on a fresh empty store:
  notes added 2,014 bytes to the first message and about 1,550 input tokens
  to the first request; worker cost +$0.0187 per session (standard error
  $0.0071, 7 of 8 pairs higher). One small run, not a release-wide cost
- the report flow as released, in its own smoke run on real Claude Code: a report held the note at once, the
  reviewer's verdict went on the hold, and the archive review archived the
  note on its own cites ($0.96 for the whole check)

Not shown
- that notes make workers succeed more often or cost less
- that review catches wrong notes
- that a note is found among thousands of others

Known limits
- a review run for a live run: closing that run stops the review's child. The
  panel's review button acts for the live run when it is the only one with
  notes on, and the panel shows a warning saying so. The held notes stay held,
  and the review can be run again once the run has ended
- the panel's cost for an interactive orchestrator is an estimate at API rates
  from Claude Code's session transcript; /clear starts a new transcript that
  belay does not follow, so after a /clear the figures stay those of the
  session belay launched
- `task_evaluate`'s file-scope check diffs from the merge-base with `main` by
  default. A worker that commits straight onto `main` leaves that range empty,
  and the check then passes with nothing to check (its detail says
  `empty_range: true`). Give workers their own branch, or pass `base`
- stopping a worker that exited long ago: some paths still read its
  recorded pid as alive, so after Windows reuses that pid, a stop can move
  the dead row back to stopping. Don't stop a worker that already shows dead.
  To be fixed in 0.3.1
- a read over the shared store client that misses its 300 ms bound closes
  the client, so writes still in flight on it fail with "outcome unknown"
  (E_OWNER_LOST, may have committed) although the owner then commits them.
  Parallel tool calls make this more likely. Re-read before retrying. To be
  fixed in 0.3.1
- a worker that dies within about a second of `worker_spawn` returning gets
  no death wake; check it with a short `worker_wait`. To be fixed in 0.3.1
- control pipes: a worker adapter's control pipe still believes the role it
  is sent (tickets for it are not built), so a same-user process, a worker's
  own child among them, can stop, pause, restart or message the workers of
  its run. To be fixed in 0.3.x
- notes written by reviewers are never judged: nothing reviews a review
  task, so its notes stay unverified unless reported wrong. In the 40-task
  build, 57 of the 61 notes left unverified were reviewers'
- withheld notes wait on the manual archive review: a reported note, correct
  or not, stays hidden from workers until you run belay memory review or
  settle it (unless archive_review_auto is set)
- the breaker is per run (a hand-back carries at most 20 reports): many runs
  that each report a few notes are not limited; the held count shows them
- the orchestrator's notes have no task reviewer; only a report brings them
  to the archive review
- a reviewer spawned without its task and given it later with task_assign
  is shown no notes to judge, so the reviewed work's notes stay unverified
- the operator is whoever runs belay's command line as this user, so a
  hostile process of the same user can settle or restore a held note
- belay memory held shows each report's latest reason: a reporter's repeat
  replaces its earlier report, so the earlier text is not kept
- operator commands are refused from a shell belay cannot trace to the
  operator's own process (for example a detached launcher whose parent has
  exited, or a shell another program spawned); run them from your own
  terminal
- notes do not go stale when the code changes; a verified note stays
  verified
- the first-message index stays off by default (first_message_index), so
  workers meet notes only when they search
- identity: a race in the process snapshot's chronology can let a detached
  helper a worker left running be taken for the operator (it needs a
  deliberately hostile same-user worker, which could also open the store
  file directly); and if a spawned worker's record cannot be written after
  its retries while the process snapshot is also unreadable, teardown may end
  only the parent and an unregistered helper can survive
- a parked worker of an ended run that is adopted or resumed after another
  run took overlapping files can launch without its file hold re-established;
  normal assignment refuses the overlap
- two narrow races: a task reviewer's captured note brief can be overwritten
  by a second reviewer's if the first capture stalls while you release its
  lease; and if a replaced worker's record of the notes it carried fails
  three writes and another process then adopts the worker, a note it never
  saw can be left out at its next resume
- in a run, a failed embedder pauses the run and memory search fails instead
  of falling back to keyword search (on_embedder_failure: required); the CLI
  search still falls back and says so
- the run-spec keys native_memory and handback_question exist for belay's
  own evaluations and are not supported; native_memory takes an absolute
  folder path and turns Claude Code's own auto memory back on for workers
- Windows only

## 0.2.0

Memory: truthful hybrid search, row status, redaction and safe framing on by
default; capture, summaries and a first-message index behind run levers. With
no "memory" block in the run spec, a run behaves as in 0.1.0, apart from the
store upgrade below.

Upgrade note
- the first 0.2.0 run upgrades an existing store to schema version 2; belay
  0.1.0 cannot open an upgraded store. Back up .belay\ first.

Added, on by default
- hybrid search (keyword and semantic fused) as the default memory search
  mode; --mode keyword and --mode semantic remain
- search results report modes_run, modes_failed and absence_established, with
  a warning when a mode failed or an empty result proves nothing; with no
  embedder a search answers from keyword search and says so
- keyword index (SQLite FTS5, trigram); a query with no term of 3+ characters
  fails by name instead of returning nothing
- row status (unverified, verified, refuted) with receipts; commit receipts
  are checked in git when the worktree is known; memory_verify tool for the
  orchestrator
- provenance columns: run, task, turn and source on each row
- redaction of secrets and <private> spans when a row is written; project
  copies are always redacted
- memory framed as data: BEGIN/END MEMORY around every injected block, row
  text kept off column 0, workers confined to their run and project, bounded
  writes
- index view, filters, timeline and fetch-many in memory_search,
  memory_retrieve and the new memory_timeline
- CLI: memory list, show, timeline, verify, export (live rows, --all),
  import (named namespaces only, rows typed "imported"); usage; memory search
  gains --mode, --index and filters; doctor checks the keyword index

Added, off by default (run spec "memory" block)
- capture from the worker event stream, mechanical per-turn observations,
  mechanical per-task summaries
- project namespace that outlives a run, with verified rows copied into it
- per-turn cost ledger
- first-message index ranked by relevance to the task, a resume built from the
  worker's own stream, a wrap-up per task and per run
- a read-only knowledge agent

Fixed
- memory search no longer slows quadratically with namespace size (a 10,000-row
  namespace went from minutes to about 100 ms)

Measured
- hybrid search over real memory rows: +0.023 mean reciprocal rank over
  semantic-only, interval -0.004 to +0.053 (not confirmed); clear gains on
  path and identifier queries
- with the right row in its first-message index, a worker avoided a hidden
  trap in 24 of 24 runs; with no memory or with placebo rows, in 0 of 24.
  Rows were hand-written; capture and retrieval at scale are not yet measured

Known limits
- redaction is pattern matching; raw stream logs are not redacted
- summaries are mechanical; a model-written summariser is not built
- copy-based reads slow down on very large stores (tens of thousands of rows)
- on a slow, heavily loaded machine (seen on a hosted CI runner), two processes
  racing to take over a stale store lock can both succeed, and two stops of the
  same worker can both run; a fix is in progress. Neither has been seen on a
  developer machine
- Windows only

## 0.1.0

First public release: the orchestration harness (workers as owned processes, leases, checkpoints, death detection, run pause, permission rows, receipts) with a semantic memory store.
