'use strict';
// methods-task.cjs — tasks and leases (api.md §3, ADR 0010 §4). The authority order is operator,
// orchestrator, worker, and it lives here rather than in a prompt: a worker can only renew or release a
// lease it holds, and its identity is `caller.worker_id`, which came from argv. A lease coordinates
// ownership; it never authorises a side effect.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { DEFAULT_LEASE_TTL_MS, TASK_STATES } = require('./schema.cjs');
const { runAcceptance } = require('./evaluate.cjs');
const holds = require('./task-holds.cjs');
const integrationState = require('./integration-state.cjs');
const { filesOverlap, treeHint, runNotLive, resolveOwner, assertNotOwnReview } = require('./methods-task-hold.cjs');

// ADR 0025 decision 1: the most a worker may hand back on release, serialized.
const HANDOFF_MAX_BYTES = 4096;

// build step 6e-4: 'paused' dropped — a parked worker is not live, so task.assign refuses it E_WORKER_NOT_LIVE.
const LIVE_WORKER_STATES = new Set(['starting', 'running', 'idle']);

function ttlFrom(args) {
  const n = Number(args && args.ttl_ms);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEASE_TTL_MS;
}

const dependsOf = (task) => (Array.isArray(task && task.depends_on) ? task.depends_on : []);

// ADR 0013 §1: a model told in prose to wait does not wait, it goes looking, and what it finds is a
// person to ask. The edges are data on the task row and the refusal is computed here, so the store
// answers the question the worker would otherwise aim at the orchestrator.
//
// Acyclicity does not rest on this walk. `create` refuses a dependency that has no row, and refuses an
// id that already has one, so an edge can only ever point at a task created earlier and a cycle cannot
// be built through the only method that writes `depends_on`. The walk is the invariant stated as a
// check rather than as an argument: it fires if a row reaches the table by any other route, and it is
// what a future writer of dependency edges will have to keep passing.
function findCycle(store, id, dependsOn) {
  const edges = (taskId) => (taskId === id ? dependsOn : dependsOf(rows.current(store, 'task', taskId)));
  const path = [], onPath = new Set(), done = new Set();
  const walk = (at) => {
    if (onPath.has(at)) return [...path.slice(path.indexOf(at)), at];
    if (done.has(at)) return null;
    onPath.add(at); path.push(at);
    for (const next of edges(at)) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    onPath.delete(at); path.pop(); done.add(at);
    return null;
  };
  return walk(id);
}

