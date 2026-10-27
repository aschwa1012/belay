'use strict';
// merge-user-gate.cjs — which branches are the user's, and whether a merge into one may go ahead (ADR 0067 decisions 1 to 3 and 7).
// A user branch is any branch that is not belay's: not the branch some task row records as its own (while its branch still exists),
// and not belay/integrate/<run id> for this run or a run the store knows. The test reads rows and the name, never the caller's claim.
// Under the run's merge_into "ask", approval is the interactive orchestrator's own `approved_in_chat` (the run's recorded mode says it
// is interactive) or, in a headless run, a `merge` permission row that only the operator can decide, matched exactly (the branch, the
// tasks and their judged commits, the branch head, whether checks run and which) and used once.
// Branch names are compared as git resolves them: on a host whose refs are case-insensitive (Windows, or core.ignorecase) two
// spellings are one branch, so a name that differs from an existing branch only by case is refused, and every comparison is folded.

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const W = require('./methods-worktree.cjs');

const STAGING = /^belay\/integrate\/(.+)$/;

// -> (name) => the name as refs compare it on this host.
async function folder(repo) {
  if (process.platform === 'win32') return (s) => String(s).toLowerCase();
  const r = await G.run(repo, ['config', '--bool', 'core.ignorecase']);
  return r.ok && r.stdout.trim() === 'true' ? (s) => String(s).toLowerCase() : (s) => String(s);
}

// Every branch, spelled as git stores it (loose and packed): never found by resolving a name, which a case-insensitive host answers for any spelling.
async function branchNames(repo) {
  const out = await G.must(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], 'the branches could not be listed');
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^refs\/heads\//, ''));
}

// A name that is not an existing branch's exact spelling but folds to one is another spelling of it: refused, before anything else.
async function refuseVariant(repo, into, fold) {
  const names = await branchNames(repo);
  if (names.includes(into)) return;
  const same = names.find((b) => fold(b) === fold(into));
  if (same) throw err('E_ARGS', `${into} is another spelling of the existing branch ${same}, and refs compare equal on this host; name it as ${same}`, { into, existing: same });
}

function isUserBranch(E, repo, into, runId, fold = (s) => s) {
  const m = STAGING.exec(into);
  if (m && (fold(m[1]) === fold(runId) || rows.current(E.store, 'run', m[1]))) return false;
  return !rows.currentAll(E.store, 'task').some((t) => t.worktree && t.worktree.branch && !t.worktree.branch_deleted && fold(t.worktree.branch) === fold(into) && (!t.worktree.repo || G.samePath(t.worktree.repo, repo)));
}

// The run's setting and mode, read from its row (written by the launching attach, operator only). Absent reads as "ask" and "headless".
function runFacts(E, runId) {
  const r = rows.current(E.store, 'run', runId);
  return { setting: r && r.merge_into === 'allowed' ? 'allowed' : 'ask', mode: r && r.run_mode === 'interactive' ? 'interactive' : 'headless' };
}

// Where `into` stands now, under the branch lock: its head (null when it does not exist), the base a new branch is cut from, and the
// tree it is checked out in (null when none). A checked-out tree with a live worker or uncommitted paths is refused here, before
// anything is written. Existence is the exact spelling in the branch listing.
async function placement(E, repo, into, args, tasks, fold = (s) => s) {
  await refuseVariant(repo, into, fold);
  const exists = (await branchNames(repo)).includes(into);
  const head = exists ? (await G.must(repo, ['rev-parse', '--verify', `refs/heads/${into}^{commit}`], `${into} does not resolve`)).trim() : null;
  let base = null;
  if (!exists) {
    if (args.base !== undefined) base = await G.commitOf(repo, args.base);
    else {
      const bases = [...new Set(tasks.map((t) => t.worktree.base_sha))];
      if (bases.length !== 1) throw err('E_ARGS', `the tasks were cut from ${bases.length} different bases, so ${into} needs a base: pass base (for example the default branch)`, { bases });
      base = bases[0];
    }
  }
  const found = (await G.worktrees(repo)).find((w) => w.branch && fold(w.branch) === fold(into)) || null;
  if (found) {
    const w = W.liveWorkerIn(E, found.path);
    if (w) throw err('E_WORKER_LIVE', `worker ${w.id} (${w.state}) works in ${found.path}, where ${into} is checked out; belay does not merge under a live worker`, { worker_id: w.id, state: w.state, path: found.path });
    const d = await G.dirtyPaths(found.path);
    if (d.length) throw err('E_PRECONDITION', `${into} is checked out at ${found.path} with ${d.length} uncommitted path(s); belay will not prepare a merge into a branch someone is editing`, { path: found.path, dirty: d.slice(0, 50) });
  }
  return { exists, head, base, checkout: found ? found.path : null };
}

// The checks a call would run: each distinct command of the tasks' acceptance (argv and the cwd as the task wrote it), none when evaluate is false.
function checkList(tasks, evaluate) {
  if (!evaluate) return [];
  const seen = new Set(), out = [];
  for (const t of tasks) {
    for (const c of (t.acceptance && Array.isArray(t.acceptance.commands) ? t.acceptance.commands : [])) {
      if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((x) => typeof x !== 'string')) continue;
      const key = JSON.stringify([c.argv, c.cwd || null]);
      if (!seen.has(key)) { seen.add(key); out.push({ argv: c.argv, cwd: c.cwd || null }); }
    }
  }
  return out;
}

