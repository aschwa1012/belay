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
| The embedding model | Effectively required: `belay run` refuses to start without it. A one-time ~252 MB download, which `belay init` offers; see below. |
| Codex CLI | Optional. Only needed if the orchestrator spawns Codex workers. Measured on 0.153.4. |

belay has no required npm dependencies. It has one optional dependency, `@huggingface/transformers` (pinned at 4.3.0), which runs the embedding model. npm installs optional dependencies by default; do not install with `--omit=optional`, or `belay run` will refuse to start.

## Install

Nothing is on the npm registry yet. Install from GitHub:

```powershell
npm install -g github:aschwa1012/belay
```

npm may print warnings about install scripts for `onnxruntime-node` and `protobufjs`. They come from the optional embedding library and are harmless.

To pin a tagged release, add the tag, for example `npm install -g github:aschwa1012/belay#v0.4.0`.

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

This downloads the `onnx-community/voyage-4-nano-ONNX` model (q4 weights, about 252 MB) from huggingface.co into `%LOCALAPPDATA%\belay\models`, and checks every file's size and sha256 against a table in belay's source. It is belay's only network access, and is needed once per machine. `belay init` offers the same download when the model is missing (see [First run](#1-prepare-the-project)). `belay embedder verify` re-hashes what is there.

Optional, for the retrieval profiles that rerank or use a GPU (the default profile needs none of this):

```powershell
belay embedder fetch --reranker Alibaba-NLP/gte-reranker-modernbert-base   # cpu-rerank
belay embedder fetch --gpu                                                 # the pinned GPU runtime (llama.cpp, Vulkan)
belay embedder fetch --gpu --model giladgd/Qwen3-Reranker-4B-GGUF          # gpu-rerank
```

Then set a profile with `belay settings memory.profile <name>` or the panel's Memory menu. A run checks free GPU memory before it loads anything, and takes `memory.profile_cpu` when no usable GPU is found.

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

`belay init` writes `belay.config.json` with `"data_dir": ".belay"` and a notes project name (`memory.project`), creates `.belay\`, and prints both. It never overwrites an existing config and refuses your home directory. Add `.belay/` to your `.gitignore`.

When the embedding model is missing, `belay init` asks in a terminal whether to download it now (Enter or `y` downloads; anything else, or closing the prompt, does not). Outside a terminal, or with `--json`, it downloads nothing and prints the command to run. `--fetch` downloads without asking and `--no-fetch` never asks. A failed download makes `belay init` exit 1; the config and data directory are still written.

Notes (experimental; see the README's Notes section) are on by default. The project name comes from the `origin` remote of the repository's git config, as `owner-repo`, read from the file on disk with no git process and no network. With no `origin`, it is the repository's folder name. Either is lower-cased, and characters a project name cannot hold become dashes; a folder name with no usable characters gives `project-` and a short hash of its path. A run in a folder whose config names no project derives the name the same way at each start, prints it with its source on stderr, and records it on the run, but writes no config. To rename the project, or turn notes off:

```powershell
belay settings memory.project my-app     # lowercase letters, digits, dot, underscore or dash
belay settings memory.notes false        # no notes, and no derived project
```

### 2. The orchestrator prompt

The orchestrator's instructions are a prompt file. belay ships two templates:

- `src\run\prompts\orchestrator-interactive.md`, for interactive runs. It carries the line `<!-- belay-mode: interactive -->`, and an interactive run refuses a prompt file without it.
- `src\run\prompts\orchestrator.md`, for headless runs. You append your brief to it.

Instead of copying a template you can name your brief with `brief_file` in the spec: belay then wraps it in its own current template for the run's mode, under a `## Your brief` heading, so an upgrade refreshes the prompt. A spec names exactly one of `prompt_file` and `brief_file`.

To copy the interactive one next to your spec:

```powershell
Copy-Item "$(npm root -g)\@aschwa1012\belay\src\run\prompts\orchestrator-interactive.md" .\prompt.md
```

The templates explain the orchestrator's role (plan, delegate, check; leave the code work to workers), task plans, task worktrees and `integrate`, how to create tasks with acceptance commands, owned files and note search lines, the review protocol and what counts as a blocking finding. Placeholders such as `{{max_fix_rounds}}` and the run's plan are filled in by belay from the spec. You can add project-specific guidance at the end. The templates carry `<!-- belay-prompt 0.4.0 -->`.

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
- belay passes no first prompt. Type your brief, for example: "Add a `--verbose` flag to the CLI in `src/cli.js`. Acceptance: `node test/cli.test.js` exits 0."