async function create(E, caller, args) {
  if (typeof args.spec !== 'string' || !args.spec.trim()) throw err('E_ARGS', 'task.create needs a spec describing the work');
  const filesOwned = args.files_owned == null ? null : args.files_owned;
  if (filesOwned != null && (!Array.isArray(filesOwned) || filesOwned.some(p => typeof p !== 'string'))) {
    throw err('E_ARGS', 'task.files_owned must be an array of worktree-relative path strings');
  }
  const acceptance = args.acceptance == null ? null : args.acceptance;
  if (acceptance != null && (typeof acceptance !== 'object' || Array.isArray(acceptance))) {
    throw err('E_ARGS', 'task.acceptance must be an object with optional commands and files_within_owned');
  }
  const handoffShape = acceptance ? require('./handoff-check.cjs').shapeError(acceptance.handoff) : null; // ADR 0058 decision 6
  if (handoffShape) throw err('E_ARGS', handoffShape);
  if (acceptance && acceptance.verdict !== undefined && acceptance.verdict !== true) {
    throw err('E_ARGS', 'task.acceptance.verdict must be true or absent: a review task is judged from a worker\'s handed-back verdict');
  }
  const dependsOn = args.depends_on == null ? null : args.depends_on;
  if (dependsOn != null && (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string' || !d))) {
    throw err('E_ARGS', 'task.depends_on must be an array of task ids this task cannot be assigned before');
  }
  if (args.repairs != null && (typeof args.repairs !== 'string' || !args.repairs)) {
    throw err('E_ARGS', 'task.repairs must be the id of the work task this fix task repairs');
  }
  const repairs = args.repairs == null ? null : args.repairs;
  const id = args.id || rows.newId();
  if (rows.current(E.store, 'task', id)) throw err('E_ARGS', `a task with id ${id} already exists in this store`, { task_id: id });

  const deps = dependsOn ? [...new Set(dependsOn)] : null;
  if (deps) {
    for (const dep of deps) {
      if (!rows.current(E.store, 'task', dep)) {
        throw err('E_NOT_FOUND', `task ${id} would depend on ${dep}, which has no row in this store, so nothing could ever mark it done`, { task_id: id, missing_dependency: dep });
      }
    }
    const cycle = findCycle(E.store, id, deps);
    if (cycle) {
      throw err('E_DEPENDENCY_CYCLE', `these dependencies form a cycle, ${cycle.join(' -> ')}, and every task in it would refuse assignment for ever`, { task_id: id, cycle });
    }
  }

  // ADR 0031 decision 6: a fix task names the work it repairs, and core refuses one past the run's cap.
  // A run row with no cap (an operator's own session, a pre-lever store) is not enforced.
  if (repairs) {
    if (!rows.current(E.store, 'task', repairs)) {
      throw err('E_NOT_FOUND', `task ${id} would repair ${repairs}, which has no row in this store`, { task_id: id, missing_repairs: repairs });
    }
    const run = rows.current(E.store, 'run', caller.run_id);
    const cap = run && run.max_fix_rounds != null ? Number(run.max_fix_rounds) : null;
    if (cap != null) {
      const used = rows.currentAll(E.store, 'task').filter(o => o.repairs === repairs && o.run_id === caller.run_id).length;
      if (used >= cap) {
        throw err('E_FIX_ROUNDS', `task ${repairs} already has ${used} fix task${used === 1 ? '' : 's'} and this run's max_fix_rounds is ${cap}; nothing was written. End the run and name the open blocking findings for the human`, { task_id: id, repairs, fix_rounds_used: used, max_fix_rounds: cap });
      }
    }
  }

  let overlaps = [];
  if (filesOwned && filesOwned.length) {
    // ADR 0046 decision 1: only a task that holds its files (its run is live) can refuse this one. ADR 0059 decision 4: a new
    // task has no tree yet, so it is judged as shared, and only a holder in the shared tree refuses it; one in its own
    // worktree is reported in `overlaps`.
    const scan = holds.scanOverlaps(E.store, filesOwned, null);
    const first = scan.find((c) => c.same_tree);
    if (first) throw filesOverlap(first, treeHint(E.store, null));
    overlaps = holds.acrossTrees(scan);
  }

  const t = Date.now();
  const row = rows.append(E.store, 'task', {
    id, run_id: caller.run_id, spec: args.spec, acceptance, files_owned: filesOwned, state: 'open',
    results: null, depends_on: deps, repairs,
  }, E.writtenBy(caller), t);
  E.noteWrite();
  return overlaps.length ? { ...row, overlaps } : row;
}

// The dependency gate shared by task.assign and task.evaluate: only `done` opens it (ADR 0013 §1, ADR 0030 decision 2).
function assertDependenciesDone(E, task) {
  for (const dep of dependsOf(task)) {
    const d = rows.current(E.store, 'task', dep);
    if (!d) throw err('E_NOT_FOUND', `task ${task.id} depends on ${dep}, which has no row in this store`, { task_id: task.id, missing_dependency: dep });
    if (d.state === 'done') continue;
    const dl = rows.currentLeaseForTask(E.store, dep);
    const held = dl && !dl.released_at ? `${dl.holder_role} ${dl.holder}` : 'no one';
    if (refutedReview(d)) {
      throw err('E_DEPENDENCY_OPEN', `task ${task.id} depends on task ${dep}, a review whose last evaluation returned refuted; it is not done unless it is re-judged and holds. A fix task depends on the work it fixes, never on the review (ADR 0030)`,
        { task_id: task.id, blocked_by: dep, dependency_state: d.state, dependency_verdict: 'refuted', holder: dl && !dl.released_at ? dl.holder : null, holder_role: dl && !dl.released_at ? dl.holder_role : null });
    }
    throw err('E_DEPENDENCY_OPEN', `task ${task.id} depends on task ${dep}, which is ${d.state} and held by ${held}; assign this task again once ${dep} is done`,
      { task_id: task.id, blocked_by: dep, dependency_state: d.state, holder: dl && !dl.released_at ? dl.holder : null, holder_role: dl && !dl.released_at ? dl.holder_role : null });
  }
}

const SPAWN_THERE = "a worker cannot change its directory once it runs, so spawn a worker in the task's worktree";

async function assign(E, caller, args) {
  if (args.check_only !== undefined && typeof args.check_only !== 'boolean') throw err('E_ARGS', 'task.assign check_only must be a boolean');
  const checkOnly = args.check_only === true;
  if (!args.task_id || (!checkOnly && !args.worker_id)) throw err('E_ARGS', 'task.assign needs a task_id and a worker_id');
  if (args.worktree !== undefined && (!checkOnly || !args.worktree || typeof args.worktree !== 'string')) throw err('E_ARGS', 'task.assign worktree is the directory a spawn will run in, a non-empty string, and only with check_only');
  const tree = await require('./review-tree.cjs').grantSnapshot(E, args); // ADR 0054 amendment 1: a review's tree at grant (git, so before the tx)

  // Every read this decision rests on happens inside the same BEGIN IMMEDIATE as the two writes it
  // authorises. Read outside it and the operator's take-control, or the worker's death, can land between
  // the check and the write, so the refusal that was computed is not the state that is committed: the
  // grant would be made against a store that no longer says what it said. The lease row and the task
  // row are one effect for the same reason — a granted lease on a task still `open`, or a released lease
  // on a task still `assigned`, is a state the contract has no name for (ADR 0002 §4).
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.task_id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });

    // `done` is written only by task.evaluate with executable evidence (api.md §2) and it opens every
    // dependent's gate. Re-assigning it would un-earn it silently, so it is refused before anything is
    // written; redoing finished work is a new task.
    if (task.state === 'done') {
      throw err('E_TASK_DONE', `task ${args.task_id} is done, and done is written only by task.evaluate; assigning it would un-earn it and reopen its dependents' gate, so create a new task to redo the work`, { task_id: args.task_id, state: 'done' });
    }
    if (task.state === 'cancelled') throw err('E_ARGS', `task ${args.task_id} was cancelled, which is final; create a new task to do the work`, { task_id: args.task_id, state: 'cancelled' });

    const old = rows.currentLeaseForTask(E.store, args.task_id);
    if (old && !old.released_at && old.holder_role === 'operator') {
      throw err('E_OPERATOR_HOLDS', `the operator holds lease ${old.id} on task ${args.task_id} and has not released it, and take-control outranks the orchestrator`, { task_id: args.task_id, lease_id: old.id, holder: old.holder });
    }
    // The dependency gate is a property of the task, so it is checked before the worker is looked at:
    // whichever worker was named, an open dependency is the answer, and the refusal names what would
    // clear it (ADR 0013 §1). Only `done` opens the gate, and `done` is earned by executable evidence
    // (api.md §2), so a worker cannot talk its way past this by saying it finished.
    assertDependenciesDone(E, task);
    assertNotOwnReview(E.store, task, args.worker_id); // with check_only too, when the spawn names its worker id

    // ADR 0046 decision 1: assigning makes a task hold its files, so another holding task, in any run, that overlaps them
    // refuses it. Inside one live run create already refused the overlap, so this fires for a re-attached run only: a task
    // of a run that came back to life after this task's run did yields, so the run live now keeps the paths.
    // The hold belongs to a live run: a task whose own run has ended is taken over by the run of the worker that takes it
    // (the calling orchestrator's run for a check_only), and is refused when no live run can own it.
    const worker = checkOnly ? null : rows.current(E.store, 'worker', args.worker_id);
    // ADR 0058 amendment: a worker runs in one directory for its whole life, so a task with its own worktree goes only to a
    // worker that runs there. A check_only call checks the directory the spawn will run in, when it names one. Checked before
    // the hold, so a worker in the wrong tree is told that, not a hold's remedy (ADR 0059).
    const { assertTaskTree } = require('./methods-worktree.cjs');
    if (checkOnly && args.worktree !== undefined) assertTaskTree(task, args.worktree, "the spawn's worktree", SPAWN_THERE);
    if (worker) assertTaskTree(task, worker.worktree, `worker ${args.worker_id}'s worktree`, SPAWN_THERE);
    // ADR 0059: the tree the task will be worked in is the worker's, or for a check_only the spawn's directory when it names one.
    const taker = checkOnly ? (typeof args.worktree === 'string' && args.worktree ? { worktree: args.worktree } : null) : worker;
    // A task that owns files moves to the run of the worker that takes it, and a move is a new claim: every overlapping holder refuses it.
    const overlaps = []; // ADR 0059 decision 3: the overlaps with tasks in other trees, which do not refuse
    const ownerRun = resolveOwner(E.store, task, checkOnly ? (caller.role === 'orchestrator' ? caller.run_id : null) : (worker && worker.run_id), taker, overlaps);
    const reported = overlaps.length ? { overlaps } : {};

    // ADR 0030 decision 4: the task-side checks above are the whole of a check_only call; it writes nothing.
    if (checkOnly) return { assignable: true, task_id: task.id, ...reported };

    if (!worker) throw err('E_WORKER_NOT_LIVE', `no worker row exists for ${args.worker_id}, so it cannot hold a lease`, { worker_id: args.worker_id });
    if (!LIVE_WORKER_STATES.has(worker.state)) {
      throw err('E_WORKER_NOT_LIVE', `worker ${args.worker_id} is in state ${worker.state} and only starting, running or idle can be assigned a task`, { worker_id: args.worker_id, state: worker.state });
    }
    // Build step 6a-2, ADR 0010 amendment 1: liveness is derived, never self-reported (invariant 4). A
    // `starting`/`running`/`idle` row is only a claim; an actual dead pid behind it is not assignable,
    // however fresh the state word looks. A row with no pid yet at all (`worker.pid == null`) is a
    // different, legitimate fact, not a dead one: src/run/manager.cjs writes the `starting` row and
    // calls task.assign before the launch has a pid to report — only `worker.write`'s own `running`
    // check treats a pid as required, and this must not narrow that.
    if (worker.pid != null && !pidAlive(worker.pid)) {
      throw err('E_WORKER_NOT_LIVE', `worker ${args.worker_id} claims state ${worker.state} but its pid ${worker.pid} is dead`,
        { worker_id: args.worker_id, state: worker.state, pid: worker.pid, pid_alive: false });
    }


    // Build step 6a-2, design item 1: a lease belongs to its task's run, never the caller's — an
    // operator writing from the CLI (run_id 'cli') must not produce a lease no run's store.diff can see.
    const t = Date.now(), by = E.writtenBy(caller);
    const lease = rows.append(E.store, 'lease', {
      id: rows.newId(), task_id: args.task_id, run_id: ownerRun, holder: args.worker_id,
      holder_role: 'worker', granted_at: t, expires_at: t + ttlFrom(args), ttl_ms: ttlFrom(args), released_at: null,
      supersedes: old ? old.id : null, ...(tree ? { tree } : {}),
    }, by, t);
    const row = rows.append(E.store, 'task', { ...task, run_id: ownerRun, state: 'assigned' }, by, t);
    return { task: row, old_lease: old, new_lease: tree ? require('./review-tree.cjs').shown(lease) : lease, paused_worker: null, ...reported };
  });
  if (!checkOnly) E.noteWrite();
  return out;
}

