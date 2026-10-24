# Installing belay

> **Windows only.** belay is built and tested on Windows 10/11 only. **It will not work on macOS or Linux as it stands**: off Windows, its identity-checked kills are refused and worker processes can be left running. macOS and Linux support is planned, with no date. Everything below assumes Windows.

## Requirements

| Requirement | Notes |
|---|---|
| Windows 10 or 11 | The only tested platform. |
| Node.js >= 24.19.0 | belay uses Node's built-in `node:sqlite`. An older Node fails when a command first opens the store. |
| Claude Code >= 2.1.280 | Checked at every launch from the session's own report; a lower version fails the launch. The interactive mode and the panel were measured on 2.1.293. |
| git | Needed by the npm install from GitHub and by task checks ("only owned files changed" diffs against a base). |
| PowerShell (`powershell.exe` on PATH) | Every process snapshot, and so every identity-checked kill, goes through it. Present on every Windows 10/11 install. |
| The embedding model | Effectively required: `belay run` refuses to start without it. A one-time ~253 MB download, see below. |
| Codex CLI | Optional. Only needed if the orchestrator spawns Codex workers. Measured on 0.153.4. |

belay has no required npm dependencies. It has one optional dependency, `@huggingface/transformers` (pinned at 4.3.0), which runs the embedding model. npm installs optional dependencies by default; do not install with `--omit=optional`, or `belay run` will refuse to start.

## Install

Nothing is on the npm registry yet. Install from GitHub:

```powershell
npm install -g github:aschwa1012/belay
```

npm may print warnings about install scripts for `onnxruntime-node` and `protobufjs`. They come from the optional embedding library and are harmless.

To pin a tagged release, add the tag, for example `npm install -g github:aschwa1012/belay#v0.3.0`.

This installs the package `@aschwa1012/belay` and puts the `belay` command on your PATH. The installed files live under:

```powershell
npm root -g     # usually $env:APPDATA\npm\node_modules
# belay itself:  <that folder>\@aschwa1012\belay
```

## Verify

```powershell
belay --help
belay doctor
```

`belay --help` prints the command list and loads nothing else. `belay doctor` checks the config, the store, the Claude Code and Codex binaries and the embedder, and prints one line per check with its evidence. It is read-only; `belay doctor --fix` can only create a missing data directory.

At this point doctor will report the embedder model as missing, and, outside a project, the config and store as absent. That is expected.

`belay doctor` also reports whether the store has its keyword index. It is built the first time a 0.2.0 or later run (or `belay memory verify`) opens an existing store. Until then the check says `absent`, and a keyword search says the index is missing.

### Finding Claude Code

belay launches Claude Code itself, as a real executable. Node cannot spawn the npm `claude.cmd` shim without a shell, so belay never runs the shim. It looks, in this order:

1. **`BELAY_CLAUDE_EXE`**, an environment variable naming the executable. This is the override and always wins.
2. **`claude_exe`** in `belay.config.json`.
3. **`claude` on PATH.** Either a real `claude.exe` on PATH, or the npm `claude` shim, which belay follows to the package's own executable.

Codex is found the same way: `BELAY_CODEX_EXE`, then `codex_exe` in the config, then `codex` on PATH.

`belay doctor` shows the path it found for each one and where that path came from: found on PATH, from `BELAY_CLAUDE_EXE` or `BELAY_CODEX_EXE`, or configured in a named config file.

If doctor cannot find Claude Code, set the variable to the real executable. For an npm install of Claude Code it is usually:

```powershell
$env:BELAY_CLAUDE_EXE = "$(npm root -g)\@anthropic-ai\claude-code\bin\claude.exe"
```

To make it permanent, run `setx BELAY_CLAUDE_EXE "<path>"`, then open a new terminal. Codex has the same override, `BELAY_CODEX_EXE`.

## Fetch the embedding model

```powershell
belay embedder fetch
```

