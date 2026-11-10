# Changelog

## 0.4.0

Plan-first runs: the orchestrator sets a plan for each task, and belay
builds, reviews, fixes, re-reviews and merges the work on its own, waking
the orchestrator only at the fix-round limit, an escalation, an exception
and once when the work is done. Notes are on by default under a derived
project name, and a worker's first message lists the notes closest to its
task. A restart resumes the worker's session, and belay commits a Codex
worker's changes at hand-back.

Upgrade warning (from 0.3.3)
- every run now takes belay's default plan: each work task is built by a
  spawned coder, reviewed by a spawned reviewer, fixed by its builder,
  re-checked by the reviewer that refuted it and merged into
  belay/integrate/<run> once its review holds. The orchestrator is no
  longer woken by each hand-back. Set "policy": null in a run spec to keep
  0.3.3's flow, or set your own default as policy in the spec or
  run.policy in belay.config.json
- under a plan, a merge conflict and a failed or unjudged evaluation go
  back to the builder as fix rounds and count against max_fix_rounds; at
  the limit belay stops the task's steps and wakes the orchestrator
- notes are on by default. A run with no memory.project takes its project
  name from the origin remote (owner-repo), else the folder name, prints
  it and records it on the run. Turn notes off with belay settings
  memory.notes false, or "memory": null in a spec
- with notes on, the run-close scrub (Haiku 5.5, capped at $0.10 and
  300 s) runs at every close that has new notes to compare
- the note index in each worker's first message is on with notes (up to 3
  notes, 1,600 bytes), and every notes worker's first message carries a
  short guide to reading notes; set memory.first_message_index false to
  leave the index out
- the semantic weight of hybrid search (memory.alpha) is 0.5, up from
  0.3, so search results order differently. Runs recorded before keep
  their own value