// ADR 0030 decision 2: a review task whose current evaluation carries an executable verdict check that failed.
function refutedReview(d) {
  if (!d || !d.acceptance || d.acceptance.verdict !== true) return false;
  const checks = d.results && Array.isArray(d.results.checks) ? d.results.checks : [];
  return checks.some(c => c && c.kind === 'verdict' && c.executable === true && c.passed === false);
}

function view(E, task, liveness, integrations) {
  const t = Date.now();
  const l = rows.currentLeaseForTask(E.store, task.id);
  let lease = null, holderPidAlive = null;
  if (l && !l.released_at) {
    lease = { id: l.id, holder: l.holder, holder_role: l.holder_role, granted_at: l.granted_at, ttl_ms: l.ttl_ms, expires_at: l.expires_at, expired: l.expires_at != null && Number(l.expires_at) < t };
    if (l.holder_role === 'worker' && l.holder) {
      const w = rows.current(E.store, 'worker', l.holder);
      holderPidAlive = w ? pidAlive(w.pid) : false;
    }
  }
  const ck = rows.lastCheckpoint(E.store, task.id);
  const h = holds.holdOf(task, liveness || holds.runLiveness(E.store));
  // ADR 0053 amendment 2: whether the task's branch landed is its own fact beside `state`, derived from the integration rows.
  const integration = integrationState.ofTask(task, integrations || integrationState.newestFirst(E.store));
  return { ...task, holds_files: h.holds, holds_reason: h.reason, lease, holder_pid_alive: holderPidAlive, last_checkpoint_id: ck ? ck.id : null, last_checkpoint_at: ck ? ck.written_at : null, integration };
}

