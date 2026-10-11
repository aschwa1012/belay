# belay

> **Windows only.** belay is built and tested on Windows 10/11 only. **As it stands, it will not work on macOS or Linux**: the way it proves which process to kill, its pipes and its console handling rely on Windows mechanisms. macOS and Linux support is planned, with no date.

belay is a local orchestration harness for AI coding agents. It runs Claude Code and codex sessions as worker processes on one machine, keeps every task, lease, checkpoint, review verdict and per-agent cost in one SQLite store, and lets one human watch and step in. The planner is a Claude session, headless or your own interactive one, that drives the workers through belay's MCP tools. The name is the climbing sense: belay does not do the climbing. It holds the rope, keeps the record and catches the fall.

**belay is early.** It is being built toward four things: memory that lasts across sessions, several orchestrators coordinating one body of work, workers that can be any model, including open-source and local ones, and autonomy: taking a queue of work and starting its own runs to work through it. None of the four is finished. 0.2.0 adds the first large piece, a shared memory you can check. [Where this is going](#where-this-is-going) says what each direction stands on today and what is planned.

Status: **0.2.0, early**, built and used by one developer. Interfaces, spec keys and the store layout may change. 0.2.0 upgrades an existing store to a format 0.1.0 cannot read; see [INSTALL.md](INSTALL.md#updating).

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
- **Leases record who owns which task.** A lease names the one worker that owns a task. The worker's adapter keeps the lease alive while the worker lives, and the worker releases it with a structured result. Tasks have dependencies. A task counts as `done` only when its checks pass, or, for a review task, when the reviewer's verdict holds. Fix rounds after a refuted review are capped. A lease records ownership; it does not limit what a worker can do.
- **A verified launch surface.** belay starts each worker with no personal settings, plugins, auto memory or parent-directory instruction files. It passes in a chosen tool list and the worktree's own instructions. Then it checks what the worker actually loaded at startup and fails the launch if that differs. Native Claude Code lets you configure these things; belay also checks that they took effect.
- **Shared memory you can check.** One SQLite store that every agent in a run can read and write, persisting across runs, with a `project` namespace that outlives any one run. Search tells you which modes ran and whether an empty result means anything. Every row carries a status (unverified, verified or refuted) and records who wrote it. Secrets are redacted before a row is stored, and what an agent reads from memory is marked as data, not instructions. Capture, summaries and an index in each worker's first message are built too, but stay off unless you turn them on. In a controlled experiment, workers given the right memory row avoided mistakes that workers without it made every time; see [What we have measured](#what-we-have-measured).
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

belay 0.2.0 builds the parts of memory that can be built and checked without a model call. One experiment shows that a delivered memory row changes what a worker does. Whether belay captures such facts by itself, and finds them again in a large store, is not shown yet.

**On by default:**

- **One store.** belay's SQLite store is the only memory its agents have. Each worker's own Claude Code auto memory is switched off at launch.
- **Hybrid search that says what it did.** Search fuses keyword and semantic results by default. You can also ask for `--mode keyword` or `--mode semantic`. Every result names the modes that ran (`modes_run`), the modes that failed and why (`modes_failed`), and `absence_established`. That last field is true only when keyword and semantic search both ran over every row in scope and nothing matched. If the embedder is not available, a search runs keyword alone and says so in a `warning` at the top of the result. An empty page is never presented as proof that nothing is stored.
- **A compact view.** `view: index` returns ids, types, statuses and titles, with no text. An agent can scan many rows cheaply and open only the ones it needs. There is also a timeline around any row.
- **Filters.** By type, status, worker, task, run and time.
- **Row status.** Every row is `unverified` until the orchestrator or you mark it `verified` or `refuted`. A mark needs a receipt that names its evidence: a checkpoint, a task, another row, a commit or a test. A commit receipt is checked against the repository when belay knows the worktree. A worker cannot verify a claim, its own or anyone else's.
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

**Off by default, behind levers in the run spec.** With none of these turned on, a run produces the same events, rows and first messages as in 0.1.0.

| Lever | What it does |
|---|---|
| `rules` | Adds a short block of memory rules (search the index first, cite ids, treat unverified rows as unverified) to the orchestrator's prompt. |
| `capture` | Records each tool result's exit code, the files it touched and the first and last lines of its output, from the worker's event stream. No hooks. Redacted. |
| `observations` | Writes one mechanical row per worker turn: files read and changed, commands and their exit codes. No model call. Needs `capture`. |
| `summaries` | `"mechanical"` writes one summary per task from those rows, labelled as generated, not as the worker's words. Needs `observations`. |
| `project`, `project_writes` | Names a project namespace that outlives the run, and copies observations, summaries and verified rows into it. |
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

Levers cost something: observations add a few KB to the store per turn, and an injected index adds bytes to every first message. In our experiment the index added no measurable cost (see below). Whether capture and summaries pay for themselves is not measured.

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
belay memory export --out rows.jsonl                   # live rows without vectors; --all for every row; never overwrites a file
belay memory import rows.jsonl --namespace-map run/old=project/my-app   # every namespace in the file must be mapped
belay usage --by task                                  # per-turn tokens and dollars (needs cost_ledger)
```

Read commands start no process. A search with no running embedder answers from keyword search and names the semantic half that did not run. Only `--mode semantic` refuses outright. `belay memory verify` and `import` write, so they take the store owner for the length of the command.

**What is still planned:**

- A model-written summariser. Summaries today are mechanical only.
- An experiment in which belay captures a fact itself in one session and delivers it in a later one, from a store that also holds many unrelated rows.
- Better search ranking: an OR keyword join, and choosing hybrid or semantic per query. Both looked promising in our evaluation but are not yet confirmed.
- Making the memory index default to on, once that experiment is done.

#### What we have measured

Each experiment below was pre-registered: the cases, the measures and the bar for success were fixed before any result was seen.

**Search: hybrid against semantic only.** The corpus was 2,442 memory rows that belay's own memory pipeline built from recorded runs. The 673 queries were mostly written by model agents that had not seen the corpus, plus queries taken from real runs, queries aimed at one known row, and queries with no answer. Model judges graded 20,972 query-row pairs, and a second judge on a sample agreed closely (weighted kappa 0.86). On held-out queries, hybrid search beat semantic-only by a small margin: mean reciprocal rank +0.023, with a 95% interval of -0.004 to +0.053. That interval includes zero, so by our own rule the gain is **not confirmed**. Recall in the top ten rose by 0.038 (0.016 to 0.063). The gain is concentrated where keyword search should help: on queries for file paths, the score rose from 0.58 to 0.85. Plain-language queries were flat, and lookups of past decisions lost a little (0.735 to 0.696). We made hybrid the default because the overall difference is small either way, and it fixes the case where semantic search is weakest: exact paths, identifiers and error text.

**Does memory help a worker? First attempt: no benefit, from a flawed experiment.** We ran 54 small coding tasks with and without a memory index in the worker's first message, and with a control that carried the same bytes without the content. Every arm passed the same tasks, and memory cost about 18% more. The null came from the design: most of the facts memory could supply were also in the task text or in files the worker read anyway, and the index showed the wrong rows. We fixed both before trying again.

**Second attempt: the right row prevents the mistake.** We built eight tasks, each hiding a trap in a fact the code cannot reveal: an external system's limit or format, an approach tried and rejected before, a migration number already used in production, an operator's formatting preference. Sonnet 5.5 ran each task three times in each of three arms, 72 runs in all:

| Arm | Avoided the trap |
|---|---|
| No memory | 0 of 24 |
| Placebo rows: same number, shape and size, about something else | 0 of 24 |
| The right row in the first-message index | 24 of 24 |

Every case passed its validity checks, including a check that the right row really was in the index. The memory arm cost the same as no memory. The limits are real: we wrote the rows by hand, each stating the exact fact, and the store held eight rows. This shows that a delivered fact gets applied. It does not show that belay captures such a fact on its own or finds it among thousands of rows. That is the next experiment, and until it runs, belay makes no broader claim that memory helps.

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
- **Review verdicts gate `done`.** A task counts as done only when its checks pass, or, for a review task, when the reviewer's verdict holds.
- **Capped fix rounds.** `max_fix_rounds` limits how many fix tasks can follow refuted reviews. The store refuses one more, and `fix_cutoff` says whether the orchestrator may stop sooner.
- **Run time bound.** `timeout_ms` ends a headless run that runs too long. A paused run's clock stops.
- **Pause and resume a whole run.**
- **Death detection and wakes.** A worker that dies or ends a turn wakes the orchestrator, which can restart it or move on.
- **Receipts** for every action: rows, pids, exit codes, costs per agent, and a `run.json` for each run.

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
- A **band** above the prompt shows the run, the agent count, the cost and the newest notice. Type **`/orch`** to toggle the side **panel**: each agent's state, model, task, context size and cost, plus the run's notices.
- When a worker finishes a turn or dies, belay wakes the orchestrator in the same session.
- The run ends when you quit the session.

Without `--interactive`, `belay run` runs a headless orchestrator. Its prompt file must then carry your brief: copy `orchestrator.md` instead and append the brief to it. Follow a headless run with `belay agents`, `belay notices` and `belay transcript -f`.

## Commands

Every command declares one mode: **R** read-only (starts no process, creates no file), **W** store client, **C** run control over a harness-owned pipe. `--json` gives machine-readable output; `--data <dir>` picks a data directory.

| Command | Mode | What it does |
|---|---|---|
| `help` | R | Usage |
| `config [path\|get <key>]` | R | Which config file is read, and each effective value with its source |
| `doctor [--fix]` | R | Checks config, store, Claude Code and Codex binaries, embedder (`--fix` only creates a missing data dir) |
| `status [run-id]` | R | Status as six rungs, each naming its evidence |
| `agents [run-id]` | R | The orchestrator and each worker: model, effort, state, context, cost |
| `workers` / `tasks [run-id] [--all]` | R | Worker rows with derived liveness; task rows with lease, holder and checkpoint |
| `notices [run-id]` | R | Permission requests, dead or stalled workers, verdicts, pause and end |
| `transcript [run-id] [-f]` | R | A headless orchestrator's stream, readable |
| `logs <worker-id> [-f]` | R | A worker's raw stream |
| `receipts [run-id]` | R | Per-agent model, turns, tokens, cost, tool calls, wall clock, checks |
| `diff [run-id] [--since ts]` | R | Rows changed since a mark |
| `briefing <worker-id>` | R | The resume material a worker would get |
| `memory search <q> [--mode hybrid\|keyword\|semantic] [--index]` | R | Search shared memory; the result says which modes ran |
| `memory list` / `show` / `timeline` / `stats` | R | Filtered rows, full rows, what was written around a row, counts |
| `memory export [--out file] [--all]` | R | Write rows to a file, without vectors |
| `usage [run-id] [--by task\|worker\|model\|turn]` | R | Tokens and dollars per turn (needs the `cost_ledger` lever) |
| `mcp status [--deep]` | R | MCP server facts, one by one |
| `pending [--all]` | R | Tool calls waiting on a verdict |
| `init` | W | Write `belay.config.json` and create the data dir (never overwrites) |
| `run <spec.json> [--interactive] [--effort level]` | W | Start a run; the store owner for its lifetime |
| `embedder fetch\|verify` | W | Download or re-hash the embedding model |
| `settings [<key> [<value>]]` | W | Panel display settings |
| `memory verify <id> --status s --receipt r` | W | Mark a row verified or refuted, with its evidence |
| `memory import <file> --namespace-map from=to` | W | Import rows as unverified, into namespaces you name |
| `stop <run-id>` | C | Stop a live run and reap its workers |
| `pause` / `resume <worker-id\|run-id>` | C | Park a worker (or every worker in a run) and relaunch it on its session |
| `message <worker-id> <text>` | C | Send a turn to a worker |
| `worker kill\|rm\|stop\|restart <worker-id>` | C | Kill by exact pid, forget a dead worker, stop or restart it |
| `task assign <task-id> <worker-id>` | C | Assign an open task |
| `take-control <task-id>` | C | Move a task's lease to you and pause its worker |
| `approve` / `deny <request-id>` | C | Answer one pending tool call |

Every intervention returns proof: the row it wrote, the pid it acted on, the exit code, or a refusal that says why.

## Configuration

- **`belay.config.json`**, found by walking up from the current directory to the project root (never into your home directory). Keys: `data_dir` (default `.belay`), `claude_exe`, `codex_exe`, and the panel's `mod.*` display settings (`belay settings`).
- **The run spec** (`belay run <spec.json>`): `worktree` and `prompt_file` are required. Optional keys include `model` (default `claude-opus-5-5`), `mode`, `timeout_ms`, `max_fix_rounds` (default 2), `fix_cutoff`, `on_embedder_failure`, and a `memory` block of levers (see [Memory](#memory-that-lasts-across-sessions)). An unknown key is an error. Full list in [INSTALL.md](INSTALL.md#run-spec-keys).
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
- **No prompt helper.** You copy the shipped prompt template and add your brief by hand.
- **The orchestrator's restraint is a prompt rule.** Its launch has the same six tools as a worker; the template tells it not to edit.
- **Reviewer severity is a prompt rubric**, and reviewers have under-rated real defects.
- **Pause and compaction are Claude Code features.** A Codex worker can't be paused or parked yet, and the compaction lever applies to Claude Code workers only.
- **The panel depends on Claude Code's plugin engine**, measured on Claude Code 2.1.293.
- **One store owner**, single-threaded: about 1,200 operations a second.
- **Memory is mostly scaffolding.** Most memory features are off by default. Only delivery of a hand-written row has been shown to help. Redaction is pattern matching, and a worker's raw stream log is not redacted. Keyword search ignores query terms shorter than three characters and says so. Read commands copy the store, so they slow down on stores of tens of thousands of rows.

## Status and roadmap

belay is at 0.2.0. It already drives real multi-agent runs, and parts of belay itself were built by belay: a coder, a reviewer, fix rounds and a second reviewer, run unattended with a receipt for every agent.

**How 0.2.0 was built.** The memory work was built in about two days by many Claude Code agents working in parallel, each on its own branch, with a lead session planning and merging. Every wave of branches was checked by an independent reviewer agent and fixed before merging. belay itself drove part of the work: the redaction commits by `belay job` came from a belay run with its own reviewers. The commit history keeps those branches, merges and timestamps as they happened. The design decisions and experiments behind it were pre-registered and measured, and are summarised under [What we have measured](#what-we-have-measured).

Directions, with no dates and no promises:

- **macOS and Linux support** (planned).
- **Memory that lasts across sessions**: truthful hybrid search, row status, redaction and the data framing are built and on. Capture, summaries, project memory, the first-message index, compact resumes and a knowledge agent are built behind off-by-default levers. Next: show that belay captures and finds the right facts by itself, then decide which levers turn on by default. See [Where this is going](#where-this-is-going).
- **Multiple orchestrators** coordinating as peers over one store.
- **More worker substrates**, including open-source and local models through agent CLIs that run them.
- **Autonomy**: a work queue across runs, belay starting its own headless runs from it, and the spend and concurrency limits that needs.
- **Evals**: the next memory experiment (facts captured by belay, found in a large store), and a head-to-head comparison with native Claude Code agents.

Bugs, ideas and porting help: [GitHub Issues](https://github.com/aschwa1012/belay/issues).

## Contributing

Issues and pull requests are welcome. To run the tests, clone the repository and run `npm install`. You need Windows and Node >= 24.19.0.

- **`npm test`** runs the unit, conformance and budget suites against fake Claude Code and Codex executables, so it spends nothing. CI runs the same suite on a GitHub Windows runner for every pull request.
- One integration test launches a real Claude Code worker on your account and costs tokens. It is skipped unless you set `BELAY_REAL=1`.
- Some timing tests are sensitive to machine load; if one fails, rerun it alone before reporting it.

Keep files under 500 lines. Back any performance or behaviour claim with the command, its exit code and its timing.


## License

MIT. See [LICENSE](LICENSE).