- turn records (each worker turn's last text) are no longer written; set
  memory.turn_rows true to keep them. A restart reads a worker's last
  turns from its own stream instead
- worker_restart and belay worker restart resume the worker's session
  whatever its age; 0.3.3 started a fresh session after 55 minutes (25 for
  Codex)
- belay commits a Codex worker's changes in its task's worktree when it
  hands back, with your repository's git identity, and runs your hooks
- belay init writes memory.project into a new belay.config.json and, in a
  terminal, asks whether to download the embedding model. Scripts should
  pass --no-fetch (or --fetch)
- a worker spawned without a named id gets a readable one, such as
  coder-1 or reviewer-2, instead of a uuid; workers a plan spawns are
  named bld-... and rev-...
- a Claude Code worker's writing git stash command is refused, and each
  worker's TEMP, TMP and TMPDIR point at a temp folder of its own
- the store moves to schema version 3 on the first 0.4.0 run, in place.
  0.3.3 refuses a version 3 store: back up .belay\ before upgrading if you
  may go back
- copy the orchestrator prompt template again, or use brief_file; the
  templates now carry <!-- belay-prompt 0.4.0 -->, describe plans, and
  tell the orchestrator to wait for wakes, with worker_wait only a short
  check (it now defaults to 5 s)

Added
- task plans: task_create takes a policy naming the steps belay takes for
  the task (build, review, fix, re_review, integrate, follow_up). A task's
  own plan wins over the run's field by field; a field set to null keeps
  that step for the orchestrator, and policy: null hands the task back
- the done wake: once every task is done, every planned task reviewed and
  merged, and the merged head's checks passed, the orchestrator is woken
  once with the branch and head. Exception wakes and the done wake carry
  a digest of the steps belay took since the last wake
- a worker can escalate in its hand-back (result.escalate), which wakes
  the orchestrator and holds the task's planned steps
- a headless run under a plan wakes the orchestrator once at 80% of its
  time bound
- max_parallel_builds in the run spec (default 4) caps a plan's builds in
  flight; workers a plan spawned are stopped once their work is merged
- a builder or reviewer the plan gave a task that dies unexpectedly is
  restarted once; the orchestrator is woken only if that did not work. A
  worker you kill with belay worker kill is never restarted
- memory_queries on task_create: up to four short search lines per task,
  which the note index matches notes against. Review, fix and follow-up
  tasks inherit them. A note is listed when it is close to a line or very
  close to the whole task text; the thresholds are levers
  (index_min_relevance, index_min_relevance_spec, index_spec_only_floor,
  index_max_notes)
- a conflict forecast: when a hand-back passes, belay checks whether its
  branch would conflict with the integration branch and says so in the
  wake
- belay status shows each task's plan and belay's steps with each turn's
  cost; belay receipts shows the steps too, and both show checks that
  failed and then passed on one tree
- belay agents shows each worker's start and exit times
- a model switch Claude Code makes on its own is recorded on the worker's
  or headless orchestrator's row and shown in status, agents and receipts
- belay init --fetch and --no-fetch; a run refused for a missing
  embedding model says how to run without it
- the run receipt lists new files in the drive-root tmp folder

Changed
- the orchestrator prompts teach plans and notes only; they no longer
  teach the older memory tools
- the panel reads through one belay process per refresh: every 5 s with
  the pane open, 10 s for the band alone and 60 s once the run has ended,
  instead of 20 to 35 processes a minute
- the panel has a new look: a header card, accent headings and colour on
  state only
- wakes held back while an interactive session cannot take them (for
  example while the session switcher is open) are kept in order and sent
  later, and the status line says they are held; a halting exception or a
  death under a plan is delivered at least once, with a ref that names a
  repeat
- a restart's cost is counted from the session total Claude Code saved at
  the worker's last graceful exit, so a resumed session is not counted
  twice
- a fix round that needs a merge or rebase for a Codex builder goes to a
  Claude Code coder in the same tree; reviewers stay Claude Code
- a Codex hand-back belay could not commit because of a hook is a fix
  round; any other commit failure wakes the orchestrator once. A
  hand-back that adds a new file with a secret-looking name is not
  committed, and the refusal names the paths
- running out of time while ranking the note index never pauses a run or
  refuses a spawn; the worker is told the notes could not be ranked
- a dependent task's tree is cut from the integration branch once its
  dependencies are merged
- worker temp folders are removed when the run ends, kept for workers
  still running, and swept for crashed runs
- the tmp guard also covers redirects, wrappers, scripts that name the
  drive-root tmp, and the PowerShell tool

Fixed
- a restart whose resume fails before the worker is ready falls back to
  a fresh session once, with one process at a time and no dead row
  between the two attempts, and reports the failed launch's exit code and
  first error line; a resume that died before it was ready is not counted
  as a turn
- orchestrator output read after a run settled is appended to the run's
  own stream files, never to a closed file handle
- a cancelled worker_wait is not answered and claims nothing
- the nvidia-smi probe has its own timer, so a wedged GPU driver cannot
  hang it
- the reranker fetch hint is given only when an ONNX reranker's model
  file is missing or wrong

Measured
- on the last two release candidates, ten headless runs of the same
  7-ticket build of a small command-line product were started under the
  shipped plan. Five are counted; three that showed defects since fixed (a
  false stall wake, and a note index that listed nothing) and two stopped
  before they finished are not. The five cost about $7 to $10 each. In
  two the orchestrator's only wake was the done digest; in three it was
  also woken at the fix-round limit by a merge conflict that kept
  recurring. A pilot, not a benchmark
- in two of the counted runs, on the release code, every one of the 40 spawned
  workers got 1 to 3 notes listed, about 60% of them on-task by one
  reader's judgement; reviewers opened listed notes, builders did not
- the restart cost rule was measured on Claude Code 2.1.321: a graceful
  exit saves the session total and a kill saves nothing
- the full unit, conformance and budget suite and the plugin suite passed
  on the final release candidate, whose code differs from this release
  only in its version strings
- not measured: whether plans or the note index give better results than
  0.3.3's flow or than native Claude Code agents

Known limits
- the note index is built when a worker is spawned or relaunched. A task
  handed to a running worker, such as a fix round sent back to its
  builder, gets no index
- the index thresholds were set on one project with the default embedder.
  With another embedder, or keyword search only, no note passes them and
  the index lists nothing
- the hybrid search weight of 0.5 rests on relevance labels made by a
  model and not yet checked by hand; it is provisional
- the restart cost rule depends on what Claude Code saves at exit, measured
  on 2.1.321; a later version that saves it differently could make a
  resumed worker's cost wrong
- a Codex restart whose thread the server has expired, and that fails
  only after it started, gets no fresh fallback
- a plan the orchestrator gives a task replaces the run's plan field by
  field, so a partial plan on a hand-made fix can leave out the review
  and merge steps
- a model switch in an interactive orchestrator is not recorded
- Codex workers cannot be paused or parked, and the push, stash and tmp
  guards do not cover them
- Windows only

## 0.3.3

Spending limits, merges into your own branches with your approval, and a
tighter boundary around workers: a smaller environment and, for Claude
Code workers, no pushes and no writes to the drive's /tmp. Many fixes to
waits, wakes, stops and process checks found in trial runs and a review of
the code. New limits are off or ask first by default.

Upgrade warning (from 0.3.2)
- workers and the orchestrator now get an allowlisted environment instead
  of everything in your shell. Credentials and billing variables
  (GH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, ANTHROPIC_BASE_URL and the
  like) are no longer passed; the Claude Code sign-in token
  (CLAUDE_CODE_OAUTH_TOKEN) is kept on purpose. Name extra variables in
  BELAY_ENV_ALLOW (comma-separated, for example JAVA_HOME,VIRTUAL_ENV);
  credential and billing names there are refused, and so is every launch
  while the list names one. A launch whose Claude Code session is not
  signed in through your subscription is refused
- workers no longer get the SSH agent socket (SSH_AUTH_SOCK); the
  orchestrator keeps it
- a Codex worker that signed in through OPENAI_API_KEY no longer can, and
  BELAY_ENV_ALLOW cannot pass it; sign Codex in with codex login
- a Claude Code worker's shell command that pushes (git push, and gh
  commands that write to GitHub) is refused, and so is its write to the
  drive's /tmp (C:\tmp), which a native program reads as the drive root
  rather than the session's temp folder. Codex workers are not covered