async function list(E, caller, args) {
  const states = Array.isArray(args.states) && args.states.length ? new Set(args.states) : null;
  const liveness = holds.runLiveness(E.store);
  const integrations = integrationState.newestFirst(E.store);
  const tasks = rows.currentAll(E.store, 'task').filter(t => !states || states.has(t.state)).map(t => view(E, t, liveness, integrations));
  return { tasks };
}

async function get(E, caller, args) {
  if (!args.task_id) throw err('E_ARGS', 'task.get needs a task_id');
  const t = rows.current(E.store, 'task', args.task_id);
  if (!t) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
  return view(E, t);
}

async function evaluate(E, caller, args) {
  if (!args.task_id) throw err('E_ARGS', 'task.evaluate needs a task_id');
  if (args.worktree !== undefined && (!args.worktree || typeof args.worktree !== 'string')) throw err('E_ARGS', 'task.evaluate needs the worktree the acceptance criteria run in');
  if (args.base !== undefined && (typeof args.base !== 'string' || !args.base)) throw err('E_ARGS', 'task.evaluate: base must be a non-empty string (a commit or ref)');
  if (args.trigger !== undefined && args.trigger !== 'release') throw err('E_ARGS', 'task.evaluate: trigger is release (the run manager evaluating a hand-back, ADR 0058) or absent');
  const task = rows.current(E.store, 'task', args.task_id);
  if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
  // The same two gates assign applies, checked before any command runs and again inside the write's transaction. `done` is
  // final: a re-run would overwrite its passing evidence, or keep `done` over failing results. An open dependency is refused
  // rather than evaluated without `done`, because a task is not done while its dependency is open (ADR 0013 section 1).
  const gate = (t) => {
    if (t.state === 'done') throw err('E_TASK_DONE', `task ${t.id} is done, and done is final; create a new task to redo the work`, { task_id: t.id, state: 'done' });
    if (t.state === 'cancelled') throw err('E_ARGS', `task ${t.id} was cancelled, which is final; there is nothing to evaluate`, { task_id: t.id, state: 'cancelled' });
    assertDependenciesDone(E, t);
  };
  E.store.tx(() => gate(rows.current(E.store, 'task', args.task_id) || task));

  // Lazy: verdict.cjs is loaded only when a write path needs it, never when a core is opened to read.
  const { verdictCheck } = require('./verdict.cjs');
  const at = require('./methods-worktree.cjs').evaluateTarget(task, args); // ADR 0053 decision 4: the recorded worktree and base
  const EC = args.cancel_key !== undefined ? require('./evaluate-cancel.cjs') : null; // ADR 0058: a release evaluation can be cancelled
  const cancel = EC ? EC.register(args.cancel_key) : null;
  let commandChecks;
  try { commandChecks = await runAcceptance(task.acceptance, at.worktree, task.files_owned, { ...at, cancel }); } finally { if (cancel) EC.unregister(args.cancel_key, cancel); }
  if (cancel && cancel.cancelled) throw EC.cancelled(task, cancel);
  // The commands can run for minutes, so the row is read again inside the transaction that writes it: a
  // release that landed meanwhile (its handoff, its state) is what the verdict check reads and what the
  // written row carries forward (ADR 0025 decision 4).
  const row = E.store.tx(() => {
    E.assertRunOpen(caller, 'task.evaluate'); // run.end may have committed while the commands ran (audit D42)
    const fresh = rows.current(E.store, 'task', args.task_id) || task;
    gate(fresh);
    const checks = [...commandChecks];
    if (fresh.acceptance && fresh.acceptance.verdict === true) checks.push(verdictCheck(E.store, fresh));
    if (fresh.acceptance && fresh.acceptance.handoff) checks.push(require('./handoff-check.cjs').handoffCheck(E.store, fresh)); // ADR 0058 decision 6
    // Nothing checked is not the same as everything passed. A task with no acceptance criteria has no
    // executable evidence, so it can never reach `done` through this call.
    const executable = checks.length > 0 && checks.every(c => c.executable);
    const passed = checks.length > 0 && checks.every(c => c.passed);
    const results = {
      evaluated_at: Date.now(), executable, passed, checks, ...(args.trigger ? { trigger: args.trigger } : {}),
      ...(checks.length === 0 ? { note: 'the task declares no acceptance criteria, so nothing was executed and nothing is proven' } : {}),
    };
    return rows.append(E.store, 'task', {
      ...fresh, results, state: executable && passed ? 'done' : fresh.state,
    }, E.writtenBy(caller), Date.now());
  });
  E.noteWrite();
  return row;
}

