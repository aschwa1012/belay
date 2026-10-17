# belay

> **Windows only.** belay is built and tested on Windows 10/11 only. **As it stands, it will not work on macOS or Linux**: the way it proves which process to kill, its pipes and its console handling rely on Windows mechanisms. macOS and Linux support is planned, with no date.

belay is a local orchestration harness for AI coding agents. It runs Claude Code and codex sessions as worker processes on one machine, keeps every task, lease, checkpoint, review verdict and per-agent cost in one SQLite store, and lets one human watch and step in. The planner is a Claude session, headless or your own interactive one, that drives the workers through belay's MCP tools. The name is the climbing sense: belay does not do the climbing. It holds the rope, keeps the record and catches the fall.

**belay is early.** It is being built toward four things: memory that lasts across sessions, several orchestrators coordinating one body of work, workers that can be any model, including open-source and local ones, and autonomy: taking a queue of work and starting its own runs to work through it. None of the four is finished. 0.2.0 added the first large piece, a shared memory you can check. 0.3.0 added [notes](#notes-experimental-new-in-030), experimental and on by default once a project is named. 0.3.1 adds a worktree and branch per task and merges finished work into an integration branch, so one run can work on many tasks at once. [Where this is going](#where-this-is-going) says what each direction stands on today and what is planned.

Status: **0.3.1, early**, built and used by one developer. Interfaces, spec keys and the store layout may change. Upgrading from 0.3.0 changes some defaults; see the upgrade warning in [CHANGELOG.md](CHANGELOG.md) and [INSTALL.md](INSTALL.md#updating).

## Why, and what it does differently

Claude Code already does a lot of this natively, and for most tasks the native features are simpler. belay is **different, not better**. Nothing has measured belay against native Claude Code, so we make no claim that it gives better results.

**What Claude Code already has** (from the [Claude Code documentation](https://code.claude.com/docs), checked 2026-10-08; check the current docs, because they change often):

- Subagents, each with its own context window. Each subagent can set its own `model`, `effort`, `tools` allowlist, `permissionMode`, MCP servers, and a git worktree to work in.
- Agent teams (experimental, off by default). Teammates are separate Claude Code instances with a shared task list, task dependencies and direct messaging.
- Background sessions in agent view (research preview). Each one is its own Claude Code process run by a supervisor service, and can be stopped and respawned.
- CLAUDE.md files and auto memory that carry across sessions, and per-subagent persistent memory.
- Launch flags that limit what a session loads: `--tools`, `--strict-mcp-config`, `--setting-sources`, `--bare` and `--safe-mode`.
- `ANTHROPIC_BASE_URL`, for routing requests through a gateway. Anthropic does not support routing Claude Code to non-Claude models.

belay also sets a model and effort for each worker. That is a feature, not something only belay has.

**What belay does differently:**

- **Mixed substrates.** Claude Code and Codex CLI workers can run in the same run today, under the same task model. The launch table is designed to take more agent CLIs, so open-source or local-model agents could be added as substrates. That is an aim; it is not built.
- **Workers are processes belay spawns and owns.** Each worker is a separate OS process with its own context window, and belay is its parent; there is no supervisor service or daemon. You can kill, pause (park and resume) or restart each worker on its own. When a worker dies, belay detects it and reports it to the orchestrator. One worker crashing does not take the run down.
- **Leases record who owns which task.** A lease names the one worker that owns a task. The worker's adapter keeps the lease alive while the worker lives, and the worker releases it with a structured result. Tasks have dependencies. A task counts as `done` only when its checks pass, or, for a review task, when the reviewer's verdict holds. Fix rounds after a refuted review are counted, and the orchestrator is told when a task passes `max_fix_rounds`. A lease records ownership; it does not limit what a worker can do.
- **A verified launch surface.** belay starts each worker with no personal settings, plugins, auto memory or parent-directory instruction files. It passes in a chosen tool list and the worktree's own instructions. Then it checks what the worker actually loaded at startup and fails the launch if that differs. Native Claude Code lets you configure these things; belay also checks that they took effect.
- **Shared memory you can check.** One SQLite store that every agent in a run can read and write, persisting across runs, with a `project` namespace that outlives any one run. Search tells you which modes ran and whether an empty result means anything. Every row carries a status (unverified, verified or refuted) and records who wrote it; the writer and status are what the caller claimed, see the trust limit under [Notes](#notes-experimental-new-in-030). Secrets are redacted before a row is stored, and what an agent reads from memory is marked as data, not instructions. Once you name a project, workers hand back notes for later workers to find. Capture, summaries and an index in each worker's first message are built too, but stay off unless you turn them on. In a controlled experiment, workers given the right memory row avoided mistakes that workers without it made every time; see [What we have measured](#what-we-have-measured).
- **Operator control with receipts.** You can pause and resume a whole run. A permission request is a row you approve or deny. Every intervention names an id and returns proof. Kills are by exact pid, with proof of the process's identity. There is no daemon, and reading never writes.
- **A durable record.** Tasks, leases, checkpoints, verdicts and per-agent costs stay in a SQLite store after the run, so a later session can read what happened.


## How it works

```
   You
    |  CLI (window and hand)            Claude Code panel (read-only)
    v                                    v
 +-------------------------------------------------------------+
 | Orchestrator: a Claude session (headless, or your own one). |
 | It plans, delegates and judges. belay never does.           |
 +----------------------------+--------------------------------+
                              | MCP
                              v
     belay adapter (orchestrator role) --> Core API --> SQLite store
     parent of every worker                   ^
                              | spawns        | other processes reach the store
                              v               | through the owner's named pipe
     Claude Code worker -- belay adapter (worker role)
     Claude Code worker -- belay adapter (worker role)
     Codex worker       -- belay adapter (worker role)
```

- **The orchestrator is a Claude session, not code.** It creates tasks with machine-checkable acceptance criteria, spawns workers, waits, evaluates and decides.
- **belay is the substrate.** Spawning, leases, a checkpoint after every worker turn, death detection, restart from the last checkpoint and running acceptance commands are deterministic code.
- **Workers are real processes belay spawns and owns.** Each gets its own belay MCP adapter; its identity is in that adapter's command-line arguments.
- **You watch and intervene** from the CLI, or from a band and side pane inside Claude Code.

## Where this is going

Each direction below says what it stands on today, which is built, and what is planned, which is not.

### Memory that lasts across sessions

belay 0.2.0 built the parts of memory that can be built and checked without a model call. One experiment shows that a delivered memory row changes what a worker does. 0.3.0 adds notes, facts workers hand back for later workers, with a review and hold queue around them. Whether notes make workers better, and whether a note is found again in a large store, is not shown yet.

**On by default:**

- **One store.** belay's SQLite store is the only memory its agents have. Each worker's own Claude Code auto memory is switched off at launch (an unsupported evaluation key, `native_memory`, turns it back on; see [INSTALL.md](INSTALL.md#run-spec-keys)).
- **Hybrid search that says what it did.** Search fuses keyword and semantic results by default. You can also ask for `--mode keyword` or `--mode semantic`. Every result names the modes that ran (`modes_run`), the modes that failed and why (`modes_failed`), and `absence_established`. That last field is true only when keyword and semantic search both ran over every row in scope and nothing matched. If the embedder is not available, a search runs keyword alone and says so in a `warning` at the top of the result. An empty page is never presented as proof that nothing is stored.
- **A compact view.** `view: index` returns ids, types, statuses and titles, with no text. An agent can scan many rows cheaply and open only the ones it needs. There is also a timeline around any row.
- **Filters.** By type, status, worker, task, run and time.
- **Row status.** Every row is `unverified` until the orchestrator or you mark it `verified` or `refuted`. A mark needs a receipt that names its evidence: a checkpoint, a task, another row, a commit or a test. A commit receipt is checked against the repository when belay knows the worktree. Workers have no tool to mark a row; a note becomes verified only through a review verdict that quotes its evidence (see [Notes](#notes-experimental-new-in-030)). In a run with notes on, the orchestrator has no tool to mark rows either; it disputes a note by reporting it.
- **Provenance.** Each row records the run, task and turn that wrote it, and whether it came from a model, from belay itself, from an import or from you. The task comes from the worker's lease, not from anything the model says.
- **Redaction.** When a row is written, belay removes `<private>...</private>` spans. It replaces API keys, tokens, private keys, bearer headers, URL credentials and secret-looking values with `[REDACTED:<kind>]`. Rows copied into a project namespace are always redacted. This protects memory only: a worker's raw `stream.jsonl` log keeps what the worker saw. Redaction is pattern matching and will miss things; do not treat it as a guarantee.
- **Memory is data, not instructions.** One model's words become another model's input, so belay guards that path:
  - Every block of memory an agent reads is framed as data, between `BEGIN MEMORY` and `END MEMORY`.
  - Nothing a model wrote can start a line of its own inside that block.
  - A worker can read and write only its own run's rows and its project's rows.
  - A worker can change or delete only its own unverified rows.
  - A worker cannot choose a row's id, time or vector.
  - What a worker can write is bounded.
- **Read-only views.** `belay memory list`, `show`, `timeline` and `stats`, `belay usage` and `belay notices` all read without writing.
- **Moving rows between stores.** `belay memory export` writes live rows to a file; `--all` includes refuted, superseded and expired ones too. `belay memory import` writes only into namespaces you name. Every imported row arrives as an unverified row of type `imported`, so nothing in a file reaches an agent as a decision or a verified fact until you verify it in the new store.

**Off by default, behind levers in the run spec** (or as defaults in `belay.config.json`'s `memory` block, set with `belay settings memory.<lever> <value>`; a run spec's own block wins). With none of these turned on and no project named, a run produces the same events, rows and first messages as in 0.1.0. Naming a project turns on notes; see [Notes](#notes-experimental-new-in-030) for their levers.

| Lever | What it does |
|---|---|
| `rules` | Adds a short block of memory rules (search the index first, cite ids, treat unverified rows as unverified) to the orchestrator's prompt. |
| `capture` | Records each tool result's exit code, the files it touched and the first and last lines of its output, from the worker's event stream. No hooks. Redacted. |
| `observations` | Writes one mechanical row per worker turn: files read and changed, commands and their exit codes. No model call. Needs `capture`. |
| `summaries` | `"mechanical"` writes one summary per task from those rows, labelled as generated, not as the worker's words. Needs `observations`. |
| `project`, `project_writes` | Names a project namespace that outlives the run; `project_writes` copies observations, summaries and verified rows into it. Naming a project also turns on `notes`. `project_writes` together with notes is refused; set `notes: false` to keep it. |
| `notes` | On once `project` is set (and `redact` is on); `false` turns notes off. See [Notes](#notes-experimental-new-in-030). |
| `on_embedder_failure` | `required` (default: a failed embedder pauses the run), `keyword` (go on ranking by keywords only) or `off` (memory off for the run). The 0.2.0 values `stop` and `continue` are still accepted, as `required` and `keyword`. |
| `cost_ledger` | Records tokens and dollars per turn, for `belay usage`. |
| `first_message_index` | Puts a bounded index of lasting rows (summaries, decisions, verified rows) in a worker's first message, ranked by relevance to the task. `index_bytes` sets the size (default 1,200 bytes, at most 4,096). |
| `bottle` | When a worker is replaced, builds its resume document from its own stream: its text verbatim, tool calls as one line each, within `bottle_bytes`. |
| `wrapup` | Writes a short wrap-up per task and one for the run, shown once in `belay notices`. |
| `knowledge_agent` | A read-only worker that answers the orchestrator's questions from verified memory and the repository, citing row ids. |
| `redact` | On by default. Set to `false` to turn redaction off for one run; the row then records that it was off. Copies into a project namespace are redacted regardless. |
| `alpha` | The weight of semantic results against keyword results in hybrid search, 0 to 1, default 0.3. |

A lever that needs another lever, an unknown key or a bad value is a usage error that names the key.

**Turning levers on.** Add a `memory` block to the run spec. This one turns on capture, mechanical observations and summaries, and a bounded index in each worker's first message:

```json
{
  "worktree": ".",
  "prompt_file": "./prompt.md",
  "memory": {
    "project": "my-app",
    "capture": true,
    "observations": true,
    "summaries": "mechanical",
    "first_message_index": true,
    "index_bytes": 1200
  }
}
```

Levers cost something: observations add a few KB to the store per turn, and an injected index adds bytes to every first message. In the trap experiment below the index cost the same as no memory; in the first experiment memory cost about 18% more. Whether capture and summaries pay for themselves is not measured.

**Commands:**

```powershell
belay memory search "lease expired"                    # hybrid by default; check modes_run and absence_established
belay memory search "lease expired" --mode keyword     # keyword only; needs no embedder
belay memory search "lease expired" --index --status verified   # ids and titles only
belay memory list --type observation --task <task-id>  # filter rows
belay memory show <id>                                 # one or more rows in full
belay memory timeline <id> --before 5 --after 5        # what was written around a row
belay memory verify <id> --status verified --receipt commit:3e1de17   # needs a receipt
belay memory stats                                     # counts by type and status, keyword index state
belay memory export --out rows.jsonl                   # the newest run's live rows without vectors (name a run or --namespace for others); --all for every row; never overwrites a file
belay memory import rows.jsonl --namespace-map run/old=project/my-app   # every namespace in the file must be mapped
belay usage --by task                                  # per-turn tokens and dollars (needs cost_ledger)
belay memory held                                      # held notes, by ground; --awaiting for those waiting on you
belay memory review                                    # the archive review of the held queue (an Opus 5.5 child, capped at $2)
belay memory held settle <note-id> --archive --reason "<why>"   # or --release, --reoffer: settle one held note yourself
belay memory report <note-id> --reason "<why>"         # report a note wrong; it is held for the archive review
belay memory proposals                                 # the scrubber's proposals and the held queue
```

Read commands start no process. From the CLI, a search with no running embedder answers from keyword search and names the semantic half that did not run. Only `--mode semantic` refuses outright. Inside a run with the default `on_embedder_failure: required`, a failed embedder pauses the run and a worker's search fails instead. `belay memory verify`, `import`, `held settle` and the other write commands take the store owner for the length of the command; `memory review` and `memory scrub` also start one read-only model child.

**What is still planned:**

- A model-written summariser. Summaries today are mechanical only.
- An evaluation of notes on a real project build, with a held-out set and a native-memory baseline, to show whether they help.
- A way to judge notes written by reviewers, and tickets for workers' control pipes.
- Better search ranking, including choosing hybrid or semantic per query.
- Deciding whether the first-message index defaults to on, once that evaluation is done.

#### What we have measured

The experiments on search and on whether memory helps were pre-registered: the cases, the measures and the bar for success were fixed before any result was seen. The two 0.3.0 runs at the end check that notes work and what they cost; they do not test whether notes help.

**Search: hybrid against semantic only** (measured on 0.2.0's search; 0.3.0 changed the keyword half to match any term). The corpus was 2,442 memory rows that belay's own memory pipeline built from recorded runs. The 673 queries were mostly written by model agents that had not seen the corpus, plus queries taken from real runs, queries aimed at one known row, and queries with no answer. Model judges graded 20,972 query-row pairs, and a second judge on a sample agreed closely (weighted kappa 0.86). On held-out queries, hybrid search beat semantic-only by a small margin: mean reciprocal rank +0.023, with a 95% interval of -0.004 to +0.053. That interval includes zero, so by our own rule the gain is **not confirmed**. Recall in the top ten rose by 0.038 (0.016 to 0.063). The gain is concentrated where keyword search should help: on queries for file paths, the score rose from 0.58 to 0.85. Plain-language queries were flat, and lookups of past decisions lost a little (0.735 to 0.696). We made hybrid the default because the overall difference is small either way, and it fixes the case where semantic search is weakest: exact paths, identifiers and error text.

**Does memory help a worker? First attempt: no benefit, from a flawed experiment.** We ran 54 small coding tasks with and without a memory index in the worker's first message, and with a control that carried the same bytes without the content. Every arm passed the same tasks, and memory cost about 18% more. The null came from the design: most of the facts memory could supply were also in the task text or in files the worker read anyway, and the index showed the wrong rows. We fixed both before trying again.

**Second attempt: the right row prevents the mistake.** We built eight tasks, each hiding a trap in a fact the code cannot reveal: an external system's limit or format, an approach tried and rejected before, a migration number already used in production, an operator's formatting preference. Sonnet 5.5 ran each task three times in each of three arms, 72 runs in all:

| Arm | Avoided the trap |
|---|---|
| No memory | 0 of 24 |
| Placebo rows: same number, shape and size, about something else | 0 of 24 |
| The right row in the first-message index | 24 of 24 |

Every case passed its validity checks, including a check that the right row really was in the index. The memory arm cost the same as no memory. The limits are real: we wrote the rows by hand, each stating the exact fact, and the store held eight rows. This shows that a delivered fact gets applied. It does not show that belay captures such a fact on its own or finds it among thousands of rows.

**Third attempt: belay captures the fact itself.** We then ran that experiment, with belay capturing the fact from a worker's session (an earlier capture pipeline built on task summaries, not 0.3.0 notes). With nothing else in the store, the captured fact was applied in 7 of 24 later sessions, against 0 of 24 with no memory: just short of our bar, so inconclusive. Among 1,752 other rows, it was applied in 1 of 24. Where the repository already showed the fact, memory added nothing. belay still makes no broader claim that memory helps.

**0.3.0: a 40-task build with notes on.** belay drove a 40-task build of a small command-line product on real Claude Code 2.1.293, on a pre-release 0.3.0 build (before the report-flow change described under Notes; that flow was then checked with its own real smoke run), with the 0.3.0 defaults and a project set. It ran one task per run, in sequence: each run had a coder, its reviewer and any fix rounds, and no two tasks' workers ran at the same time. Every task landed and every run ended normally. It cost $103.79 in all, $6.57 of it attempts voided by a bug in the test driver, none caused by belay. Workers wrote 101 notes; 72 were returned by memory search to a worker other than the one that wrote them, and 30 were verified, 29 by a task's reviewer and 1 by the archive review. The six run-close scrubs cost $0.012 together. There was no notes-off comparison, so this shows that notes work end to end, not that they help.

**0.3.0: what notes cost.** In one small paired run (8 pairs of Sonnet 5.5 sessions on a fresh empty store, notes off against notes on), notes added 2,014 bytes to each worker's first message and about 1,550 input tokens to its first request. Worker cost rose by $0.0187 per session on average (standard error $0.0071; the pairs ranged from -$0.016 to +$0.052, and 7 of 8 cost more). That is one small run, not a cost to expect in a project whose store holds many notes.

#### Notes (experimental, new in 0.3.0)

**Notes are experimental.** They are on by default once a project is named, and they work end to end, but they have been tested in one 40-task build, never with thousands of notes. Nothing here says they make workers better.

**What a note is.** At the end of a task a worker can hand back up to 10 notes: a one-line claim, the situation that would run into it ("when"), how it knows (observed, inferred or relayed) and, when observed, the evidence it saw. belay stores each note in the project's memory with the worker, task and run that wrote it, and the files the worker changed. Later workers find notes with memory search. A note close to an existing one is held until the worker says whether it is new, a repeat, a replacement or a refinement.

**Project memory is notes.** With notes on, a `memory_store` into the project by a worker or the orchestrator is written as a note, and every rule on this page applies to it; a store without the note's fields is refused. The orchestrator records its decisions and run outcomes in `summary/<project>` instead. Rows already in the project that are not notes are not shown to workers or the orchestrator; `belay memory` commands still show them. `project_writes` together with notes is refused.

**Turning notes on.** Name a project: `belay settings memory.project my-app` (or `"memory": { "project": "my-app" }` in `belay.config.json` or the run spec). belay never guesses a project name. With none set, nothing is saved or recalled, and a notice says so in `belay run`, `status`, `doctor`, `settings` and the panel. `belay settings memory.notes false` turns notes off and silences it.

**How a note is checked.**
- **The task's reviewer.** A review task is shown the notes of the work it reviews and gives each a verdict (confirmed, refuted or unsupported) that must quote what it checked. Only such a cited verdict makes a note verified.
- **Reports.** A worker that finds a note wrong reports it when it hands back. A task reviewer's cited `refuted` verdict on a note is a report too; it does not change the note's status. You can report a note with `belay memory report <note-id> --reason <text> [--replaced-by <note-id>]`, a write that is refused inside a worker. The orchestrator has a `memory_report` tool, listed only when notes are on, so you can ask it to dispute a note; in a notes run it has no `memory_verify`. A reporter's repeat report replaces its earlier one. The note is held at once and counts in the held queue. A report that names a replacement (`--replaced-by`) holds the note as superseded by it only when the replacement passes the similarity check (a shared path or subject, or a stored similarity of at least 0.8); otherwise the note is held as wrong, and the result records that the superseded hold was refused. A reviewer's verdict on the report is recorded on the hold as advice; it does not release the note.
- **What workers see of a held note.** With `held_visibility: withhold` (the default), a reported note is left out of workers' index and search until the archive review or you settle it; the orchestrator still sees it, with its warning. With `warn`, it stays visible to workers, with its warning.
- **The breaker.** Once a run's reports have held more notes than the smaller of `held_breaker_count` (default 5) and `held_breaker_share` (default 0.2) of the project's live notes, where the share part is never less than 3 (so a 10-note project's runs can withhold 3), its further reports still hold notes but no longer withhold them, and the panel flags the run. Your own reports always withhold.
- **The archive review.** `belay memory review` (or the review button on the panel's memory line, which needs two presses) starts one Opus 5.5 child, capped at $2, over the held queue. During a live run the button acts for that run when it is the only one with notes on; closing that run stops the review (see the known limits). For a reported note it archives the note only on its own cites that show it wrong, releases it only as a cited verify that shows it right, or answers undecided and leaves it held for you. It never runs at run close unless you set `archive_review_auto`.
- **You.** `belay memory held` lists held notes and how many await you; `belay memory held settle <note-id> --archive|--release|--reoffer --reason <text> [--if-awaiting]` settles one; with `--if-awaiting` it is refused, and nothing is written, unless the note still awaits you. The panel does the same inside the pane: its list of notes that await you shows up to 5 rows, then "+N more · belay memory held --awaiting"; a row opens to its full title and reason, and archive, release or reoffer asks for a reason, then a confirm line, and only the confirm runs the settle (always with `--if-awaiting`). A settled note shows its outcome at once. A note you release has its reports settled but is not verified. `belay status`, `belay notices` and the panel show the held count by ground, for example "3 held: 2 reported wrong, 1 duplicate; 1 awaits you". The panel's held line also shows how long the oldest held note has waited.
- **The scrub at run close.** When the run has notes to check, Haiku 5.5 checks how they relate to the notes already stored (repeats, replaces, refines), capped at $0.10 and 300 s. It only proposes (`scrub_action: propose`); nothing is archived or merged without you (`belay memory proposals`).

**Levers** (in the `memory` block; defaults shown):

| Lever | Default | What it does |
|---|---|---|
| `notes` | on with a project | Ask workers for notes, store them, check them. |
| `scrub_action` | `propose` | `off`, `propose` or `apply` for the run-close scrub. |
| `scrub_model`, `scrub_cost_cap_usd`, `scrub_wall_s` | Haiku 5.5, 0.1, 300 | The scrub's model and caps. |
| `archive_review_auto` | `false` | Run the archive review at run close too. |
| `archive_review_model`, `review_cost_cap_usd`, `review_wall_s` | Opus 5.5, 2, 600 | The archive review's model and caps. |
| `first_message_index` | `false` | Also put the most relevant notes in each worker's first message. Off by default, so workers meet notes only when they search. |
| `held_visibility` | `withhold` | `withhold` leaves a reported note out of workers' reads until it is settled; `warn` shows it with its warning. |
| `held_breaker_count`, `held_breaker_share` | 5, 0.2 | The breaker's limits: a count (1 to 500) and a share of the project's live notes (above 0, at most 1; the share part never below 3 notes). |

There is no separate note-review job. A setting that names one (`note_review: true`, `note_review_model`, `note_review_cost_cap_usd`) is refused with a message that says why; `note_review: false` is accepted and does nothing.

**What is not shown.**
- **Value.** No experiment has yet shown that notes make a worker succeed more often or cost less.
- **Review quality.** We make no claim that review catches wrong notes.
- **Finding notes in a large store.** In tests with thousands of notes, the first-message index and search rarely surfaced the one note that mattered.

**Known limits.**
- **Notes written by reviewers are never judged.** Nothing reviews a review task, so its notes stay unverified unless someone reports them wrong. In the 40-task build, 57 of the 61 notes left unverified were written by reviewers.
- **Notes do not go stale when the code changes.** A note records no commit, and nothing compares it with the code later. A note about a file that has since been rewritten is still shown, with the status it had, until a worker reports it wrong or you archive it. A verified note stays verified.
- **Withheld notes wait on you.** The archive review is manual unless you set `archive_review_auto`, so a reported note, correct or not, stays hidden from workers until you run `belay memory review` or settle it.
- **The breaker is per run.** A hand-back carries at most 20 reports, and the breaker bounds how many notes one run's reports can withhold. Many runs that each report a few notes are not limited; the held count shows them.
- **The orchestrator's notes have no task reviewer.** Only a report brings them to the archive review.
- **A reviewer given its task later sees no notes to judge.** The notes of the reviewed work are shown only in the first message of a reviewer spawned with its task; a reviewer spawned without one and then given it with `task_assign` judges no notes, and those notes stay unverified.
- **The held listing shows each report's latest reason.** `belay memory held` shows each report's latest reason; a reporter's repeat replaces its earlier report, so the earlier text is not kept.
- **A review for a live run is cut when the run closes.** The panel's review button acts for the live run when it is the only run with notes on, and the panel warns that closing the run stops the review's child. The held notes stay held, and you can run the review again.
- **The orchestrator's cost in the panel is an estimate.** For an interactive run it is worked out at API rates from Claude Code's session transcript and shown as ≈$. `/clear` starts a new transcript that belay does not follow, so after a `/clear` the figures stay those of the session belay launched.
- **Operator commands need your own terminal.** They are refused from a shell belay cannot trace to your own process, for example a detached launcher whose parent has exited, or a shell another program spawned. Run them from your own terminal.
- **Who can mark a note.** belay records who wrote a note and who changed its status, and 0.3.0 binds a caller's identity to the calling process instead of taking the role from the request. A worker's shell and the processes it starts can no longer act as the operator, nor can other stores' workers, the orphans of workers that exited, or a failed start's leftover key; an unreadable register refuses. Still open:
  - a worker adapter's control pipe still believes the role it is sent (tickets for it are not built), so a same-user process, a worker's own child among them, can stop, pause, restart or message the workers of its run;
  - a race in the process snapshot's chronology: a snapshot taken before a worker exits can retire its record without noting a detached helper it left running, which a later store owner may then accept as the operator. It needs a deliberately hostile same-user worker, which could also open the store file directly;
  - a double fault: if a spawned worker's record cannot be written after its retries and the process snapshot is also unreadable, teardown may end only the parent, and an unregistered helper can survive;
  - you are whoever runs belay's command line as your user, so a hostile process of the same user can settle or restore a held note.

  Commands that need the operator's authority cost about 1 s more, once per connection; ordinary reads do not. Treat a note's status and "written by" as a record of what was claimed, strongest against accident, not proof against a hostile process on the same account.
- **File holds across runs.** A parked worker of an ended run that is adopted or resumed after another run took overlapping files can launch without its file hold re-established. Normal assignment refuses the overlap.
- **Two narrow races.** A task reviewer's captured note brief can be overwritten by a second reviewer's if the first capture stalls while you release its lease. If a replaced worker's record of the notes it carried fails three writes and another process then adopts the worker, a note it never saw can be left out at its next resume.
- **Search needs the embedder in a run.** With the default `on_embedder_failure: required`, a run whose embedder fails pauses, and a worker's memory search fails rather than falling back to keyword search. Resume with `belay resume <run-id> --embedder keyword|off` to go on without it; that choice is also written to the config file as `memory.on_embedder_failure`, so later runs inherit it. The `belay memory search` command still answers from keyword search when no embedder is running, and says so.

### Several orchestrators, one body of work

**Built today:**

- **The orchestrator is a Claude session, not code.** It is attached to the store over MCP.
- **The coordination point is the store and its owner process**, not any one session.
- **Control travels on pipes that belay owns.** Messages between sessions carry no authority.

**Planned:** several orchestrators attached to one store, coordinating as peer sessions do. This is not built.

### Workers that can be any model

**Built today:**

- **Substrates.** Workers sit behind a launch table, one entry per agent CLI. Claude Code and Codex CLI are the two built today.
- **One event vocabulary.** Each substrate's output is translated into the same normalised events (ready, tool use, assistant text, turn end and so on), so nothing downstream reads a substrate's own format.
- **Model-independent mechanics.** Liveness, leases, kills and receipts come from processes, those events and the store, not from the model.

**Planned:** more substrates, including open-source and local models, run through agent CLIs that host them. This is not built. Adding a substrate means a launch entry, a stream parser, and the places where the run manager still handles each substrate differently.

### Autonomy: working through a queue

The goal is that, once belay is mature, it can take a large queue of work and start its own orchestrated runs, with headless orchestrators, to work through it, without a human starting each run.

**Built today.** These are what make it safe to attempt unattended work at all:

- **Headless runs.** `belay run` without `--interactive` runs a headless orchestrator from start to finish, with no one at the keyboard.
- **Tasks with dependencies.** A task cannot be assigned until the tasks it depends on are done.
- **Parallel tasks, merged.** Each task can have its own worktree and branch. `integrate` merges finished tasks into an integration branch at the commit that was judged, checks the merged head (plus any checks of its own), and reports conflicts and what was left out. `max_parallel_evaluations` caps how many checks run at once.
- **Review verdicts gate `done`.** A task counts as done only when its checks pass, or, for a review task, when the reviewer's verdict holds.
- **Counted fix rounds.** Past `max_fix_rounds` a new fix task carries a notice to the orchestrator; `fix_hard_cap` is the only refusal (5 by default for a run with no `timeout_ms`, none for a run with one), and `fix_cutoff` says whether the orchestrator may stop sooner.
- **Run time bound.** `timeout_ms` ends a headless run that runs too long. A paused run's clock stops.
- **Pause and resume a whole run.**
- **Death detection and wakes.** A worker that dies or ends a turn wakes the orchestrator, which can restart it or move on.
- **Receipts** for every action: rows, pids, exit codes, costs per agent (a worker killed mid-turn gets an estimate, labelled as one), each task's check history, and a `run.json` for each run.

**Measured in 0.3.1.** The same 10 tickets of a small command-line product were run in parallel by 0.3.1 twice, headless, with the orchestrator choosing how to split and bundle them. Each run took about an hour (59 and 64 minutes) against about 5 hours for the same tickets done one at a time on a 0.3.0-era build, and cost $18.68 and $16.20 against $28.31 (about 35 to 45% less). Both met the quality bar fixed before the runs: hidden regression tests passed at 0.914 and 0.919 against the sequential run's 0.928 (the bar allowed 0.05 less), and 5 of 9 scored tickets passed all their own tests, as in the sequential run. Two runs on one product are a pilot, not a benchmark.

**Planned:**

- a work queue that spans runs;
- belay starting its own orchestrated runs from that queue;
- the budgets and limits this needs, such as spend caps and a cap on how many runs and workers go at once.

This is not built. belay has no spend cap today; a run's cost is recorded, not limited.

## Quick start (about 5 minutes, plus a ~253 MB download)

Requires Windows 10/11, Node.js >= 24.19.0, Claude Code >= 2.1.280, git and PowerShell. Details in [INSTALL.md](INSTALL.md).

```powershell
# 1. Install from GitHub (nothing is on the npm registry yet)
npm install -g github:aschwa1012/belay

# 2. Fetch the embedding model once per machine (~253 MB; belay run will not start without it)
belay embedder fetch

# 3. In your project (a git repository), write belay.config.json and create .belay/
cd C:\path\to\your-project
belay init
belay doctor

# 4. Optional: name a memory project, which turns on notes (experimental)
belay settings memory.project my-app
```

Copy the interactive orchestrator prompt next to your spec:

```powershell
Copy-Item "$(npm root -g)\@aschwa1012\belay\src\run\prompts\orchestrator-interactive.md" .\prompt.md
```

Write a minimal spec, `belay-spec.json`:

```json
{
  "worktree": ".",
  "prompt_file": "./prompt.md"
}
```

Start it:

```powershell
belay run belay-spec.json --interactive
```

What you will see:

- Claude Code opens in your own console as the orchestrator. If it asks whether to trust the folder, answer yes; declining ends the run.
- belay passes no first prompt. Type your brief: what to build, and how to check it.
- A **band** above the prompt shows the run, the agent count, the cost and the newest notice. Type **`/orch`** to toggle the side **panel**: each agent's state, model, task, context size and cost, plus the run's notices. The orchestrator's row shows its context tokens, an estimated cost (≈$, at API rates, from Claude Code's session transcript) and the prompt-cache timer.
- When a worker finishes a turn or dies, belay wakes the orchestrator in the same session.
- The run ends when you quit the session.

Without `--interactive`, `belay run` runs a headless orchestrator. Its prompt file must then carry your brief: copy `orchestrator.md` instead and append the brief to it. Follow a headless run with `belay agents`, `belay notices` and `belay transcript -f`.

## Commands

Every command declares one mode: **R** read-only (starts no process, creates no file; the one exception is `mcp status --deep`, which spawns one adapter to ask it), **W** store client, **C** run control over a harness-owned pipe. `--json` gives machine-readable output; `--data <dir>` picks a data directory.

| Command | Mode | What it does |
|---|---|---|
| `help` | R | Usage |
| `config [path\|get <key>]` | R | Which config file is read, and the effective `data_dir`, `claude_exe`, `codex_exe` and `mod.*` values with their sources; memory and agent values are shown by `belay settings` |
| `doctor [--fix]` | R | Checks config, store, Claude Code and Codex binaries, embedder (`--fix` only creates a missing data dir) |
| `status [run-id]` | R | Status as six rungs, each naming its evidence |
| `agents [run-id]` | R | The orchestrator and each worker: model, effort, state, context, cost |
| `workers` / `tasks [run-id] [--all]` | R | Worker rows with derived liveness; task rows with lease, holder and checkpoint |
| `notices [run-id]` | R | Permission requests, dead or stalled workers, verdicts, pause and end |
| `transcript [run-id] [-f]` | R | A headless orchestrator's stream, readable |
| `logs <worker-id> [-f]` | R | A worker's raw stream |
| `receipts [run-id]` | R | Per-agent model, turns, tokens, cost, tool calls, wall clock, checks |
| `diff [run-id] [--since ts]` | R | Rows changed since a mark |
| `worktrees [run-id] [--all]` | R | Each task's worktree and branch, and the run's integrations |
| `briefing <worker-id>` | R | The resume material a worker would get |
| `memory search <q> [--mode hybrid\|keyword\|semantic] [--index]` | R | Search shared memory; the result says which modes ran |
| `memory list` / `show` / `timeline` / `stats` | R | Filtered rows, full rows, what was written around a row, counts |
| `memory export [--out file] [--all]` | R | Write rows to a file, without vectors |
| `memory held [--awaiting]` / `memory proposals` | R | Held notes by ground; the scrubber's proposals and nominations |
| `usage [run-id] [--by task\|worker\|model\|turn]` | R | Tokens and dollars per turn (needs the `cost_ledger` lever) |
| `mcp status [--deep]` | R | MCP server facts, one by one; `--deep` spawns one adapter and asks it to answer |
| `pending [--all]` | R | Tool calls waiting on a verdict |
| `init` | W | Write `belay.config.json` and create the data dir (never overwrites) |
| `run <spec.json> [--interactive] [--effort level]` | W | Start a run; the store owner for its lifetime |
| `embedder fetch\|verify` | W | Download or re-hash the embedding model |
| `settings [<key> [<value>]]` | W | Panel display settings, memory lever defaults and per-agent-type model and effort defaults, written to the config file only |
| `worktree create\|remove\|merge <task-id>...` | W | Make or remove a task's worktree and branch, or merge tasks into an integration branch, as the orchestrator's tools do |
| `memory verify <id> --status s --receipt r` | W | Mark a row verified or refuted, with its evidence (a note can be refuted this way, but is verified only by a review) |
| `memory import <file> --namespace-map from=to` | W | Import rows as unverified, into namespaces you name |
| `memory review` / `memory scrub` | W | The archive review of held notes, or the run-close scrub, by hand; each starts one read-only model child |
| `memory held settle <note-id> --archive\|--release\|--reoffer --reason r` | W | Settle one held note yourself |
| `memory report <note-id> --reason r [--replaced-by <note-id>]` | W | Report a note wrong; it is held for the archive review, as a worker's report holds it |
| `memory restore` / `resolve` / `promote` / `archive purge` / `embed` | W | Bring back an archived note, settle a pending one, approve a note for CLAUDE.md, purge archived notes, embed notes that have no vector |
| `stop <run-id>` | C | Stop a live run and reap its workers |
| `pause` / `resume <worker-id\|run-id>` | C | Park a worker (or every worker in a run) and relaunch it on its session |
| `message <worker-id> <text>` | C | Send a turn to a worker |
| `worker kill\|rm\|stop\|restart <worker-id>` | C | Kill by exact pid, forget a dead worker, stop or restart it |
| `task assign <task-id> <worker-id>` | C | Assign an open task |
| `take-control <task-id>` | C | Move a task's lease to you and pause its worker |
| `approve` / `deny <request-id>` | C | Answer one pending tool call |

Every intervention returns proof: the row it wrote, the pid it acted on, the exit code, or a refusal that says why.

## Configuration

- **`belay.config.json`**, found by walking up from the current directory to the project root (never into your home directory). Keys: `data_dir` (default `.belay`), `claude_exe`, `codex_exe`, the panel's `mod.*` display settings, a `memory` block of lever defaults (`project` among them), and an `agents` block of model and effort defaults per agent type (`agents.reviewer.model`, `agents.coder.effort`, `agents.<type>.codex_model`, and `agents.orchestrator.model|effort`). `belay settings` lists and sets the `mod.*`, `memory` and `agents` keys; edit `data_dir`, `claude_exe` and `codex_exe` in the file itself (or use `BELAY_CLAUDE_EXE` and `BELAY_CODEX_EXE`), and see them with `belay config`. A run spec's own values win. With no `agents` defaults set, coders and testers run Sonnet 5.5, reviewers and researchers Opus 5.5 at effort high.
- **The run spec** (`belay run <spec.json>`): `worktree` and one of `prompt_file` (your own prompt) or `brief_file` (your brief inside belay's current template) are required. Optional keys include `model` (default `claude-opus-5-5`), `mode`, `timeout_ms`, `max_fix_rounds` (default 2), `fix_hard_cap`, `fix_cutoff`, `max_parallel_evaluations`, `on_embedder_failure`, and a `memory` block of levers (see [Memory](#memory-that-lasts-across-sessions)). An unknown key is an error. Full list in [INSTALL.md](INSTALL.md#run-spec-keys).
- **Finding Claude Code and Codex**: `BELAY_CLAUDE_EXE`, then `claude_exe` in the config, then `claude` on PATH (Codex likewise with `BELAY_CODEX_EXE`, `codex_exe`, `codex`); `belay doctor` shows which path it found and where it came from. See [INSTALL.md](INSTALL.md#finding-claude-code).

## Design rules

These are settled rules, not aspirations:

- **No daemon.** The process that owns the store is elected on demand and dies with whoever needed it. Nothing keeps running after you are done.
- **belay is the parent of every worker.** It sees every worker exit, so "is it alive?" always has a real answer.
- **Identity comes from process arguments only.** Never from a prompt or anything a model says. A worker cannot name itself.
- **Liveness is derived, never self-reported.** Process exit, a pid check, the age of the last event. Each status rung names what established it.
- **No success without effect.** Every write returns the row it wrote or an error.
- **Reading never writes.** Read commands copy the database and read the copy.
- **Kills are by exact pid, with proof of identity**: a live child handle, or the process creation time recorded at spawn matched against a fresh snapshot. If identity cannot be proved, the kill is refused and you are told how to end the process by hand.
- **Control travels only on harness-owned pipes.** Messages between sessions carry no authority.
- **Budgets are real** and gated in the test suite: read commands add under 500 ms over Node's own start-up, status under 100 ms in process, at most 400 bytes injected per hook event, and no read path loads the embedding library.

## Limitations

- **Windows only.** Off Windows, identity-checked kills are refused and survivors are left running. Do not try it on macOS or Linux yet.
- **The embedder is required for a run.** An optional npm dependency plus a ~253 MB model. Read commands work without it; `belay run` refuses to start.
- **A copied prompt does not update itself.** With `prompt_file` you own a copy of the template, and an upgrade does not refresh it: copy the template again after one (`belay run` warns when your copy is older than the shipped template), or use `brief_file`, which always wraps your brief in the current template.
- **Merges into your own branches are not guarded.** belay makes a worktree and branch per task and merges finished work into an integration branch, but the orchestrator can also merge into any branch it names, your checked-out branch included, with no approval step. Keep its work on the integration branch and merge that yourself.
- **No sandbox.** A worker acts with your permissions, and a program it runs can write anywhere you can. belay's worktrees, file holds and tool lists keep agents apart from each other; they do not contain them.
- **The orchestrator's restraint is a prompt rule.** It has the same six tools as a worker, plus read-only `git_read`; the template tells it to plan and delegate rather than do the code work. Shell commands that stop processes by name are refused for a headless orchestrator and for workers, but that guard matches command text and is not a sandbox.
- **Reviewer severity is a prompt rubric**, and reviewers have under-rated real defects.
- **Pause and compaction are Claude Code features.** A Codex worker can't be paused or parked yet, and the compaction lever applies to Claude Code workers only.
- **The panel depends on Claude Code's plugin engine**, measured on Claude Code 2.1.293.
- **One store owner**, single-threaded: about 1,200 operations a second.
- **Memory is mostly scaffolding.** Most memory features are off by default. Only delivery of a hand-written row has been shown to help. Notes (0.3.0) are experimental and have their own [known limits](#notes-experimental-new-in-030). Redaction is pattern matching, and a worker's raw stream log is not redacted. Keyword search matches any of the query's terms, ignores terms shorter than three characters and says so, and in hybrid search and the index also drops common English stopwords and terms found in half the rows or more. Read commands copy the store, so they slow down on stores of tens of thousands of rows.

## Status and roadmap

belay is at 0.3.1. It already drives real multi-agent runs, and parts of belay itself were built by belay: a coder, a reviewer, fix rounds and a second reviewer, run unattended with a receipt for every agent. Before 0.3.0 shipped, a pre-release 0.3.0 build drove a 40-task build of a separate product from start to finish on real Claude Code, one task per run (see [What we have measured](#what-we-have-measured)). In 0.3.1, two runs did 10 tickets of that product at once, each in its own worktree with its work merged together, in about an hour each against about 5 hours one ticket at a time (see [Autonomy](#autonomy-working-through-a-queue)).

**How 0.2.0 was built.** The memory work was built in about two days by many Claude Code agents working in parallel, each on its own branch, with a lead session planning and merging. Every wave of branches was checked by an independent reviewer agent and fixed before merging. belay itself drove part of the work: the redaction commits by `belay job` came from a belay run with its own reviewers. The commit history keeps those branches, merges and timestamps as they happened. The design decisions and experiments behind it were pre-registered and measured, and are summarised under [What we have measured](#what-we-have-measured).

Directions, with no dates and no promises:

- **macOS and Linux support** (planned).
- **Memory that lasts across sessions**: truthful hybrid search, row status, redaction and the data framing are built and on. Notes are built, experimental, and on once a project is named. Capture, summaries, the first-message index, compact resumes and a knowledge agent are built behind off-by-default levers. Next: an evaluation of notes on a real project build, with a held-out set and a native-memory baseline. See [Where this is going](#where-this-is-going).
- **Multiple orchestrators** coordinating as peers over one store.
- **More worker substrates**, including open-source and local models through agent CLIs that run them.
- **Autonomy**: a work queue across runs, belay starting its own headless runs from it, and the spend and concurrency limits that needs.
- **Evals**: whether notes help on a real project build, whether a note is found in a large store, and a head-to-head comparison with native Claude Code agents.

Bugs, ideas and porting help: [GitHub Issues](https://github.com/aschwa1012/belay/issues).

## Contributing

Issues and pull requests are welcome. To run the tests, clone the repository and run `npm install`. You need Windows and Node >= 24.19.0.

- **`npm test`** runs the unit, conformance and budget suites against fake Claude Code and Codex executables, so it spends nothing. CI runs the same suite on a GitHub Windows runner for every pull request.
- One integration test launches a real Claude Code worker on your account and costs tokens. It is skipped unless you set `BELAY_REAL=1`.
- Some timing tests are sensitive to machine load; if one fails, rerun it alone before reporting it.

Keep files under 500 lines. Back any performance or behaviour claim with the command, its exit code and its timing.


## License

MIT. See [LICENSE](LICENSE).
