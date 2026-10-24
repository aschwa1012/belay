'use strict';
// cmd-worktree.cjs — ADR 0053 decision 7, the operator's hand on belay's worktrees. Serves two commands, told apart by
// ctx.command as cmd-decide.cjs serves approve and deny:
//   worktree   (mode W) create|remove|merge: a store client as role operator, so a cleanup after a run has ended still works;
//              the write goes to the live owner, or elects one on demand (no daemon: it leaves when its last client does).
//   worktrees  (mode R) the tasks' recorded worktrees and the integration rows, read from the store or its copy; no git runs.
// The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling process.exit.

const path = require('node:path');
const C = require('./config.cjs');

const USAGE = {
  worktree: 'usage: belay worktree create <task-id> [--base <ref>] [--branch <name>] [--repo <dir>] [--no-junction]\n'
    + '       belay worktree remove <task-id> [--force] [--delete-branch]\n'
    + '       belay worktree remove --integration <id> [--force]\n'
    + '       belay worktree merge <task-id>... [--into <branch>] [--base <ref>] [--no-evaluate]\n',
  worktrees: 'usage: belay worktrees [run-id] [--all] [--data <dir>] [--json]\n',
};

const usageError = (command, message) => ({ code: 2, text: `belay ${command}: ${message}\n\n${USAGE[command]}`, json: { error: message } });

const VALUE = new Set(['--base', '--branch', '--repo', '--into', '--integration']);
const FLAG = new Set(['--force', '--delete-branch', '--no-evaluate', '--no-junction', '--all']);

function parse(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE.has(a)) {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('-')) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
    } else if (FLAG.has(a)) opts[a.slice(2)] = true;
    else if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    else rest.push(a);
  }
  return { opts, rest };
}

function failure(command, e) {
  const error = { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail };
  return { code: 1, text: `belay ${command}: ${error.code}: ${e.message}\n`, json: { error } };
}

const wtLine = (t) => {
  const w = t.worktree;
  return `task ${t.id} (${t.state}): ${w.removed_at ? 'removed' : w.path} branch ${w.branch} base ${String(w.base_sha).slice(0, 12)}`;
};

function mergeText(r) {
  const head = `integration ${r.id} into ${r.into_branch} at ${r.worktree}: ${r.state}`;
  const merged = r.merged.map((m) => `  merged ${m.task_id} (${m.branch})${m.already ? ' already' : ''}`);
  const tail = r.state === 'conflict' ? [`  conflict in task ${r.conflict.task_id}: ${r.conflict.files.join(', ')}; merge aborted, tree ${r.conflict.tree_clean ? 'clean' : 'NOT clean'}`]
    : r.state === 'failed' ? [`  failed: ${r.error && r.error.message}`]
      : r.checks ? [...r.checks.map((c) => `  ${c.passed ? 'pass' : 'FAIL'} ${c.argv.join(' ')} (${c.task_ids.join(',')})`), `  passed: ${r.passed}`] : [];
  return [head, ...merged, ...tail, ''].join('\n');
}