- a merge into one of your own branches (any branch that is not belay's)
  asks for approval by default (merge_into, below), and a run no longer
  merges another run's work unless its spec sets cross_run_merge
- copy the orchestrator prompt template again, or use brief_file; the
  templates now carry <!-- belay-prompt 0.3.3 -->
- the orchestrator's tool listing is larger (up to 20 KB): its tools
  describe budgets, follow-ups and user-branch merges
- belay status exits 1 for a run id that names no run, and workers,
  tasks, diff and usage refuse an unknown run id
- a committed data_dir that points outside the repository is refused;
  belay config, init and doctor say so
- scripts may need a change: --fix is refused by every command but belay
  doctor, and the worktree verbs refuse an option they do not take

Added
- budget_usd for a run (in the spec, or run.budget_usd in the config),
  off by default: when spend reaches it, belay pauses the run and wakes
  the orchestrator, and status shows the budget beside the spend. Tasks
  can carry a budget too. A turn still running is shown as a labelled
  estimate, and budget_counts_in_flight counts it against the budget.
  Codex workers' cost is treated as unknown, not free
- merge_into in the run spec ("ask" by default, or "allowed"): integrate
  can merge into a branch of yours on a detached head, and moves it only
  after approval and passing checks. A headless run is approved through
  belay pending, approve and deny; an interactive run records that you
  approved in chat. Conflicts stop and leave the tree clean; belay never
  forces or pushes
- cross_run_merge in the run spec (off): without it, integrate refuses
  work another run made, and the refusal names each task and why
- task_create can make a task's worktree in the same call and take a
  batch of tasks; a batch is all or nothing and removes any tree it made
  when a row is refused
- follow-ups: a held review can spawn a follow-up task for its should-fix
  findings, with its own tree, capped by max_follow_ups (default 1); it
  is not a fix round and never gates the work it follows
- review wakes carry the verdict, the counts and the finding titles, and
  reviewers are asked for a severity and a title per finding
- belay worktree prune: removes the task trees of runs whose run process
  is gone, as a preview unless --yes; it lists the refs that keep a
  removed tree's head (refs/belay/kept/), --yes --drop-pins drops those
  one of your branches already reaches, and --run limits it to one run
- every worker is told the tools it has, and what narrowed them when
  that is known
- the run receipt records which belay build wrote each run epoch and the
  run process's own build, and a check's environment is recorded with it
- notices list retrieval failures (search stages that failed, a corrupt
  model file, a stop cut off at run end) and say when the search log was
  off; receipts show the retrieval tier a run used, and each embedder
  re-load at a resume
- Codex workers: a prompt too long for the command line is sent on stdin,
  and belay sets only what it must on a launch (execpolicy rules off, the
  belay server required, effort only when the spawn names one, a fixed
  list of features off) and leaves your model, provider and sandbox to
  your Codex config; the receipt records what it left

Changed
- a fix chain's rounds are counted on the original work, and refusals,
  fix_from_review and every wake name that work
- a task branch is treated as belay's only when a judged commit is on it
- an integrate step that stopped is never reported as passed
- memory search shows notes held for review after the ranked hits, and
  says when a page or the index budget cut them
- belay memory search applies the same default scope as workers' search
  and says which scope it used; turn records are left out of heavy
  reranking only where the default search cannot reach them
- a spec, config or memory import file saved with a UTF-8 byte order mark
  is read; belay settings keeps the config text as it was on disk
- belay embedder fetch and delete accept the names the Memory menu shows;
  embedder errors name the GPU model table
- the panel's profile toast names the key it wrote and whether a live
  run keeps its own profile; its download entry says what to run
- an operator-check refusal carries its reason to the command that was
  refused, and belay usage says why it is empty when the run's ledger was
  off
- an orchestrator lists and decides only its own run's permission
  requests, and another run's tasks, workers and trees are refused
- a reviewer's instructions are copied from a commit no worker wrote
- an orchestrator's memory writes reach only its own run's namespace and
  its project; a run with no project cannot write project notes or
  summaries
- belay status and diff run no repository program (fsmonitor, filters,
  external diff)
- belay memory stats refuses a run id, which it never used

Fixed
- a worker whose pid was seen dead is not revived by a reused pid, the
  run close tells a reused pid from a survivor by creation time, and a
  worker ended by the orchestrator's tree kill is attributed correctly
- belay stop no longer reports a worker killed when the kill was refused
  or left the process alive
- a broken orchestrator stdin pipe no longer crashes the run process, and
  a wake whose write failed is not marked delivered
- a pause that lands between a spawn and its launch discards the unstarted
  worker; spawn and restart are refused in a paused run
- the budget guard stays armed across a pause from another cause and
  re-checks when a resume settles; a lost usage write is not counted twice
- a write that meets a stopping store owner waits for the next owner, and
  pipe names follow the data directory's real path
- a dead embedder child is reported as an embedder failure on every later
  call, so on_embedder_failure applies
- the spawn register is judged by creation time and boot, and check
  commands and git calls in a worker's tree are recorded in it, so they
  cannot act as the operator
- a resumed or adopted Codex reviewer keeps its scratch folder writable
- stdio pipes of a finished worker are released, so a descendant that
  inherited them cannot hold the run open
- pipe and socket lines are decoded as UTF-8 across chunk boundaries
- a permission request left pending by a cancel expires
- belay wake-stream and embedder delete find the store as other commands
  do
- a hard reset during a run no longer locks every belay control command
  out: spawn-register writes are flushed to disk before they are swapped
  in, and an unreadable register file is judged by its pid and when it
  was written (moved to corrupt/ by the next operator write once its
  process is gone, still refusing while it may be alive); belay doctor
  names it
- a store owner no longer stalls as the machine-wide spawn register
  grows: its operator check reads each closed entry once instead of on
  every check, and the owner prunes closed entries (and entries a reboot
  left open), so a check no longer holds it past the ping that proves it
  is alive

Measured
- a settings check of 30 rows drove every retrieval setting, and the new
  run settings, through belay run with a stand-in for Claude Code; the
  defects it found were fixed before this release
- the acceptance rows on real Claude Code (worker launch and stop, run
  close, pause and resume, the worker guards, and a reranking smoke run)
  all passed on this line before its final fixes, and were not run again
  after them
- not measured: the new limits in a long parallel run

Known limits
- a headless orchestrator works in one long turn, so budget_usd counts
  its cost only when that turn ends, normally at run end (or as an
  estimate with budget_counts_in_flight); belay usage never shows it, and
  an interactive orchestrator's cost is not counted
- budget_usd is an estimate: Claude Code reports a worker's cost at the
  end of a turn, so a long turn can overrun it
- the push and /tmp guards match command text: a command built at run
  time, or a script written and then run, can escape them. They are
  Claude Code hooks, so a Codex worker has neither
- Codex workers still load $CODEX_HOME/AGENTS.md, and Codex adds a trust
  entry for each worktree to your config.toml
- from Git Bash, belay's control commands (stop, pause, approve and the
  like) can be refused by the operator check, because Git Bash starts them
  through a helper whose parent Windows cannot see; run them from
  PowerShell or cmd (the error now says so). 0.3.2 behaves the same