// The text a permission row and a later call are matched on: the repository, the branch, the tasks in order with their judged commits,
// the branch head (or the base of a new branch), whether checks run and exactly which. Any difference is another request.
function requestOf(repo, into, ids, targets, place, args, tasks) {
  const evaluate = args.evaluate !== false;
  return JSON.stringify({ repo: G.fwd(repo), into, tasks: ids.map((id) => ({ id, sha: targets.has(id) ? targets.get(id).sha : null })), into_head: place.head, base: place.base, evaluate, checks: checkList(tasks, evaluate) });
}

const usedBy = (E, id) => rows.currentAll(E.store, 'integration').some((r) => r.approver && r.approver.id === id);

function verify(E, caller, id, input) {
  const row = rows.current(E.store, 'permission', id);
  if (!row || row.kind !== 'merge' || row.run_id !== caller.run_id) throw err('E_NOT_FOUND', `no merge approval ${id} exists for this run`, { approval: id });
  if (row.state === 'pending') throw err('E_PRECONDITION', `merge approval ${id} is not decided yet; the operator answers it with belay approve ${id}`, { approval: id, state: row.state });
  if (row.state !== 'allowed') throw err('E_PRECONDITION', `merge approval ${id} is ${row.state}${row.reason ? ` (${row.reason})` : ''}; a new request is needed`, { approval: id, state: row.state });
  if (!String(row.verdict_by).startsWith('operator:')) throw err('E_PRECONDITION', `merge approval ${id} was not decided by the operator (${row.verdict_by}), so it does not count`, { approval: id, verdict_by: row.verdict_by });
  if (usedBy(E, id)) throw err('E_PRECONDITION', `merge approval ${id} has been used; an approval covers one merge, so a new request is needed`, { approval: id });
  if (row.input !== input) throw err('E_PRECONDITION', `merge approval ${id} was given for another merge (a different branch, task set, judged commits, branch head, or checks); the request is made again for this one`, { approval: id, approved: JSON.parse(row.input), asked: JSON.parse(input) });
  return { kind: 'permission', id, verdict_by: row.verdict_by };
}

// Raises the request (or finds the one already raised for exactly this merge) and answers without touching git.
function ask(E, caller, input) {
  const same = rows.currentAll(E.store, 'permission').find((r) => r.kind === 'merge' && r.run_id === caller.run_id && r.input === input && (r.state === 'pending' || (r.state === 'allowed' && !usedBy(E, r.id))));
  let row = same;
  if (!row) {
    const t = Date.now();
    row = E.store.tx(() => rows.append(E.store, 'permission', {
      id: rows.newId(), run_id: caller.run_id, worker_id: null, adapter_pid: caller.pid, tool: 'integrate', input, input_truncated: 0,
      input_sha256: crypto.createHash('sha256').update(input).digest('hex'), state: 'pending', verdict_by: null, reason: null, requested_at: t, decided_at: null, kind: 'merge',
    }, E.writtenBy(caller), t));
    E.noteWrite();
  }
  const parsed = JSON.parse(input);
  return {
    state: 'awaiting_approval', target: 'user', into_branch: parsed.into, permission_id: row.id, permission_state: row.state, request: parsed,
    message: `merging into ${parsed.into} needs the operator's approval; nothing was written to git. The operator answers with belay approve ${row.id} (or belay deny); then call integrate again with approval: "${row.id}" and the same arguments`,
  };
}

// -> { approver } to go ahead, or { response } (an awaiting_approval answer); throws when the call is refused.
function authorize(E, caller, args, input) {
  if (args.approval !== undefined && (typeof args.approval !== 'string' || !args.approval)) throw err('E_ARGS', 'integration.merge: approval must be a permission id', { field: 'approval' });
  if (args.approved_in_chat !== undefined && typeof args.approved_in_chat !== 'boolean') throw err('E_ARGS', 'integration.merge: approved_in_chat must be a boolean', { field: 'approved_in_chat' });
  if (caller.role === 'operator') return { approver: { kind: 'operator' } };
  const f = runFacts(E, caller.run_id);
  if (f.setting === 'allowed') return { approver: { kind: 'setting', setting: 'merge_into=allowed' } };
  if (args.approval !== undefined) return { approver: verify(E, caller, args.approval, input) };
  if (f.mode === 'interactive') {
    if (args.approved_in_chat === true) return { approver: { kind: 'chat', established_by: "the interactive orchestrator's call; belay did not see the approval" } };
    throw err('E_PRECONDITION', 'this run has merge_into "ask", and into names a branch the user owns: ask the user in the chat, and pass approved_in_chat: true once they agree', { merge_into: 'ask', mode: f.mode });
  }
  return { response: ask(E, caller, input) };
}

module.exports = { isUserBranch, runFacts, placement, requestOf, authorize, folder, refuseVariant, branchNames, checkList };