While it runs:

- The **band** above the prompt shows the run, the agent count, the cost, and the newest notice or the orchestrator's latest line.
- **`/orch`** toggles the side panel: each agent's state mark, model, task, context size, prompt-cache countdown and cost (the orchestrator's cost is an estimate from Claude Code's session transcript, shown as ≈$; `/clear` starts a new transcript that is not followed), and the run's notices.
- Under the run's plan (see [Task plans](#task-plans)), belay spawns, reviews, fixes and merges the tasks itself, and wakes the orchestrator in the same session for an exception, the fix-round limit, a worker's escalation, and once when everything is done. For a task with no plan, belay wakes it when a worker ends a turn or dies.
- From a second terminal in the project: `belay agents`, `belay notices`, `belay status`, `belay pause <worker-id>`, `belay message <worker-id> "<text>"`, `belay take-control <task-id>`.

The run ends when you quit the Claude Code session. If you close the console window, belay runs a fast close of about 3.5 s. Afterwards, `belay receipts <run-id>` gives the per-agent breakdown.

### A headless run

Copy `orchestrator.md` instead, append your brief to the file, and leave `mode` out (or set it to `headless`). `belay run belay-spec.json` then launches the orchestrator as `claude -p`, hands it the prompt, and wakes it as the plan or its workers need it. The run ends when the orchestrator ends a turn with no worker mid-turn and no plan step due or in progress, when `timeout_ms` passes, or on `belay stop <run-id>`. Under a plan, belay also wakes a headless orchestrator once at 80% of `timeout_ms`. Follow it with `belay transcript -f`, `belay agents` and `belay notices`.

### Run spec keys

An unknown key is a usage error.

| Key | Default | Meaning |
|---|---|---|
| `worktree` | required | The orchestrator's working directory. |
| `prompt_file` | one of these two | The orchestrator's prompt, your own copy of a template. |
| `brief_file` | one of these two | Your brief; belay wraps it in its current template for the run's mode. |
| `run_id` | random UUID | The run id. |
| `model` | `claude-opus-5-5` | The orchestrator's model. |
| `allowed_tools` | none | Tools pre-approved for the orchestrator (`--allowedTools`). |
| `orchestrator_dir` | `%TEMP%\belay-run\<run-id>` | The orchestrator's launch files, logs and `run.json`. Must not be inside the data directory. |
| `startup_timeout_ms` | 60000 | Wait for the orchestrator's ready event. |
| `timeout_ms` | 0 (none) | Run time bound. Headless only; refused in interactive mode. |
| `mcp_tool_timeout_ms` | 120000 | The orchestrator's MCP tool timeout. At most 120000 in interactive mode. |
| `poll_ms` | 1000 | Wake and status poll interval. |
| `close_grace_ms` | 10000 | Grace period when the run closes. |
| `max_fix_rounds` | 2 | Fix rounds per task. Under a plan, at the limit belay stops the task's steps and wakes the orchestrator; a fix task the orchestrator makes itself past it carries a notice. Not a refusal. |
| `fix_hard_cap` | 5 with no `timeout_ms`, else none | The only fix-round refusal: fix tasks per piece of work. `null` means no cap. |
| `fix_cutoff` | `orchestrator` | `orchestrator` (may stop early under named conditions) or `cap-only`. |
| `on_embedder_failure` | `required` | `required` (a failed embedder pauses the run), `keyword` (go on ranking by keywords only) or `off` (memory off for the run). The 0.2.0 values `stop` and `continue` are still accepted, as `required` and `keyword`. A run paused this way resumes with `belay resume <run-id> --embedder keyword\|off`, or plain `belay resume <run-id>` once the embedder is fixed. `--embedder` also writes the choice to the config file as `memory.on_embedder_failure`, so later runs inherit it. Also settable in the `memory` block or as a config default. |
| `compact_at_tokens` | none | Optional compaction threshold for Claude Code workers. |
| `max_parallel_evaluations` | unlimited | How many task checks run at once; the rest wait for a slot. |
| `policy` | belay's default plan | The plan every work task takes unless it states its own (see [Task plans](#task-plans)). Merged field by field over `run.policy` in the config file and belay's default. `null` runs with no plan. Checked at launch: a bad plan is refused before any process starts. |
| `max_parallel_builds` | 4 | How many of a plan's builds are in flight at once; the rest wait. |
| `stop_idle_on_done` | false | Stop a worker once its task is done and it is idle. |
| `permission_prompt` | false | Turn on the permission channel: workers' tool approvals become rows, and the orchestrator is shown `permission_list` and `permission_decide`. |
| `max_follow_ups` | 1 | Follow-up tasks a held review may spawn for its should-fix findings. Not fix rounds. |
| `merge_into` | `ask` | `ask` or `allowed`: whether integrate may move one of your own branches without your approval. |
| `cross_run_merge` | false | Let integrate merge work another run made. |
| `budget_usd` | none | The run's spend limit in dollars; reaching it pauses the run. Also `run.budget_usd` in the config file; `null` turns that default off for one run. |
| `budget_counts_in_flight` | false | Count a turn still running, as an estimate, against `budget_usd`. |
| `keep_review_scratch` | false | Keep reviewers' per-run scratch folders after the run. |
| `mode` | `headless` | `headless` or `interactive` (`--interactive` wins). |
| `interactive_surface_ms` | 15000 | How long the interactive launch check waits. |
| `fullscreen` | true | Interactive only: Claude Code's fullscreen mode. |
| `memory` | none | Optional block of memory levers, over the config file's `memory` defaults. All are off except `redact`, `notes` (on, with `project` derived when unset) and the first-message note index (on with notes). See the README sections on memory and notes. An unknown key, a bad value or a removed lever (`note_review` true, `note_review_model`, `note_review_cost_cap_usd`) is a usage error. So is `project_writes` with notes on. `"memory": null` uses no memory levers and inherits none from the config. |