// ---- leases ---------------------------------------------------------------
function requireLease(E, leaseId) {
  if (!leaseId) throw err('E_ARGS', 'this call needs a lease_id');
  const l = rows.current(E.store, 'lease', leaseId);
  if (!l) throw err('E_NOT_FOUND', `no lease row exists for ${leaseId}`, { lease_id: leaseId });
  return l;
}

// A lease id alone is not authority. The current lease of a task is the highest-seq lease row for that
// task (api.md §2), so appending a row for a lease the orchestrator already superseded would make the
// old lease current again and hand the task back to its previous holder. Renewing or releasing a
// superseded lease is therefore refused: a worker may act on its own lease, never outrank an
// assignment (ADR 0010 §4).
function requireCurrentLease(E, leaseId) {
  const l = requireLease(E, leaseId);
  const current = rows.currentLeaseForTask(E.store, l.task_id);
  if (!current || current.id !== l.id) {
    throw err('E_LEASE_EXPIRED', `lease ${l.id} on task ${l.task_id} was superseded by lease ${current ? current.id : 'none'}, so it is no longer that task's lease`,
      { lease_id: l.id, task_id: l.task_id, superseded_by: current ? current.id : null, current_holder: current ? current.holder : null });
  }
  return l;
}

async function renew(E, caller, args) {
  const l = requireCurrentLease(E, args.lease_id);
  if (l.holder !== caller.worker_id || l.holder_role !== 'worker') {
    throw err('E_NOT_HOLDER', `lease ${l.id} is held by ${l.holder_role} ${l.holder}, and this call came from worker ${caller.worker_id}`, { lease_id: l.id, holder: l.holder, holder_role: l.holder_role });
  }
  const t = Date.now();
  if (l.released_at != null) throw err('E_LEASE_EXPIRED', `lease ${l.id} was released at ${l.released_at} and a released lease cannot be renewed`, { lease_id: l.id, released_at: l.released_at });
  if (l.expires_at != null && Number(l.expires_at) < t) {
    throw err('E_LEASE_EXPIRED', `lease ${l.id} expired at ${l.expires_at}, ${t - Number(l.expires_at)} ms ago, so the orchestrator must assign it again`, { lease_id: l.id, expires_at: l.expires_at });
  }
  const row = rows.append(E.store, 'lease', { ...l, expires_at: t + ttlFrom(args), ttl_ms: ttlFrom(args) }, E.writtenBy(caller), t);
  E.noteWrite();
  return row;
}