- avoid the left arrow key in an interactive orchestrator session: it can
  open Claude Code's session switcher, and wakes belay sends while the
  session is switched away can be marked delivered without reaching the
  orchestrator
- the panel starts a short belay process for each of its reads, about 20
  to 35 a minute while a session is open, and still copies the store
  about 25 times a minute after the run has ended; on Windows each launch
  leaves kernel file objects behind, so a long open session adds to
  kernel memory. End the Claude Code session once its run is over to
  stop it
- if the process that refreshes a spawn record is killed while the
  spawned process keeps running, that process's later children can pass
  the operator check once 60 s have gone by (as in 0.3.2)
- Windows only

## 0.3.2

Retrieval profiles: memory search can rerank its candidates with a cross-encoder
on the CPU, or embed and rerank on a GPU, chosen per run and per agent type.
The default is unchanged: cpu-fast, the same search as 0.3.1.

Upgrade warning (from 0.3.1)
- no default changes: with no retrieval setting, a run searches exactly as
  0.3.1 did (voyage-4-nano, keyword and semantic fused, no reranker)
- the first start after the upgrade fills a vector cache from the vectors
  already stored, inside the store owner's start: about 25 ms for a few
  hundred notes, about 1 s at 10,000 rows, several seconds beyond that. It
  runs again after a 0.3.1 belay writes to the same store. A command that
  connects during a start of more than about 5 s can fail with E_NO_OWNER;
  run it again