This downloads the `onnx-community/voyage-4-nano-ONNX` model (q4 weights, about 253 MB) from huggingface.co into `%LOCALAPPDATA%\belay\models`, and checks every file's size and sha256 against a table in belay's source. It is belay's only network access, and is needed once per machine. `belay embedder verify` re-hashes what is there.

Why it is required: belay's workers and orchestrator share a memory store with semantic search. A run warms the embedder before it spawns anything and refuses to start if it cannot load, so memory never degrades silently. Read commands work without it.

Keyword search, memory listing, `memory show` and `memory stats` also work without the embedder. A search without it runs keyword only and says so. Semantic-only search and `belay run` still need it.

## First run

### 1. Prepare the project

Use a git repository you are happy for agents to change, ideally a scratch clone or a separate worktree.

```powershell
cd C:\path\to\your-project
belay init
belay doctor
```

`belay init` writes `belay.config.json` (containing only `"data_dir": ".belay"`) and creates `.belay\`. It never overwrites an existing config and refuses your home directory. Add `.belay/` to your `.gitignore`.

With no memory project named, `belay doctor` (and `belay run`, `status`, `settings` and the panel) says that memory notes are off for this project. To turn notes on (experimental; see the README's Notes section), name a project; to turn them off and silence the notice, set `memory.notes` to `false`:

```powershell
belay settings memory.project my-app     # lowercase letters, digits, dot, underscore or dash
belay settings memory.notes false        # or: no notes, no notice
```

### 2. The orchestrator prompt

The orchestrator's instructions are a prompt file. belay ships two templates:

- `src\run\prompts\orchestrator-interactive.md`, for interactive runs. It carries the line `<!-- belay-mode: interactive -->`, and an interactive run refuses a prompt file without it.
- `src\run\prompts\orchestrator.md`, for headless runs. You append your brief to it.

Copy the interactive one next to your spec:

```powershell
Copy-Item "$(npm root -g)\@aschwa1012\belay\src\run\prompts\orchestrator-interactive.md" .\prompt.md
```

The templates explain the orchestrator's role (plan, delegate, check; never edit itself), how to create tasks with acceptance commands and owned files, the review protocol and what counts as a blocking finding. Placeholders such as `{{max_fix_rounds}}` are filled in by belay from the spec. You can add project-specific guidance at the end.

### 3. The spec

Create `belay-spec.json`:

```json
{
  "worktree": ".",
  "prompt_file": "./prompt.md",
  "mode": "interactive"
}
```

Relative paths resolve against the spec file's own folder. `"mode": "interactive"` is the same as passing `--interactive`.

### 4. Start it

```powershell
belay run belay-spec.json --interactive
```

- belay validates the spec, becomes the store owner for the run, and warms the embedder.
- Claude Code opens in your console as the orchestrator, with belay as its only MCP server and the run's prompt appended to its system prompt.
- **If Claude Code asks whether to trust the folder, answer yes.** Declining ends the run.
- belay checks the session's surface: the Claude Code version, the model, the permission mode, and that no other instruction file, skill, plugin or MCP server got in. Anything else fails the launch.
- belay passes no first prompt. Type your brief, for example: "Add a `--verbose` flag to the CLI in `src/cli.js`. Acceptance: `node test/cli.test.js` exits 0. One coder, then one reviewer."

While it runs:

- The **band** above the prompt shows the run, the agent count, the cost, and the newest notice or the orchestrator's latest line.
- **`/orch`** toggles the side panel: each agent's state mark, model, task, context size, prompt-cache countdown and cost (the orchestrator's cost is an estimate from Claude Code's session transcript, shown as ≈$; `/clear` starts a new transcript that is not followed), and the run's notices.
- When a worker ends a turn or dies, belay wakes the orchestrator in the same session.
- From a second terminal in the project: `belay agents`, `belay notices`, `belay status`, `belay pause <worker-id>`, `belay message <worker-id> "<text>"`, `belay take-control <task-id>`.

The run ends when you quit the Claude Code session. If you close the console window, belay runs a fast close of about 3.5 s. Afterwards, `belay receipts <run-id>` gives the per-agent breakdown.

### A headless run

Copy `orchestrator.md` instead, append your brief to the file, and leave `mode` out (or set it to `headless`). `belay run belay-spec.json` then launches the orchestrator as `claude -p`, hands it the prompt, and wakes it as workers finish. The run ends when the orchestrator ends a turn with no worker mid-turn, when `timeout_ms` passes, or on `belay stop <run-id>`. Follow it with `belay transcript -f`, `belay agents` and `belay notices`.

### Run spec keys

An unknown key is a usage error.

| Key | Default | Meaning |
|---|---|---|
| `worktree` | required | The orchestrator's working directory. |
| `prompt_file` | required | The orchestrator's prompt. |
| `run_id` | random UUID | The run id. |
| `model` | `claude-opus-5-5` | The orchestrator's model. |
| `allowed_tools` | none | Tools pre-approved for the orchestrator (`--allowedTools`). |
| `orchestrator_dir` | `%TEMP%\belay-run\<run-id>` | The orchestrator's launch files, logs and `run.json`. Must not be inside the data directory. |
| `startup_timeout_ms` | 60000 | Wait for the orchestrator's ready event. |
| `timeout_ms` | 0 (none) | Run time bound. Headless only; refused in interactive mode. |
| `mcp_tool_timeout_ms` | 120000 | The orchestrator's MCP tool timeout. At most 120000 in interactive mode. |
| `poll_ms` | 1000 | Wake and status poll interval. |
| `close_grace_ms` | 10000 | Grace period when the run closes. |
| `max_fix_rounds` | 2 | Fix rounds per task after a refuted review. |
| `fix_cutoff` | `orchestrator` | `orchestrator` (may stop early under named conditions) or `cap-only`. |
| `on_embedder_failure` | `required` | `required` (a failed embedder pauses the run), `keyword` (go on ranking by keywords only) or `off` (memory off for the run). The 0.2.0 values `stop` and `continue` are still accepted, as `required` and `keyword`. A run paused this way resumes with `belay resume <run-id> --embedder keyword\|off`, or plain `belay resume <run-id>` once the embedder is fixed. `--embedder` also writes the choice to the config file as `memory.on_embedder_failure`, so later runs inherit it. Also settable in the `memory` block or as a config default. |
| `compact_at_tokens` | none | Optional compaction threshold for Claude Code workers. |
| `mode` | `headless` | `headless` or `interactive` (`--interactive` wins). |
| `interactive_surface_ms` | 15000 | How long the interactive launch check waits. |
| `fullscreen` | true | Interactive only: Claude Code's fullscreen mode. |
| `memory` | none | Optional block of memory levers, over the config file's `memory` defaults. All are off except `redact`, and `notes`, which is on once `project` is named. See the README sections on memory and notes. An unknown key, a bad value or a removed lever (`note_review` true, `note_review_model`, `note_review_cost_cap_usd`) is a usage error. So is `project_writes` with notes on. `"memory": null` uses no memory levers and inherits none from the config. |

Two further keys, `native_memory` and `handback_question`, exist for belay's own evaluations and are not supported. `native_memory` takes an absolute folder path (not `true`) and turns Claude Code's own auto memory back on for workers, which belay otherwise switches off.

`belay run` also takes `--effort low|medium|high|xhigh|max` for the orchestrator.

Workers' models and efforts come from the orchestrator's spawn call, then from the config file's `agents` block (`belay settings agents.reviewer.model claude-opus-5-5`, `agents.coder.effort`, `agents.<type>.codex_model` for Codex workers), then from built-in defaults: Sonnet 5.5 for coders and testers, Opus 5.5 at effort high for reviewers and researchers.

## Optional: watch a run from a second window

The panel can watch any run, headless or interactive, from a separate Claude Code session. Load belay's plugin from the install (PowerShell syntax):

```powershell
claude --plugin-dir "$(npm root -g)\@aschwa1012\belay\src\mod"
```

Start it from the project folder, so belay finds the store. Then, inside that session:

- `/belay watch` watches the newest run; `/belay watch <run-id>` a specific one.
- `/orch` toggles the panel.
- `/belay unwatch` stops watching.

The panel runs belay's own read commands every few seconds and never writes the store or submits anything to the model, with two exceptions, both asked for by a button: the review button on its memory line, which takes two presses, starts `belay memory review` for the held notes; and the settle buttons on a note that awaits you, which ask for a reason, then a confirm, and only the confirm runs `belay memory held settle`. An interactive run needs none of this; it loads its own copy of the plugin.

## Updating

Run the install again:

```powershell
npm install -g github:aschwa1012/belay
```

The embedding model stays in its cache and does not need fetching again unless a release changes it (`belay doctor` will say so). Stop any live run before updating.

**From 0.2.0 to 0.3.0: back up `.belay\` first, and check your memory settings.**

- The store keeps schema version 2; the first 0.3.0 run adds columns in place. Going back to 0.2.0 on the same store is not tested, so keep the backup if you might.
- If your config or run spec already sets `memory.project`, notes are now on for those runs: workers are asked for notes, and a run with notes to check ends with a Haiku scrub capped at $0.10 and 300 s. Add `"notes": false` to the memory block to keep 0.2.0's behaviour.
- With notes on, project memory works only as notes. A `memory_store` into the project by a worker or the orchestrator is written as a note and must carry a note's fields; the orchestrator's run outcomes go to `summary/<project>`. Rows already in the project that are not notes are no longer shown to workers or the orchestrator; `belay memory` commands still show them.
- `project_writes` together with notes is refused, so a 0.2.0 config that sets `project_writes` and a project fails until it also sets `"notes": false`.
- A note reported wrong is now left out of workers' reads until it is settled (`memory.held_visibility`, default `withhold`); set it to `warn` to keep it visible with its warning.
- With no project set, a notice says memory notes are off; `belay settings memory.notes false` silences it.
- `on_embedder_failure` takes `required`, `keyword` or `off`; the 0.2.0 values `stop` and `continue` are still accepted, as `required` and `keyword` (in the run spec, the memory block, the config file and `belay settings`). A failed embedder pauses the run, as 0.2.0's default `stop` did; what is new is that a worker's search inside the run fails instead of falling back to keyword search. `belay resume <run-id> --embedder keyword|off` writes its choice to the config file.
- Commands that need the operator's authority take about 1 s longer, once per connection.
- Keyword search matches any of the query's terms (0.2.0 required every term) and ranks by relevance; hybrid search and the index also drop common English stopwords and terms found in half the rows or more. The same query can return more rows, in a different order.
- belay's write commands are refused when run inside a worker's environment, so a script a worker runs can no longer call, for example, `belay memory verify`.
- Every write to a run that has ended is refused.
- Copy the orchestrator prompt template again (`orchestrator-interactive.md` or `orchestrator.md`). Both changed: workers are now spawned with an `agent_type`, and the prompts cover notes. An old copy still runs, but its workers get no per-type defaults. From 0.3.0 the templates carry a `<!-- belay-prompt 0.3.0 -->` line, and `belay run` warns (on stderr, and in `prompt_warnings` in the run receipt) when your copy has no such line, an older one, or, with notes on, lacks a placeholder the notes need; the run still starts.

**From 0.1.0 to 0.2.0: back up `.belay\` before the first 0.2.0 run.** That run upgrades an existing store to a new format (schema version 2): it adds columns and a keyword index. After the upgrade, **belay 0.1.0 can no longer open the store**; it refuses with a message to upgrade belay rather than risk writing rows the new version would misread. To go back to 0.1.0, restore your backup.

## Uninstalling

```powershell
npm uninstall -g @aschwa1012/belay
```

This leaves your data in place. Remove it by hand if you want it gone:

- each project's `.belay\` folder and `belay.config.json`;
- `%LOCALAPPDATA%\belay\models` (the ~253 MB model);
- `%TEMP%\belay-run\` (orchestrator folders and run receipts).

## Troubleshooting

**Claude Code not found, or a `.cmd` cannot be spawned.** Set `BELAY_CLAUDE_EXE` to the real `claude.exe` (see [Finding Claude Code](#finding-claude-code)), then run `belay doctor` again.

**Claude Code version below the floor.** belay needs 2.1.280 or later. Update Claude Code, then check that `BELAY_CLAUDE_EXE` (if set) points at the updated executable.

**The interactive run ends straight away at the trust prompt.** Claude Code asked whether to trust the folder and the answer was no. Start the run again and answer yes.

**"an interactive run needs an interactive prompt".** The prompt file lacks the line `<!-- belay-mode: interactive -->`. Start from `orchestrator-interactive.md`.

**The interactive launch fails its surface check.** Something other than what belay asked for got into the session: another plugin, skill, MCP server or instruction file, a different model or permission mode, or an old Claude Code. The error names what it saw.

**`belay run` refuses to start because the embedder cannot load.** Run `belay embedder fetch`, then `belay doctor`. If doctor says `@huggingface/transformers` is not installed in belay's `node_modules`, or is the wrong version (belay pins 4.3.0 and refuses any other), reinstall belay without `--omit=optional`. On a heavily loaded machine the first load can be slow; try again when it is quieter.

**A run is still alive after you expected it to end.** Find it with `belay status` or `belay agents`, then stop it:

```powershell
belay stop <run-id>
```

This closes the orchestrator, kills it and its workers by exact pid, and reports each one. If belay refuses a kill because it cannot prove the process's identity, it tells you the pid; end that process yourself in Task Manager or with `Stop-Process -Id <pid>`.

**A control command exits 1 when no run is alive.** Control commands act on a live run, so with no run alive they exit 1 and say why:

- `stop`, `take-control`, `task assign`, `approve` and `deny` print `no live run: no owner.lock exists at …`.
- `pause`, `resume`, `message` and `worker stop|kill|restart` report that there is no such worker, or no such data directory. When the worker's run has ended, they say `run … ended at …`, and `worker kill` says the row is stopped and there is `nothing to kill`.
- With no data directory at all, `stop` says the data dir does not exist instead of the `owner.lock` message.

The error code (`E_NO_OWNER`) appears only with `--json`. Read commands still work when no run is alive. `belay status` shows whether a run and its owner are alive.

**Acceptance commands fail with npm or npx.** Task checks run with no shell, so `npm` and `npx` (both `.cmd` files on Windows) cannot be named directly. Use `node <script>` in `acceptance.commands`.

## Where belay stores data

| What | Where |
|---|---|
| Config | `belay.config.json` at the project root (found by walking up from the current directory, never into your home directory). |
| The store | `<project>\.belay\memory.db` with its SQLite sidecars, plus `owner.lock\` while an owner is alive. It also holds the keyword index and, when levers are on, per-turn usage and memory action records. `belay memory export` writes rows to a file you choose. |
| Per-worker files | `<project>\.belay\workers\<worker-id>\`: the launch config, the raw `stream.jsonl`, `stderr.txt`, the adapter log and the resume document. |
| Orchestrator files and run receipt | `%TEMP%\belay-run\<run-id>\`, including `run.json`, unless the spec sets `orchestrator_dir`. |
| Embedding model | `%LOCALAPPDATA%\belay\models`, or the folder named by `BELAY_MODEL_CACHE`. |

belay runs no background service and leaves no process running after a run ends. Its only network access is `belay embedder fetch`.