// ADR 0025 decision 1: every check happens before anything is written.
function checkResult(caller, result) {
  if (caller.role !== 'worker') throw err('E_ARGS', 'lease.release: an operator release hands nothing back; only the worker holding the lease may pass a result');
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw err('E_ARGS', 'lease.release: result must be a plain JSON object');
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > HANDOFF_MAX_BYTES) throw err('E_ARGS', `lease.release: result is ${bytes} bytes serialized and the limit is ${HANDOFF_MAX_BYTES}`, { bytes, limit: HANDOFF_MAX_BYTES });
}

// ADR 0040 decision 6: a worker cites memory as `result.memory_ids`. Each id is looked up in the store; the ones
// with no row are recorded beside the hand-back as `memory_ids_missing`. A citation is a claim, so a missing
// id never refuses the release. Returns null when the result cites nothing, and the field is then not written.
function missingCitations(E, result) {
  if (!Object.prototype.hasOwnProperty.call(result, 'memory_ids')) return null;
  const ids = result.memory_ids;
  if (!Array.isArray(ids)) return [ids];
  const find = E.store.p('SELECT 1 FROM memory_entries WHERE id = ?');
  const missing = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || !find.get(id)) { if (!missing.some((m) => m === id)) missing.push(id); }
  }
  return missing;
}