- the panel can now write settings: the Memory menu saves profile, routing
  and model choices to the config file (as belay settings does)
- the store keeps schema version 2; the first 0.3.2 start adds a table and
  two columns in place. Going back to 0.3.1 on the same store is not
  tested: back up .belay\ first

Added
- retrieval profiles (memory.profile): cpu-fast (the default, no reranker),
  cpu-rerank-light and cpu-rerank (a CPU cross-encoder reranks the top 50
  candidates), gpu-rerank-fast and gpu-rerank (a GPU reranker),
  gpu-balanced and gpu-recall-max (a GPU embedder and a GPU reranker), and
  custom (memory.embedder and memory.reranker). memory.profile_cpu is the
  profile a run takes when no usable GPU is found
- per-agent-type routing (memory.routing, memory.routing_cpu): reviewers,
  coders or the orchestrator can search with different models
- the GPU models run on llama.cpp with Vulkan, an opt-in install into
  belay's cache: belay embedder fetch --gpu installs the pinned runtime,
  belay embedder fetch --gpu --model <id> a GPU model, and
  belay embedder fetch --reranker <id> a CPU reranker. Nothing GPU-related
  is installed or loaded unless a profile asks for it. belay embedder
  delete removes a model nothing in the project uses
- the routing is pinned once at run start and recorded on the run. A GPU
  routing is checked against free VRAM (memory.vram_headroom_gb, default
  0.75) before anything loads
