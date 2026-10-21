'use strict';
// close-stages-env.cjs — scaffolding for the run-close stage tests (not a *.test.cjs file). The real core engine over the notes
// lifecycle's sandbox store (tests/core/lifecycle-env.cjs), a fake run manager that answers a child's turn with a scripted text, and
// helpers to plant the notes, workers and streams a scope is made of. No session is ever started.

const fs = require('node:fs');
const { setup } = require('../core/lifecycle-env.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

const LV = {
  apply: { ...DEFAULTS, project: 'lc', notes: true, scrub_action: 'apply', archive_review_auto: true },
  propose: { ...DEFAULTS, project: 'lc', notes: true, archive_review_auto: true },
  off: { ...DEFAULTS, project: 'lc', notes: true, scrub_action: 'off', archive_review_auto: true },
  alarm: { ...DEFAULTS, project: 'lc', notes: true, scrub_action: 'apply', scrub_alarm_holds: 2, archive_review_auto: true },
  plain: { ...DEFAULTS, project: 'lc', notes: false },
};
const RUN = { apply: 'lc-apply', propose: 'lc-propose', off: 'lc-off', alarm: 'lc-alarm', plain: 'lc-plain' };

async function env() {
  const T = await setup();
  // The harness view of the core as the run's caller, as the run process holds it.
  const coreFor = (kind) => {
    const caller = T.who.harness(kind);
    return new Proxy({}, { get: (_, g) => (g === 'caller' ? caller : new Proxy({}, { get: (__, n) => (args) => T.E.handle(`${g}.${n}`, { caller, ...(args || {}) }) })) }); // the plain engine call: the stage sees what the scrubber sees
  };
  const calls = (core) => { const log = []; return { log, core: new Proxy({}, { get: (_, g) => (g === 'caller' ? core.caller : new Proxy({}, { get: (__, n) => (args) => { log.push(`${g}.${n}`); return core[g][n](args); } })) }) }; };
  // A worker of the run with a head commit in the sandbox repository, and its stream file.
  async function worker(kind, id, extra = {}) {
    await T.call(T.who.tool(kind), 'worker.write', { id, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: `s-${id}`, last_event_at: Date.now(), worktree: T.repo, head_sha: T.head, base_sha: T.head, ...extra });
    fs.mkdirSync(`${T.dir}/workers/${id}`, { recursive: true });
    fs.writeFileSync(`${T.dir}/workers/${id}/stream.jsonl`, '{"type":"system"}\n');
  }
  // A live note every reported note names as its replacement: a report with no replacement is no longer in the scrub's scope.
  const partner = T.note('the shared live partner the reports name');
  const reported = (title, kind = 'apply', over = {}) => T.note(title, { reported_wrong: [{ ...T.report('worker:w2', partner), run_id: RUN[kind], worker_id: 'w2' }], ...over });
  const pending = (title, kind = 'apply', over = {}) => T.note(title, { ns: 'pending/lc', state: 'pending', run_id: RUN[kind], ...over });
  const events = (kind) => T.store.p('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
  const archived = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = 'archive/lc'").all().map((r) => r.id);
  const rel = (id, over = {}) => ({ id, action: 'relate', relation: 'repeats', of: partner, reason: 'the same lesson as the shared partner', ...over });
  const holds = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = 'held/lc'").all().map((r) => r.id);
  const proposals = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = 'proposal/lc'").all().map((r) => r.id);
  const hold = (id, over = {}) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader throws for an unlisted name', cites: [T.cite], ...over });
  return { T, hold, rel, archived, partner, coreFor, calls, worker, reported, pending, events, holds, proposals };
}

// A fake run manager. `answer` is the child's last text (a string, or a function of the spawn arguments); it records what it was asked.
function fakeManager(T, kind, answer, { cost = 0.01, event = 'turn_end', spawnError = null } = {}) {
  const m = { spawned: [], stopped: [], waits: [], recs: new Map() };
  m.spawn = async (a) => {
    m.spawned.push(a); fakeManager.last = a;
    if (spawnError) throw spawnError;
    await T.call(T.who.tool(kind), 'worker.write', { id: a.worker_id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), worktree: a.worktree });
    m.recs.set(a.worker_id, { lastAssistantText: typeof answer === 'function' ? answer(a) : answer, costUsd: cost });
    return {};
  };
  m.wait = async (a) => { m.waits.push(a); return { event, is_error: false, timed_out: event === 'timeout' }; };
  m.stop = async ({ worker_id }) => { m.stopped.push(worker_id); };
  m._worker = (id) => m.recs.get(id);
  return m;
}

const json = (key, list) => JSON.stringify({ [key]: list });

module.exports = { env, fakeManager, json, LV, RUN };