Two further keys, `native_memory` and `handback_question`, exist for belay's own evaluations and are not supported. `native_memory` takes an absolute folder path (not `true`) and turns Claude Code's own auto memory back on for workers, which belay otherwise switches off.

`belay run` also takes `--effort low|medium|high|xhigh|max` for the orchestrator.

Workers' tools come from their type: coders, testers and reviewers get Read, Edit, Write, Glob, Grep and Bash; researchers get Read, Glob, Grep, WebFetch and WebSearch, with no shell. `agents.<type>.tools` in the config file changes a type's list, and a spawn may narrow it, never widen it.

Workers' models and efforts come from the orchestrator's spawn call, then from the config file's `agents` block (`belay settings agents.reviewer.model claude-opus-5-5`, `agents.coder.effort`, `agents.<type>.codex_model` for Codex workers), then from built-in defaults: Sonnet 5.5 for coders and testers, Opus 5.5 at effort high for reviewers and researchers.

A worker the orchestrator spawns without naming an id gets a readable one, its agent type and the lowest free number in the data directory (`coder-1`, `reviewer-2`). Workers a plan spawns are named `bld-` or `rev-` and eight hex digits.

### Task plans

A plan names the steps belay takes for a task, so the orchestrator is not woken for each one. The orchestrator passes it as `policy` on `task_create`; a run's default plan comes from the spec's `policy`, then `run.policy` in `belay.config.json`, then belay's own.

| Field | What belay does |
|---|---|
| `build: { spawn: { agent_type: "coder" } }` or `build: { worker: "<id>" }` | Once the task is open and every task it depends on is done (and merged, if the plan merges it), spawns a coder in the task's worktree or gives the task to that worker. A plan's builder may be a Codex worker (`spawn: { agent_type: "coder", substrate: "codex" }`). |
| `review: { spawn: { agent_type: "reviewer" } }` or `review: { worker: "<id>" }` | When the work is done, makes its review task and spawns a reviewer or gives it to that worker. Reviewers are always Claude Code. |
| `fix: "builder"` | A refuted review, a merge conflict, or a hand-back that failed or could not be evaluated goes back to the worker that built it, as a fix round. |
| `re_review: "refuter"` | A finished fix goes back to the reviewer that refuted it. |
| `integrate: "on_hold"` | Once the review holds and the task's dependencies are done, merges the work and its fixes into `belay/integrate/<run>`. |
| `follow_up: "plan"` | A hold with should-fix findings becomes a follow-up task in its own tree, which the plan builds, reviews and merges (up to `max_follow_ups`). |