- loud fallback (memory.on_heavy_failure): fallback (the default) moves the
  run to the CPU profile and says so in one notice; pause turns the
  failure into an error instead (at run start, the run does not start). A search caught by an owner stopping is answered once
  from the fallback tier, labelled
- memory.on_heavy_behind: when a GPU embedder has notes left to embed at
  run start, wait (the default) embeds them first (belay memory embed
  --model <id> does the same by hand); fallback runs on voyage-4-nano for
  that run and keeps the reranker
- the reranker warms up at run start. While it loads, a search returns the
  fused order marked as warming instead of waiting. Each warm-up is
  recorded and shown in belay status, the run receipt and belay agents; it
  never wakes the orchestrator. A reranker whose process is gone is warmed
  again, and a failed warm-up is retried once
- the panel shows one line per retrieval model with its state, and the
  Memory menu (Profiles, Routing and Models tabs) to change them. belay
  memory menu offers the same from the command line
- long notices and menu text wrap to the pane instead of being cut off
- the search log (memory.search_log, off by default): records each search's
  query, candidates and reranked order for evaluating retrieval, capped at
  memory.search_log_cap_mb (500 MB, oldest runs pruned first). It keeps
  query text in the store, which is why it is off. belay memory search-log
  --export writes it out
- a vector cache keyed by model, revision, dimensions and text template,
  so a note embedded once by a model is not embedded again

Fixed
- a worker process seen dead stays dead for the rest of the run, so a process id the system reuses cannot make it look alive again; the wake
  carries the same fact, an orphan whose id may have been reused is checked once in the background, and a starting worker whose
  process is gone is not restated
- after a restart or a crash during a run, belay could mistake the
  system's own processes for ones its workers spawned, and then refuse
  every operator command that needs the operator check (memory search,
  notices and others) from any terminal, with a generic error. A spawn
  record from before the current boot is now ignored, every recorded
  lifetime ends at most 60 s after its process was last seen alive, the
  headless orchestrator's record is refreshed while it runs, and a run
  closes only the records of its own workers. Records left by an earlier
  belay close at their write time plus 60 s on the first start

Measured
- three real runs on 2026-10-30, one per device mix: a CPU reranker, a GPU
  embedder with a CPU reranker, and a GPU embedder with a GPU reranker.
  In each, every search had its candidates reranked by the expected model,
  and GPU memory stayed within the estimate (2,622 and 5,372 MiB against
  estimates of 2,629 and 5,411 MiB)
- not measured: whether reranking or a GPU embedder gives better results
  than cpu-fast. The default stays cpu-fast until that is measured

Known limits
- the GPU models of a run share one child process; if it fails, every GPU
  role falls back together
- on an 8 GB card the larger GPU profiles leave little room: other
  programs using the GPU can make the start-of-run check refuse, and the
  run then takes its CPU profile
- the warming state (a search served while the reranker loads) has been
  seen only in tests, not in a real run
- GPU retrieval is tested on one NVIDIA laptop GPU with Vulkan
- Windows only
- the panel's Models menu does not download: its download entry shows the
  command to run in a terminal, and for a GPU model it leaves out the
  runtime step (run belay embedder fetch --gpu first). Clearer wording
  comes in 0.3.3
