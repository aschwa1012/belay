'use strict';
// tools-orchestrator.cjs — the orchestrator's own tools (ADR 0010 §2 and its amendments), moved out of tools.cjs (the 500-line rule).

const { S, str, int, bool, DEBUG, strs } = require('./tools-schema.cjs');
const { WORKER_TYPES } = require('../run/agent-defaults.cjs'); // pure; the agent_type enum

const ORCHESTRATOR = [
  {
    name: 'worker_spawn',
    description: 'Launch a real Claude Code or Codex process and wait for its ready event. Returns id, substrate, pid, state, session id, worktree, model, effort, tools, ready_ms; view debug: the whole row and launch receipt.',
    inputSchema: S({
      substrate: { type: 'string', enum: ['claude-code', 'codex'] },
      worktree: str('Absolute path; the worker\'s cwd. Default: task_id\'s worktree'),
      prompt: str('Without task_id, the first message. With it, instructions added after the task\'s spec'),
      task_id: str('Assign this task once ready; belay sends its resume line, then its spec'),
      model: str(),
      agent_type: { type: 'string', enum: WORKER_TYPES, description: 'Configured model, effort and tools' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      memory_queries: strs('Up to 4 task lines naming the situations the worker will be in, each max 160 bytes'),
      allowed_tools: strs(),
      permission_mode: str(),
      startup_timeout_ms: int('default 60000'),
      worker_id: str('Otherwise generated'),
      view: { type: 'string', enum: ['compact', 'debug'] },
    }, ['substrate']),
  },
  {
    // ADR 0015. `worker_spawn` above returns at the ready event and the worker keeps running; this is
    // the call that waits for what happens next. A timeout is a result rather than an error because
    // the caller's own tool timeout has to be the outer bound, and a refusal would lose the fact that
    // nothing had finished yet.
    name: 'worker_wait',
    description: 'Block until one of the named workers, or any worker this session launched, finishes a turn or dies, or the timeout passes. Returns which worker, what happened, what established it, its turn and checkpoint id, and how long the call held. timed_out is a result. already: turn ended earlier.',
    inputSchema: S({
      worker_ids: strs('Otherwise every worker this session launched'),
      timeout_ms: int('default 110000'),
    }),
  },
  {
    name: 'worker_message',
    description: 'Send text to a live worker. Returns the channel used, bytes written, pid and turn; while it compacts, channel queued, sent when that ends.',
    inputSchema: S({ worker_id: str(), text: str() }, ['worker_id', 'text']),
  },
  {
    name: 'worker_last_reply',
    description: 'The text a worker\'s last finished turn ended with, from the stream belay recorded (max 4 KB), marked as data.',
    inputSchema: S({ worker_id: str() }, ['worker_id']),
  },
  {
    name: 'worker_stop',
    description: 'Stop a worker by its recorded pid. Returns exit code, signal, ms to exit, whether it was graceful or killed, and the session id to resume from later.',
    inputSchema: S({
      worker_id: str(),
      mode: { type: 'string', enum: ['graceful', 'kill'] },
      timeout_ms: int('default 10000'),
    }, ['worker_id', 'mode']),
  },
  {
    name: 'worker_restart',
    description: 'Restart a worker from its last checkpoint. Returns which branch was taken, resume or replace, and why, the old and new pid, session id, checkpoint id and the first turn\'s usage. Past about 100 s it returns status "not ready yet" with first_turn_awaited false; the relaunch carries on.',
    inputSchema: S({ worker_id: str(), first_turn_timeout_ms: int('default 180000') }, ['worker_id']),
  },
  {
    name: 'task_create',
    description: 'Create a task with the checks that decide it is done, the files it owns and the tasks it must wait for. Returns id, rev, state open, spec_head (view debug: whole row). worktree makes its tree first; tasks makes up to 10.',
    inputSchema: S({
      spec: str('What is to be done'),
      acceptance: S({
        commands: {
          type: 'array',
          items: S({ argv: strs(), cwd: str(), timeout_ms: int(), retries_on_fail: int('0-5; a pass after a fail is marked flaky') }, ['argv']),
        },
        files_within_owned: bool(),
        verdict: { const: true },
        handoff: S({ required: strs('Fields the hand-back result must carry') }),
      }),
      files_owned: strs('Paths relative to the worktree'),
      depends_on: strs('Task ids that must be done before this one can be assigned'),
      repairs: str('A fix task: the id of the work task it repairs; past max_fix_rounds the answer carries fix_notice'),
      base: str('Diff base'),
      budget_usd: { type: 'number', description: 'USD limit; needs the ledger' },
      tree_of: str('Work in that task\'s worktree (a conflict fix)'),
      worktree: { type: ['boolean', 'string'], description: 'Own tree: true from HEAD, or a base ref' },
      tasks: { type: 'array', items: { type: 'object' }, description: 'Several, each with these fields; all or nothing' },
      id: str(),
      amend: { type: 'boolean', description: 'Replace not-done task id\'s acceptance and spec' },
      view: DEBUG,
    }), // spec: required unless amend (validateArgs)
  },
  {
    name: 'task_assign',
    description: 'Assign a task to a live worker, take a lease and send the worker the task, its lease id and the hand-back rule. Returns the old lease row, the new lease (id, holder, expires_at), the task\'s task_list row and delivered.',
    inputSchema: S({ task_id: str(), worker_id: str(), ttl_ms: int('default 600000'), prompt: str('Instructions added after the task\'s spec'), deliver: bool() }, ['task_id', 'worker_id']),
  },
  {
    // ADR 0020 decision 5: the orchestrator's window onto the permission channel, so a headless run
    // with a prompting worker does not stall until a human types.
    name: 'permission_list',
    description: 'List permission requests waiting on a verdict. Returns each with its tool, input, age and whether the requesting adapter is still alive. Defaults to pending only.',
    inputSchema: S({ run_id: str(), states: strs('pending, allowed, denied or expired; default pending') }),
  },
  {
    name: 'permission_decide',
    description: 'Allow or deny one pending permission request. Returns the request and verdict rows, and whether the requesting adapter is alive to act on it.',
    inputSchema: S({ id: str(), verdict: { type: 'string', enum: ['allow', 'deny'] }, reason: str() }, ['id', 'verdict']),
  },
  {
    name: 'task_evaluate',
    description: 'Run a task\'s checks in worktree. Returns row and results (passing output cut; view debug: whole); done (unblocks dependents) only if all pass. A run with max_parallel_evaluations may queue it; E_BUSY queued: waited too long, nothing run, call again.',
    inputSchema: S({
      task_id: str(),
      worktree: str('Default: the task\'s worktree'),
      base: str('Diff base; default the task\'s base, else merge-base main'),
      view: DEBUG,
    }, ['task_id']),
  },
  {
    // ADR 0053 decisions 2, 3 and 6.
    name: 'task_worktree',
    description: 'Create (default) or remove the task\'s own git worktree and branch belay/<task_id>, cut from base (default HEAD). Returns id, rev, state, spec_head, worktree (view debug: whole row). remove keeps the branch unless delete_branch.',
    inputSchema: S({
      task_id: str(),
      action: { type: 'string', enum: ['create', 'remove'] },
      base: str(),
      branch: str(),
      force: bool(),
      delete_branch: bool(),
      view: DEBUG,
    }, ['task_id']),
  },
  {
    // ADR 0053 decision 5.
    name: 'integrate',
    description: 'Merge done tasks\' branches, at the head each was judged at, in order into into (default belay/integrate/<run>), then re-run their checks there. Returns state, merged (what this call merged), carried (count from earlier rows), not_merged, left_out (commits past it), checks (reused ones marked), passed, forced, not_carried (passing output cut; view debug: whole row). A conflict is aborted, tree clean; conflict names task and files; what merged before it is still checked. task_list gives each task\'s integration state. force with reason also merges tasks not done, recorded as forced. A run with max_parallel_evaluations may queue the re-run; E_BUSY queued: refused before any merge, call again. into may name a user branch; if the run asks first, approved_in_chat (interactive) or approval (awaiting_approval id).',
    inputSchema: S({
      task_ids: strs(),
      into: str(),
      base: str('If into is new; default the tasks\' base'),
      evaluate: { type: 'boolean', description: 'false skips the tasks\' re-runs' },
      checks: { type: 'array', items: S({ argv: strs(), cwd: str(), timeout_ms: int() }, ['argv']), description: 'Extra commands run on the merged head, before the tasks re-run; all the commands of the call share one 540 s budget' },
      force: bool(),
      reason: str(),
      approved_in_chat: bool(),
      approval: str(),
      view: DEBUG,
    }, ['task_ids']),
  },
  {
    name: 'fix_from_review',
    description: 'Create the fix task for a review evaluated refuted, with depends_on, repairs, acceptance and files_owned inferred and spec from its findings. Returns id, rev, state, spec_head, repairs, depends_on, files_owned, fix_notice past max_fix_rounds. With follow_up: true, for a review that held: a follow-up task for its should-fix findings in a tree of its own, not a fix round; E_FOLLOW_UPS past max_follow_ups (view debug: whole row).',
    inputSchema: S({ review_id: str(), spec: str('Default: from the findings'), repairs: str('Which task, if it judged several'), follow_up: { type: 'boolean' }, id: str(), view: DEBUG }, ['review_id']),
  },
  {
    name: 'task_cancel',
    description: 'Give up on a task that is not done: releases its lease and its files_owned, state cancelled (final), and tells the lease holder. Returns the task\'s task_list row, the released lease and notified.',
    inputSchema: S({ task_id: str(), reason: str() }, ['task_id']),
  },
  {
    // ADR 0040 §4. A worker cannot verify a claim, so this is not on the worker listing.
    name: 'memory_verify',
    description: 'Set an entry\'s status with its evidence. Returns id, status, previous status, receipt.',
    inputSchema: S({
      id: str(),
      status: { type: 'string', enum: ['unverified', 'verified', 'refuted'] },
      receipt: str('checkpoint:id, task:id, memory:id, commit:sha or test:text; none for unverified'),
    }, ['id', 'status']),
  },
  {
    // ADR 0054 decision 2. One tool with an op, not four: the listing pays for one schema.
    name: 'git_read',
    description: 'Read-only git, run by belay with fixed argv, in worktree, task_id\'s worktree or the run\'s. Returns exit_code, out (16 KB max, truncated marked; view debug: argv too).',
    inputSchema: S({
      op: { type: 'string', enum: ['status', 'log', 'diff', 'show'] },
      worktree: str(),
      task_id: str(),
      rev: str('a..b for log/diff; one commit for show'),
      path: str(),
      stat: bool(),
      n: int('log, default 20'),
      view: DEBUG,
    }, ['op']),
  },
];

module.exports = { ORCHESTRATOR };