belay's default plan is every row above with a spawned coder and reviewer:

```json
{ "build": { "spawn": { "agent_type": "coder" } }, "review": { "spawn": { "agent_type": "reviewer" } },
  "fix": "builder", "re_review": "refuter", "integrate": "on_hold", "follow_up": "plan" }
```

- **Field by field.** A task's own plan wins over the run's, and the spec's over the config's, one field at a time. A field set to `null` keeps that step for the orchestrator; `policy: null` on a task hands the whole task back. A partial plan on a task the orchestrator makes by hand replaces only the fields it names, so leaving out `re_review` or `integrate` there means no re-review or merge for it.
- **Wakes.** The orchestrator is woken at the fix-round limit, when a worker escalates in its hand-back, when a step fails or is left to it, when a builder or reviewer the plan gave a task dies and the one restart belay makes does not bring it back, on a budget pause, and once when every task is done, reviewed and merged and the merged head's checks pass. Each wake carries a digest of the steps belay took since the last one. A check that failed and then passed on a retry is only noted in the digest.
- **Workers.** A coder or reviewer a plan spawned is stopped once its work is merged or cancelled. A worker you kill with `belay worker kill` is never restarted by the plan.
- **Codex builders.** belay commits a Codex worker's changes at hand-back, in the task's own worktree, with the repository's git identity and its hooks. A hand-back that adds a new file with a secret-looking name (`.env`, `*.pem`, `*.key`, `id_rsa` and the like) is not committed, and the refusal names the paths; a hook that fails is a fix round, and any other commit failure wakes the orchestrator. A fix round that needs a merge or rebase goes to a Claude Code coder in the same tree.
- **Seeing it.** `belay status` shows each task's plan and the steps belay took, with each turn's cost; `belay receipts` shows the steps too.

**Note search lines.** With notes on, `task_create` also takes `memory_queries`: up to four short lines (160 bytes each) naming the files, commands or behaviour the task touches. A worker spawned or relaunched for the task gets, in its first message, up to 3 notes (1,600 bytes) that are close to one of those lines (`memory.index_min_relevance`, 0.45) or to the whole task text (`index_min_relevance_spec`, 0.60; `index_spec_only_floor`, 0.55, when the task has no lines). Review, fix and follow-up tasks inherit the lines. A `worker_spawn` can pass its own `memory_queries`, which win for that spawn. A task handed to a worker that is already running gets no index. The thresholds were set on the default embedder; with another, or with keyword search only, no note passes them.

## Optional: watch a run from a second window

The panel can watch any run, headless or interactive, from a separate Claude Code session. Load belay's plugin from the install (PowerShell syntax):

```powershell
claude --plugin-dir "$(npm root -g)\@aschwa1012\belay\src\mod"
```

Start it from the project folder, so belay finds the store. Then, inside that session:

- `/belay watch` watches the newest run; `/belay watch <run-id>` a specific one.
- `/orch` toggles the panel.
- `/belay unwatch` stops watching.

The panel reads through one short belay process per refresh (every 5 s with the pane open, 10 s for the band alone, 60 s once the run has ended; a button press or opening the pane refreshes at once) and never writes the store or submits anything to the model, with two exceptions, both asked for by a button: the review button on its memory line, which takes two presses, starts `belay memory review` for the held notes; and the settle buttons on a note that awaits you, which ask for a reason, then a confirm, and only the confirm runs `belay memory held settle`. An interactive run needs none of this; it loads its own copy of the plugin.

## Updating

Run the install again:

```powershell
npm install -g github:aschwa1012/belay
```

The embedding model stays in its cache and does not need fetching again unless a release changes it (`belay doctor` will say so). Stop any live run before updating.