- choosing a profile in the panel saves it for the next run; a live run
  keeps the profile it started with, and a run spec that sets
  memory.profile overrides the config. The panel does not yet say so
- belay memory menu lists rerankers by short name, but belay embedder
  fetch --reranker takes the full id (for example
  Alibaba-NLP/gte-reranker-modernbert-base), and belay embedder delete
  takes the model id alone, without --gpu or --model
- a spec or config file saved with a byte order mark (Windows PowerShell's
  Set-Content -Encoding utf8 writes one) is refused as invalid JSON; save
  it as UTF-8 without a BOM
- a rare race when an orchestrator exits at the moment belay writes to it
  can end the run with a broken-pipe error; fixed in 0.3.3
- if the process that refreshes a spawn record is killed while the spawned
  process keeps running, that process's later children can pass the
  operator check once 60 s have gone by

## 0.3.1

Parallel work: belay now gives each task its own git worktree and branch,
merges finished work into an integration branch and checks the merged
result, so one run can work on many tasks at once.

Upgrade warning (from 0.3.0)
- fix rounds are no longer capped by max_fix_rounds. Past it, a new fix
  task carries a notice to the orchestrator instead of being refused. The
  only refusal is the new fix_hard_cap: 5 by default for a run with no
  timeout_ms, none for a run with one. Set "fix_hard_cap": 2 in the run
  spec to keep 0.3.0's limit
- the orchestrator can merge into any branch it names, your checked-out
  branch included, with no approval step. Keep work on the integration
  branch and merge it into your own branches yourself (see Known limits)
- copy the orchestrator prompt template again, or switch the spec to
  brief_file (below). Both templates changed (worktrees, integrate, fix
  rounds, reuse of workers); they now carry <!-- belay-prompt 0.3.1 -->,
  and belay run warns when your copy is older
- researcher workers get Read, Glob, Grep, WebFetch and WebSearch, and no
  shell. Coders, testers and reviewers keep the six tools. Change a type's
  list with agents.<type>.tools in the config file
- shell commands that stop processes by name (taskkill /IM, Stop-Process
  -Name, pkill and the like) are refused for workers and for a headless
  orchestrator; stop a process by its exact pid
- a headless orchestrator has a shell, but belay commands it runs are
  refused as the operator; the interactive orchestrator acts as you
- workers are no longer shown lease_renew, checkpoint_write, status or
  memory_stats (no worker called them; the adapter renews leases itself).
  permission_list and permission_decide are shown to the orchestrator only
  when the run spec sets "permission_prompt": true
- a review task is refused to a worker that held a lease on the work it
  reviews
- a message to a worker is refused as busy while that worker is being
  stopped, restarted or resumed
- the orchestrator's task tools and worker_spawn answer with compact rows
  by default (view: "debug" gives the full row); memory_search answers in a
  compact view with one relevance figure, and flags results below a
  measured relevance floor
- belay run removes each finished, clean task worktree when the run ends,
  and reports the ones it kept
- the store keeps schema version 2; the first 0.3.1 run adds a table and
  columns in place. Going back to 0.3.0 on the same store is not tested:
  back up .belay\ first

Added
- a worktree and branch per task: the orchestrator's task_worktree makes,
  removes and reports one from a recorded base, and spawns, checks and
  reviews default to the task's own tree. Tasks in separate worktrees may
  own the same files; belay reports the overlap. From the command line:
  belay worktree create|remove|merge and belay worktrees
- integrate: merges each finished task into an integration branch at the
  commit that was judged, never past it, checks the merged head, and
  reports conflicts, what landed and what was left out. It can run extra
  checks of its own on the merged head (integrate checks), and can force a
  merge past failing checks with a stated reason, which is recorded
- run lever max_parallel_evaluations: caps how many task checks run at
  once; the rest wait for a slot
