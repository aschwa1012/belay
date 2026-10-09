# belay

> **Windows only.** belay is built and tested on Windows 10/11 only. **As it stands, it will not work on macOS or Linux**: the way it proves which process to kill, its pipes and its console handling rely on Windows mechanisms. macOS and Linux support is planned, with no date.

belay is a local orchestration harness for AI coding agents. It runs Claude Code and codex sessions as worker processes on one machine, keeps every task, lease, checkpoint, review verdict and per-agent cost in one SQLite store, and lets one human watch and step in. The planner is a Claude session, headless or your own interactive one, that drives the workers through belay's MCP tools. The name is the climbing sense: belay does not do the climbing. It holds the rope, keeps the record and catches the fall.

**belay 0.1.0 is scaffolding.** What exists today is the foundation for four things it is being built toward: memory that lasts across sessions, several orchestrators coordinating one body of work, workers that can be any model, including open-source and local ones, and autonomy: taking a queue of work and starting its own runs to work through it. None of the four is finished. [Where this is going](#where-this-is-going) says what each one stands on today and what is planned.

Status: **0.1.0, early**, built and used by one developer. Interfaces, spec keys and the store layout may change.

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
- **Shared memory.** A semantic memory store that every agent in a run can read and write. The store lives in the data directory and persists across runs, and the orchestrator can store and search a `project` namespace that outlives a run. Planned, not built: deliberately curating and consolidating what carries across sessions, and sizing what each agent is given.
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

**Built today:**

- **One store.** belay's SQLite store is the only memory its agents have. Each worker's own Claude Code auto memory is switched off at launch.
- **Semantic search** over that store.
- **Namespaces.** By default, entries go into a namespace for their run. A `project` namespace outlives the run, and the shipped orchestrator prompt tells the orchestrator to search it before planning and store its decisions there.
- **Provenance.** Every row records who first wrote it and who last wrote it, and it can name what it came from. Each worker turn's text is also written to memory automatically, tagged with its task and worker, and names the checkpoint it came from.

**Planned:**

- **Layered search:** an index, then a timeline, then the full rows, so an agent pulls only what it needs.
- **Hybrid search**, keyword and semantic together. Every result will say which modes ran, so "found nothing" is never faked.
- **Verification state:** every memory row marked unverified, verified or refuted, with the evidence.
- **Mechanical observation:** observations captured from the worker's own event stream, with no hooks and no model call per tool call.
- **Task summaries.**
- **A bounded index** of relevant project memory in each worker's first message.
- **Compact resumes** built from the worker's history.
- **A knowledge agent** that other agents can ask.
- **Redaction** of secrets when an entry is written.

Memory's value will be measured before anything relies on it.

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
| `memory search <q>` / `memory stats` | R | Shared memory |
| `mcp status [--deep]` | R | MCP server facts, one by one |
| `pending [--all]` | R | Tool calls waiting on a verdict |
| `init` | W | Write `belay.config.json` and create the data dir (never overwrites) |
| `run <spec.json> [--interactive] [--effort level]` | W | Start a run; the store owner for its lifetime |
| `embedder fetch\|verify` | W | Download or re-hash the embedding model |
| `settings [<key> [<value>]]` | W | Panel display settings |
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
- **The run spec** (`belay run <spec.json>`): `worktree` and `prompt_file` are required. Optional keys include `model` (default `claude-opus-5-5`), `mode`, `timeout_ms`, `max_fix_rounds` (default 2), `fix_cutoff`, `on_embedder_failure`. An unknown key is an error. Full list in [INSTALL.md](INSTALL.md#run-spec-keys).
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

## Status and roadmap

belay is at 0.1.0. It already drives real multi-agent runs, and parts of belay itself were built by belay: a coder, a reviewer, fix rounds and a second reviewer, run unattended with a receipt for every agent.

Directions, with no dates and no promises:

- **macOS and Linux support** (planned).
- **Memory that lasts across sessions**: layered and hybrid search, verified, unverified and refuted rows, mechanical observation, a bounded first-message index, compact resumes, a knowledge agent, and redaction. See [Where this is going](#where-this-is-going).
- **Multiple orchestrators** coordinating as peers over one store.
- **More worker substrates**, including open-source and local models through agent CLIs that run them.
- **Autonomy**: a work queue across runs, belay starting its own headless runs from it, and the spend and concurrency limits that needs.
- **Evals**: measuring memory's value before relying on it, and a head-to-head comparison with native Claude Code agents.

Bugs, ideas and porting help: [GitHub Issues](https://github.com/aschwa1012/belay/issues).

## Contributing

Issues and pull requests are welcome. To run the tests, clone the repository and run `npm install`. You need Windows and Node >= 24.19.0.

- **`npm test`** runs the unit, conformance and budget suites against fake Claude Code and Codex executables, so it spends nothing.
- One integration test launches a real Claude Code worker on your account and costs tokens. It is skipped unless you set `BELAY_REAL=1`.
- Some timing tests are sensitive to machine load; if one fails, rerun it alone before reporting it.

Keep files under 500 lines. Back any performance or behaviour claim with the command, its exit code and its timing.


## License

MIT. See [LICENSE](LICENSE).