**From 0.3.3 to 0.4.0: back up `.belay\` first, copy the prompt template again, and decide whether you want the default plan and notes.**

- The store moves to schema version 3 on the first 0.4.0 run: it adds two tables and columns in place. 0.3.3 refuses a version 3 store (`E_SCHEMA_NEWER`), so to go back, restore your backup.
- Every run takes belay's default plan (see [Task plans](#task-plans)): belay builds, reviews, fixes and merges each work task, and the orchestrator is no longer woken by each hand-back. Set `"policy": null` in the spec to keep 0.3.3's flow, or set your own default in the spec's `policy` or the config's `run.policy`.
- Under a plan, a merge conflict and a hand-back that failed or could not be evaluated go back to the builder as fix rounds and count against `max_fix_rounds`.
- Notes are on by default. A run whose config and spec name no `memory.project` derives one from the `origin` remote or the folder (see [Prepare the project](#1-prepare-the-project)) and prints it. `belay settings memory.notes false`, or `"memory": null` in a spec, turns notes off. With notes on, the run-close scrub (Haiku 5.5, capped at $0.10 and 300 s) runs at every close with new notes to compare.
- The note index in each worker's first message is on with notes, and every notes worker is told how to search notes. `memory.first_message_index false` leaves the index out.
- `memory.alpha`, the semantic weight of hybrid search, is 0.5 (it was 0.3), so search results can come in a different order. A run recorded before keeps its own value.
- Turn records (each worker turn's last text) are no longer written. Set `memory.turn_rows true` to keep them; a restart reads a worker's last turns from its stream instead.
- A restart (`worker_restart`, `belay worker restart`) resumes the worker's session whatever its age; 0.3.3 started a fresh one after 55 minutes (25 for Codex). If the resume does not come up, belay starts a fresh session once.
- belay commits a Codex worker's changes when it hands back, with your repository's git identity and hooks.
- `belay init` writes `memory.project` into a new config and, in a terminal, asks whether to download the embedding model. Scripts should pass `--no-fetch` or `--fetch`.
- A worker spawned without a named id gets a readable one (`coder-1`) instead of a UUID.
- A Claude Code worker's `git stash` commands that write are refused, and each worker's `TEMP`, `TMP` and `TMPDIR` point at a folder of its own.
- Copy the orchestrator prompt template again, or switch to `brief_file`; the templates carry `<!-- belay-prompt 0.4.0 -->`. They describe plans and tell the orchestrator to wait for wakes, with `worker_wait` only a short check (its default timeout is now 5 s).

**From 0.3.2 to 0.3.3: copy the prompt template again, and check what your workers need from your environment.**

- Workers and the orchestrator get an allowlisted environment. Credentials and billing variables (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL` and the like) are no longer passed; the Claude Code sign-in token (`CLAUDE_CODE_OAUTH_TOKEN`) is kept on purpose. Name any other variable a build needs in `BELAY_ENV_ALLOW` (comma-separated, for example `JAVA_HOME,VIRTUAL_ENV`); credential and billing names there are refused, and so is every launch while the list names one. A launch not signed in through your subscription is refused.
- Workers no longer get `SSH_AUTH_SOCK`; the orchestrator keeps it.
- A Codex worker that signed in through `OPENAI_API_KEY` no longer can, and `BELAY_ENV_ALLOW` cannot pass it; sign Codex in with `codex login`.
- A Claude Code worker's `git push`, and `gh` commands that write to GitHub, are refused, and so are its writes to the drive's `/tmp`. Codex workers are not covered.
- A merge into one of your own branches asks for approval by default (`merge_into`). A run no longer merges another run's work unless its spec sets `cross_run_merge`.
- Copy the orchestrator prompt template again, or switch to `brief_file`; the templates carry `<!-- belay-prompt 0.3.3 -->`.
- `belay status` exits 1 for a run id that names no run. A committed `data_dir` outside the repository is refused.
- Scripts may need a change: `--fix` is refused by every command but `belay doctor`, and the `worktree` verbs refuse an option they do not take.
- The store keeps schema version 2.