- belay checks a worker's hand-back as its turn ends and puts the result
  in the orchestrator's wake; fix_from_review makes the fix task for a
  refuted review; task_cancel; worker_last_reply; git_read, read-only git
  that belay runs for the orchestrator
- brief_file in the run spec: belay wraps your brief in its own current
  template, so an upgrade refreshes the prompt
- cost estimates: a worker killed in the middle of a turn has that turn's
  cost estimated from its stream, labelled as an estimate and kept apart
  from the cost Claude Code reported; belay agents and belay receipts show
  both
- check history: each task's check commands and how they changed between
  rounds, in the integrate answer and the run-end summary
- fix-round notice: past max_fix_rounds, the fix task's answer, the
  refuted review's wake and task_list carry the round count
- the orchestrator's shell: Read, Glob, Grep, Edit, Write and Bash, plus
  git_read. At the close belay ends what the orchestrator's shell left
  running, by exact pid, never belay's own processes or workers
- tool lists per worker type (agents.<type>.tools); a spawn may narrow its
  type's list, never widen it
- reviewers write their probes to a scratch folder per run, outside every
  worktree, and a change to the tree under review is flagged at the
  hand-back; keep_review_scratch keeps the folders after the run
- stop_idle_on_done stops a worker once its task is done and it is idle

Fixed
- a hand-back missing a field the task requires is refused, naming the
  missing fields, and the worker is told the required fields up front
- a worker killed mid-turn no longer shows that turn as free (see cost
  estimates)
- a check that finds every evaluation slot taken now waits for one instead
  of being refused
- task worktrees were left behind at the end of a run: clean ones are now
  removed, and before the close a headless orchestrator is told once which
  trees would be kept as dirty or off their branch
- a shell command that stops processes by name could reach any process on
  the machine, belay's own store owner included: such commands are refused
- a reused process id could be read as a live worker, run, merge or store
  owner: belay now checks the process creation time it recorded
- a store owner that is stopping finishes the calls it accepted and sends
  their replies, and turns new ones away so the client re-runs them
- a read copy taken while the owner writes is retried for a time budget;
  a torn copy is detected and taken again instead of giving a wrong answer;
  and a copy no longer stops an owner from writing (an owner elected during
  a copy could open the store read-only)
- a git trace file left in the temp folder by a belay process that died
  mid-merge is swept by a later belay process: only belay's own file
  names, only for a process that is gone, and only after 10 minutes
- a task branch named as another spelling of an existing branch (Main for
  main) is refused; on Windows it could move your branch
- many smaller fixes to waits, wakes, restarts, leases and messages, found
  in trial runs. belay's own tests that failed only under load were fixed,
  not excluded

Measured
- the same 10 tickets of a small command-line product, run in parallel by
  0.3.1 twice: about 1 h each (59 and 64 min) against about 5 h done one
  ticket at a time on a 0.3.0-era build, at about 35 to 45% lower cost
  ($18.68 and $16.20 against $28.31). Both runs met the pre-registered
  quality bar: hidden regression tests passed at 0.914 and 0.919 against
  the sequential run's 0.928 (the bar allowed 0.05 less), and 5 of 9
  scored tickets passed all their own tests, as in the sequential run

Known limits
- four 0.3.1 fixes are covered by tests but not yet exercised in a live
  run: the fix-round notice, the refusal of a hand-back missing required
  fields, the kill-by-name guard and the pre-close tree notice
- belay does not sandbox workers. A worker acts with your permissions, and
  a program it runs can write anywhere you can. In one trial run a
  reviewer ran the product under test with an empty home setting, and the
  product wrote into the real user's configuration folder (the reviewer
  noticed and restored it)
- merges into your own branches have no approval step yet
- the kill-by-name guard matches command text; a command assembled at run
  time can slip past it
- a resumed Codex reviewer loses its scratch folder as a writable root
- the orchestrator's restraint (plan and delegate, not do the work) is a
  prompt rule; it has a shell

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
