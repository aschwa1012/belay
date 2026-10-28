'use strict';
// cmd-briefing.cjs — build step 4b, design item 3. Mode R.
// Prints the orientation document a worker would be given: continuity.resumeLine then resumeDoc,
// bounded at 400 and 4,096 bytes (api.md §3, ADR 0007 §2). Renamed from command table's `resume` row,
// because that is what it actually prints.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay briefing: ${message}\n\n`
      + 'usage: belay briefing <worker-id> [--data <dir>] [--json]\n'
      + '       belay briefing --task <task-id> [--data <dir>] [--json]\n',
    json: { error: message },
  };
}

function parseArgs(argv) {
  let taskId = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--task') { taskId = argv[i += 1]; if (taskId === undefined) return { error: '--task needs a task id' }; continue; }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (taskId && rest.length) return { error: 'belay briefing takes either a worker id or --task <task-id>, not both' };
  if (!taskId && rest.length !== 1) return { error: 'belay briefing needs a worker id, or --task <task-id>' };
  return { selector: taskId ? { task_id: taskId } : { worker_id: rest[0] } };
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode R: never created. No run selection from an argument is needed — the worker or task id names
  // the row directly. But `resumeDoc` tags its memory query with a namespace, defaulting to
  // `run/<caller.run_id>` (api.md §3), and this process was opened with the placeholder `run_id: 'cli'`
  // (there being no run argument to carry one) — so the default would ask a namespace no row was ever
  // written to. The task the selector resolves to carries its own real `run_id` (methods-task.cjs
  // `create()`), and that is what belongs here: resolve it through `task.get` and pass it explicitly.
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const { line, doc } = await core.readBatch(async () => { // one store copy for the three reads
      const l = await core.continuity.resumeLine(parsed.selector);
      const task = await core.task.get({ task_id: l.task_id });
      return { line: l, doc: await core.continuity.resumeDoc({ ...parsed.selector, namespace: `run/${task.run_id}` }) };
    });
    const json = { selector: parsed.selector, line, doc };
    return { code: 0, text: `${line.text}\n\n${doc.text}\n`, json };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay briefing: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