**From 0.3.1 to 0.3.2: back up `.belay\` first.**

- No default changes: with no retrieval setting a run searches as 0.3.1 did.
- The first start fills a vector cache from the stored vectors, inside the store owner's start: about 25 ms for a few hundred notes, about 1 s at 10,000 rows, several seconds beyond. It runs again after a 0.3.1 belay writes to the same store. A command that connects during a start of more than about 5 s can fail with `E_NO_OWNER`; run it again.
- The panel's Memory menu writes retrieval settings to the config file.
- The store keeps schema version 2; the first 0.3.2 start adds a table and two columns in place. Going back to 0.3.1 on the same store is not tested.

**From 0.3.0 to 0.3.1: back up `.belay\` first, and copy the prompt template again.**

- The store keeps schema version 2; the first 0.3.1 run adds a table and columns in place. Going back to 0.3.0 on the same store is not tested, so keep the backup if you might.
- `max_fix_rounds` is now a notice, not a limit: past it, a fix task carries a notice to the orchestrator. The only refusal is `fix_hard_cap`, 5 by default for a run with no `timeout_ms` and none for a run with one. Set `"fix_hard_cap": 2` to keep 0.3.0's limit.
- The orchestrator can merge into any branch it names, your checked-out branch included, with no approval step. Keep its work on the integration branch and merge that yourself.
- Copy the orchestrator prompt template again, or switch to `brief_file`. Both templates changed and carry `<!-- belay-prompt 0.3.1 -->`; `belay run` warns when your copy is older.
- Researcher workers have no shell; they get Read, Glob, Grep, WebFetch and WebSearch.
- Shell commands that stop processes by name (`taskkill /IM`, `Stop-Process -Name`, `pkill` and the like) are refused for workers and a headless orchestrator. A headless orchestrator's `belay` commands are refused as the operator.
- Workers are no longer shown `lease_renew`, `checkpoint_write`, `status` or `memory_stats`. The orchestrator is shown `permission_list` and `permission_decide` only when the spec sets `"permission_prompt": true`.
- A review task is refused to a worker that held a lease on the work it reviews. A message to a worker is refused as busy while that worker is being stopped, restarted or resumed.
- The orchestrator's task tools, `worker_spawn` and `memory_search` answer in compact views by default.
- `belay run` removes each finished, clean task worktree when the run ends, and reports the ones it kept.

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
- `%LOCALAPPDATA%\belay\models` (the ~252 MB model);
- `%TEMP%\belay-run\` (orchestrator folders and run receipts);
- `%TEMP%\belay\`, where workers' temp folders are left only for a worker still running or a run that crashed.

## Troubleshooting

**Claude Code not found, or a `.cmd` cannot be spawned.** Set `BELAY_CLAUDE_EXE` to the real `claude.exe` (see [Finding Claude Code](#finding-claude-code)), then run `belay doctor` again.

**Claude Code version below the floor.** belay needs 2.1.280 or later. Update Claude Code, then check that `BELAY_CLAUDE_EXE` (if set) points at the updated executable.

**The interactive run ends straight away at the trust prompt.** Claude Code asked whether to trust the folder and the answer was no. Start the run again and answer yes.

**"an interactive run needs an interactive prompt".** The prompt file lacks the line `<!-- belay-mode: interactive -->`. Start from `orchestrator-interactive.md`.

**The interactive launch fails its surface check.** Something other than what belay asked for got into the session: another plugin, skill, MCP server or instruction file, a different model or permission mode, or an old Claude Code. The error names what it saw.

**`belay run` refuses to start because the embedder cannot load.** Run `belay embedder fetch`, then `belay doctor`. To run without it, `belay settings memory.on_embedder_failure keyword` ranks notes by keywords only (new notes get no vector until `belay memory embed` runs), and `off` turns notes off for the run; the refusal says the same. If doctor says `@huggingface/transformers` is not installed in belay's `node_modules`, or is the wrong version (belay pins 4.3.0 and refuses any other), reinstall belay without `--omit=optional`. On a heavily loaded machine the first load can be slow; try again when it is quieter.

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
| Worker temp folders | `%TEMP%\belay\<run-id>\<worker-id>\`, the worker's `TEMP`, `TMP` and `TMPDIR`, removed when the run ends. If your temp folder is in your home folder outside `AppData`, `%LOCALAPPDATA%\Temp` is used instead. |
| Orchestrator files and run receipt | `%TEMP%\belay-run\<run-id>\`, including `run.json`, unless the spec sets `orchestrator_dir`. |
| Embedding model | `%LOCALAPPDATA%\belay\models`, or the folder named by `BELAY_MODEL_CACHE`. |

belay runs no background service and leaves no process running after a run ends. Its only network access is the model download (`belay embedder fetch`, or `belay init` when you accept it).