async function write(ctx, core) {
  const p = parse(ctx.argv.slice(1));
  if (p.error) return usageError('worktree', p.error);
  const { opts, rest } = p;
  const sub = ctx.argv[0];
  try {
    if (sub === 'create') {
      if (rest.length !== 1) return usageError('worktree', 'create needs exactly one task id');
      const row = await core.task.worktreeCreate({
        task_id: rest[0], repo: C.fwd(path.resolve(ctx.cwd, opts.repo || '.')),
        ...(opts.base ? { base: opts.base } : {}), ...(opts.branch ? { branch: opts.branch } : {}), ...(opts['no-junction'] ? { junction: [] } : {}),
      });
      return { code: 0, text: `${wtLine(row)}\n`, json: row };
    }
    if (sub === 'remove') {
      if (opts.integration) {
        if (rest.length) return usageError('worktree', 'remove --integration takes no task id');
        const row = await core.integration.remove({ id: opts.integration, ...(opts.force ? { force: true } : {}) });
        return { code: 0, text: `integration ${row.id}: removed ${row.worktree}; branch ${row.into_branch} kept\n`, json: row };
      }
      if (rest.length !== 1) return usageError('worktree', 'remove needs exactly one task id');
      const row = await core.task.worktreeRemove({ task_id: rest[0], ...(opts.force ? { force: true } : {}), ...(opts['delete-branch'] ? { delete_branch: true } : {}) });
      const b = row.removal.branch_deleted ? 'deleted' : `kept${row.removal.branch_kept ? ` (${row.removal.branch_kept})` : ''}`;
      return { code: 0, text: `task ${row.id}: worktree removed (${row.removal.junctions_unlinked.length} junction(s) unlinked first); branch ${row.worktree.branch} ${b}\n`, json: row };
    }
    if (sub === 'merge') {
      if (!rest.length) return usageError('worktree', 'merge needs at least one task id');
      const row = await core.integration.merge({
        task_ids: rest, ...(opts.into ? { into: opts.into } : {}), ...(opts.base ? { base: opts.base } : {}), ...(opts['no-evaluate'] ? { evaluate: false } : {}),
      });
      const good = row.state === 'merged' || (row.state === 'evaluated' && row.passed === true);
      return { code: good ? 0 : 1, text: mergeText(row), json: row };
    }
    return usageError('worktree', sub === undefined ? 'needs a subcommand: create, remove or merge' : `unknown subcommand ${sub}`);
  } catch (e) {
    return failure('worktree', e);
  }
}

async function read(ctx, core) {
  const p = parse(ctx.argv);
  if (p.error) return usageError('worktrees', p.error);
  if (p.rest.length > 1) return usageError('worktrees', `takes zero or one argument, a run id; got ${p.rest.length}`);
  try {
    let runId = p.rest[0] || null;
    if (!runId && !p.opts.all) {
      const { runs } = await core.run.list({});
      runId = runs.length ? (runs.find((r) => r.alive) || runs[0]).id : null;
    }
    const keep = (r) => p.opts.all || r.run_id === runId;
    const tasks = (await core.task.list({})).tasks.filter((t) => t.worktree && keep(t));
    const integrations = (await core.integration.list({})).integrations.filter(keep);
    const lines = [...tasks.map(wtLine), ...integrations.map((r) => `integration ${r.id} into ${r.into_branch}: ${r.state}${r.passed != null ? ` passed ${r.passed}` : ''}${r.removed_at ? ' (tree removed)' : ` at ${r.worktree}`}`)];
    const json = { run_id: p.opts.all ? null : runId, worktrees: tasks.map((t) => ({ task_id: t.id, state: t.state, ...t.worktree })), integrations };
    return { code: 0, text: lines.length ? `${lines.join('\n')}\n` : '(no worktrees)\n', json };
  } catch (e) {
    return failure('worktrees', e);
  }
}

async function run(ctx) {
  const { openCore } = require('../core/index.cjs');
  const command = ctx.command === 'worktrees' ? 'worktrees' : 'worktree';
  if (command === 'worktree' && !['create', 'remove', 'merge'].includes(ctx.argv[0])) {
    return usageError('worktree', ctx.argv[0] === undefined ? 'needs a subcommand: create, remove or merge' : `unknown subcommand ${ctx.argv[0]}`);
  }
  const dataDir = C.dataDirOf(C.discover(ctx.cwd), ctx);
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    return command === 'worktrees' ? await read(ctx, core) : await write(ctx, core);
  } finally {
    // A write with no live owner elected this command's own; it is let go here, so no owner outlives the command (ADR 0051).
    if (core.isOwner()) { try { await require('./release-owner.cjs').releaseOwnerOf(core); } catch { /* best effort */ } }
    await core.close();
  }
}

module.exports = { run, parse };
