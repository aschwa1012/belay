# Changelog

## Unreleased

Added
- Windows CI: GitHub Actions runs the full test suite on every push to main
  and every pull request

Fixed
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
- tests no longer read old code from git history, assume Claude Code is
  installed, or rely on fixed sleeps, so the suite passes in any clone and on
  slow machines

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
