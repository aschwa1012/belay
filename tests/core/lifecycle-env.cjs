'use strict';
// lifecycle-env.cjs — shared scaffolding for the notes lifecycle tests (scrubApply, reviewApply, restore, purge). Not a
// *.test.cjs file, so the runner does not execute it. A real Engine over a stamped store in a sandbox, a tiny git
// repository for the citation check, and notes written straight into the project namespace with stored vectors.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

const PROJECT = 'lc';
const RUNS = { apply: 'lc-apply', propose: 'lc-propose', off: 'lc-off', alarm: 'lc-alarm', plain: 'lc-plain', strict: 'lc-strict' };
const LEVERS = {
  apply: { project: PROJECT, notes: true, scrub_action: 'apply' },
  propose: { project: PROJECT, notes: true },
  off: { project: PROJECT, notes: true, scrub_action: 'off' },
  alarm: { project: PROJECT, notes: true, scrub_action: 'apply', scrub_alarm_holds: 2 },
  plain: { project: PROJECT },
  strict: { project: PROJECT, notes: true, scrub_action: 'apply', notes_match_threshold: 0.995 },
};

const A = [1, 0, 0], A_NEAR = [0.99, 0.141, 0], B = [0, 1, 0];

async function setup() {
  const dir = sandbox();
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const who = {
    harness: k => callerFor('orchestrator', { run_id: RUNS[k], channel: 'harness' }),
    tool: k => callerFor('orchestrator', { run_id: RUNS[k] }),
    operator: k => callerFor('operator', { run_id: RUNS[k] }),
  };
  // The scrubber may no longer hand back a hold or a dismissal (memory.scrubApply refuses both), but the held queue and the reviewer
  // are still tested through them: a hand-back that carries one goes to holdApply, the same call with them allowed (the seam the
  // report-to-hold path uses). `scrubber` below is the plain engine call, which refuses them.
  const heldShape = args => Array.isArray(args.scrub) && args.scrub.some(e => e && (e.action === 'hold' || e.action === 'dismiss'));
  const call = (caller, method, args = {}) => (method === 'memory.scrubApply' && heldShape(args)
    ? require('../../src/core/methods-memory-scrub.cjs').holdApply(E, caller, args) : E.handle(method, { caller, ...args }));
  for (const k of Object.keys(RUNS)) await call(who.tool(k), 'run.attach', { adapter_pid: process.pid, project: PROJECT, memory_levers: JSON.stringify(LEVERS[k]) });
  let n = 0;
  // A note as the hand-back would have stored it: type note, body state, stored vector. created_at orders them.
  function note(title, over = {}) {
    const { ns = `project/${PROJECT}`, vec = A, reported_wrong = [], state = 'live', matches, created_at, status, written_by = 'worker:w1', task_id = `t${++n}`, seen_in = [], seen_total = 0, run_id = 'old-run' } = over;
    const r = store.storeIn({
      namespace: ns, worker_id: 'w1', type: 'note', text: `${title}\n#${n}`, title,
      body: { kind: 'lesson', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'saw it' }], applies_to: [], subjects: [], model: 'm', state, seen_in, seen_total, reported_wrong, ...(matches ? { matches } : {}) },
      embedding: vec, embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id, task_id, source: 'model', written_by,
    });
    for (const [k, v] of Object.entries({ ...(created_at ? { created_at } : {}), ...(status ? { status } : {}) })) store.db.prepare(`UPDATE memory_entries SET ${k} = ? WHERE id = ?`).run(v, r.id);
    return r.id;
  }
  const row = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
  const body = id => JSON.parse(row(id).body);
  const report = (by = 'worker:w2', replaced_by = null) => ({ by, worker_id: 'w2', task_id: 'tx', run_id: 'old-run', why: 'it is wrong', replaced_by, at: 1 });

  // A git repository with one committed file, for the citation check.
  const repo = `${dir}/repo`;
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(`${repo}/loader.js`, 'function load(name) {\n  return fixtures.get(name); // unlisted names throw\n}\n');
  git('add', '-A'); git('commit', '-q', '-m', 'loader');
  const head = git('rev-parse', 'HEAD');
  const evidence = { head_sha: head, worktree: repo };
  const cite = { where: 'loader.js:2', quote: 'return fixtures.get(name); // unlisted names throw' };

  // The review stage refuses while a run other than the one it acts for is live (audit D35); a test that drives it ends the others.
  const endOthers = async (keep) => { for (const k of Object.keys(RUNS)) if (k !== keep) await call(who.operator(k), 'run.end', { exit_reason: 'test' }); };

  return { dir, store, E, who, call, endOthers, note, row, body, report, evidence, cite, head, repo, close: () => { store.close(); cleanup(dir); } };
}

module.exports = { setup, PROJECT, RUNS, A, A_NEAR, B };