async function release(E, caller, args) {
  return require('./methods-memory-notes.cjs').serialised(E, caller, args, () => releaseNow(E, caller, args));
}

async function releaseNow(E, caller, args) {
  if (args.result !== undefined) checkResult(caller, args.result);
  // ADR 0047: with the run's notes lever on, the hand-back's notes and marks are checked and embedded here, before
  // anything is written; with it off this is null and the release below is exactly what it was.
  const NM = require('./methods-memory-notes.cjs');
  const got = await NM.prepare(E, caller, args);
  // ADR 0034 amendment 1: under `off` the hand-back's notes are dropped and the lease still releases; the result says so.
  const dropped = got && got.dropped ? { notes_dropped: got.dropped } : null;
  const prep = dropped ? null : got;
  const RT = require('./review-tree.cjs'), treeNow = await RT.releaseSnapshot(E, args); // ADR 0054 amendment 1: a review's tree at the hand-back
  const out = E.store.tx(() => {
    E.assertRunOpen(caller, 'lease.release'); // the notes were embedded above; run.end may have committed meanwhile (audit D42)
    // Releasing a superseded lease would destroy the current holder's live lease, so the currency rule
    // applies to the operator too; what the operator overrides is the holder check, not the rule that a
    // release acts on the lease the task actually has.
    const l = requireCurrentLease(E, args.lease_id);
    if (caller.role === 'worker' && (l.holder !== caller.worker_id || l.holder_role !== 'worker')) {
      throw err('E_NOT_HOLDER', `lease ${l.id} is held by ${l.holder_role} ${l.holder}, and this call came from worker ${caller.worker_id}`, { lease_id: l.id, holder: l.holder, holder_role: l.holder_role });
    }
    const task = rows.current(E.store, 'task', l.task_id);
    if (!task) throw err('E_NOT_FOUND', `lease ${l.id} names task ${l.task_id}, which has no row in this store`, { lease_id: l.id, task_id: l.task_id });
    // ADR 0025 amendment 1: a release never un-earns `done`, and cannot replace the verdict it rests on.
    if (task.state === 'done' && args.result !== undefined) {
      throw err('E_ARGS', `lease.release: task ${task.id} is done, so its hand-back cannot be replaced; release without a result`, { task_id: task.id });
    }
    const t = Date.now(), by = E.writtenBy(caller);
    if (dropped && l.released_at != null) {
      // A second call on a released lease carries only notes, and they are dropped: nothing is written.
      return { ...task, last_checkpoint_id: (rows.lastCheckpoint(E.store, l.task_id) || {}).id || null, released_reason: args.reason || null, ...dropped };
    }
    if (prep && l.released_at != null) {
      // A second call on a released lease only adds notes (the reflection turn): the release stands as it was written.
      if (args.result !== undefined) throw err('E_ARGS', `lease.release: lease ${l.id} was already released, so a second call may carry notes but not a new result`, { lease_id: l.id });
      NM.claimAfterRelease(E, caller, prep, l, task.id); // only with memory.notes_reflection, once per lease
      return { ...task, last_checkpoint_id: (rows.lastCheckpoint(E.store, l.task_id) || {}).id || null, released_reason: args.reason || null, ...NM.commit(E, caller, prep, { task_id: task.id }) };
    }
    // Audit D44: with notes off nothing above handles a second call, and the release below would append another released
    // row and replace the hand-back it stands on. A released lease is released once; only the notes-only calls above return.
    if (l.released_at != null) {
      throw err('E_ARGS', `lease.release: lease ${l.id} was already released at ${l.released_at}, so a second release would replace its hand-back; nothing was written`, { lease_id: l.id, released_at: l.released_at });
    }
    rows.append(E.store, 'lease', { ...l, released_at: t }, by, t);
    let handoff = task.handoff;
    if (args.result !== undefined) {
      handoff = { result: args.result, by: caller.worker_id, lease_id: l.id, at: t };
      const missing = missingCitations(E, args.result);
      if (missing !== null) handoff.memory_ids_missing = missing;
      if (l.tree) Object.assign(handoff, RT.handBack(E.dataDir, caller.worker_id, l.tree, treeNow)); // the tree's change and the scratch size
    }
    const row = rows.append(E.store, 'task', { ...task, state: task.state === 'done' ? 'done' : 'released', handoff }, by, t);
    const ck = rows.lastCheckpoint(E.store, l.task_id);
    return { ...row, last_checkpoint_id: ck ? ck.id : null, released_reason: args.reason || null, ...(prep ? NM.commit(E, caller, prep, { task_id: task.id }) : {}), ...(dropped || {}) };
  });
  E.noteWrite();
  return out;
}

async function takeControl(E, caller, args) {
  if (!args.task_id) throw err('E_ARGS', 'lease.takeControl needs a task_id');
  // Build step 6a-2, design item 1: the task row is read inside the same transaction as the writes it
  // authorises, exactly as assign() does, so the run_id the lease is stamped with is never stale by the
  // time it is written, and a lease belongs to its task's run, never the caller's.
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.task_id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
    // ADR 0046 decision 1: the operator's lease activates the task like an assignment does, so its files must be held by a
    // live run (the task's own: the operator has no run to re-home it to) and not yielded to one that is live now.
    // ADR 0059: belay does not know where the operator works, so the operator is judged as in the shared tree, and the
    // overlaps it lets through with tasks in their own worktrees are returned as `overlaps`.
    let overlaps = [];
    if (task.state !== 'done' && Array.isArray(task.files_owned) && task.files_owned.length) {
      if (holds.activationRun(E.store, task, null) == null) throw runNotLive(task, null);
      const scan = holds.scanOverlaps(E.store, task.files_owned, task.id, { run_id: task.run_id }, holds.treeOf(E.store, task, holds.OPERATOR));
      const first = scan.find((c) => c.same_tree);
      if (first) throw filesOverlap(first);
      overlaps = holds.acrossTrees(scan);
    }
    const old = rows.currentLeaseForTask(E.store, args.task_id);
    const t = Date.now(), by = E.writtenBy(caller);
    if (old && !old.released_at) rows.append(E.store, 'lease', { ...old, released_at: t }, by, t);
    const lease = rows.append(E.store, 'lease', {
      id: rows.newId(), task_id: args.task_id, run_id: task.run_id, holder: 'operator', holder_role: 'operator',
      granted_at: t, expires_at: t + ttlFrom(args), ttl_ms: ttlFrom(args), released_at: null, supersedes: old ? old.id : null,
    }, by, t);
    // `done` is the one state earned by executable evidence (api.md §2); take-control must not un-earn it.
    rows.append(E.store, 'task', { ...task, state: task.state === 'done' ? 'done' : 'assigned' }, by, t);
    return { old_lease: old, new_lease: lease, paused_worker: null, ...(overlaps.length ? { overlaps } : {}) };
  });
  E.noteWrite();
  return out;
}

// The lease a worker must hold before it may write a checkpoint (api.md §3, continuity.checkpoint).
function heldLease(E, taskId, workerId) {
  const l = rows.currentLeaseForTask(E.store, taskId);
  if (!l || l.released_at != null) return null;
  if (l.holder !== workerId || l.holder_role !== 'worker') return null;
  if (l.expires_at != null && Number(l.expires_at) < Date.now()) return null;
  return l;
}

// ADR 0058: a second evaluation of the same task and tree while one runs joins it (evaluate-cancel.cjs joinOrRun).
module.exports = { create, assign, list, get, evaluate: (E, caller, args) => require('./evaluate-cancel.cjs').joinOrRun(E, args, () => evaluate(E, caller, args)), renew, release, takeControl, view, heldLease, overlaps: holds.overlaps, findCycle, dependsOf, refutedReview, TASK_STATES };
