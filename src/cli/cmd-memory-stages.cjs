'use strict';
// cmd-memory-stages.cjs — `belay memory scrub|review|resolve`, the run-close stages by hand and the operator's way out of pending/.
//   scrub [--run <id>]    the scrubber on the run's scope, as at run close. Spawns one short read-only child (the run's lever model),
//                         so it is a write: it elects an owner on demand and shuts it down again.
//   review [--project p] the Opus archive reviewer, ON DEMAND (the run-close trigger is off unless `archive_review_auto`), on the project's
//                         held queue (every kind), ignoring the triggers. `--project` picks the newest ended run whose notes project it is.
//                         It runs under a store-level claim (review-run.cjs): a second review of the project refuses while the first is
//                         alive. It also refuses while a run other than the one it acts for is live, and while an ended run's process still
//                         holds the store owner through its close (either would shut the owner under it). Acting for a live run by
//                         `--run` is allowed on the operator's word, and the result carries a warning that the run's close will cut it off. `--start` launches it DETACHED and returns once the claim shows (the panel's button runs this).
//   resolve <id> new | repeats <id> | supersedes <id> --evidence <text>
//                         settle a pending note as the operator: memory.noteResolve's own logic (a repeat archives the pending row,
//                         nothing is deleted). For a note whose run has ended and whose writer is gone.
// scrub and review act through the run's lever block and the run's caller identity, because the core's lifecycle writes belong to the
// caller's own run (memory.scrubApply, memory.reviewApply). `--run` names it; without it the newest live run, else the newest run.
// This file reaches src/run only inside functions (the stages), as run-memory-end.cjs does.

const C = require('./config.cjs');
const P = require('./panel-common.cjs');
const { openCore } = require('../core/index.cjs');
const { readOwnerLock, pidAlive } = require('../core/lock.cjs');
const { DEFAULTS } = require('../core/memory-levers.cjs');

const one = (s) => P.clean(s == null ? '' : s, 2000).replace(/\s+/g, ' ');

// `--run <id>` names the run (a live one too, on the operator's word). Without it: the newest ENDED run that has the notes lever on. A
// live run is never the default: its writers may still resolve their pending notes, and its own close scrub is still to come.
async function chooseRun(core, wanted, project = null) {
  if (wanted) return { runId: wanted };
  const { runs } = await core.run.list({});
  const notesOn = (r) => { try { const l = typeof r.memory_levers === 'string' ? JSON.parse(r.memory_levers) : r.memory_levers; return !!(l && l.notes && (!project || l.project === project)); } catch { return false; } };
  const ended = runs.find((r) => !r.alive && r.ended_at != null && notesOn(r));
  if (ended) return { runId: ended.id };
  const live = runs.find((r) => r.alive && notesOn(r));
  return { runId: null, live: live ? live.id : null };
}

// Audit D35: another run's close shuts the store owner down and destroys every connection, so a review (minutes long, and paid for)
// started while a run other than the one it acts for is live can lose its calls (E_OWNER_LOST, outcome unknown) and leave a stray
// owner behind that refuses the next `belay run`. It waits for that run to end. A run is live here by two facts, not one. Its
// adapter answers a pid check (`alive`), or it has no `ended_at` and the store owner is held by another live process: the
// orchestrator's attach overwrites `adapter_pid` with the adapter's pid and the adapter exits before the close, so for the
// whole close (stages, run.end, memory run end) the run reads as not alive while `belay run` still owns the store. An unended
// run whose adapter is gone and whose owner is gone too is a crashed run and blocks nothing. The run it acts for is the
// operator's own word (`--run`), live or not: it is how the operator acts on a live run's notes now, and the error that
// suggests it says its close is still to come. That path is a known limit (audit D35's residual): when the run it acts for is live, its
// close will shut the owner under the review, so the result carries a warning saying so (`closing_warning`) and nothing waits.
// The closing rule below is the one exception to "never refused": it applies whichever run the review acts for. A listing that cannot be read blocks nothing: this guard adds no new failure.
// `resolve` is not gated: it is one call of milliseconds, and a loss there is an explicit E_OWNER_LOST with the outcome named
// unknown, never a silent one.
function ownerHeldElsewhere(dataDir, deps) {
  try {
    const lock = deps && deps.ownerLock ? deps.ownerLock(dataDir) : readOwnerLock(dataDir);
    return !!(lock && lock.pid && lock.pid !== process.pid && pidAlive(lock.pid));
  } catch { return false; }
}
// A third fact (audit D35, the rest of the close window): `belay run` sets `ended_at` and THEN runs the run-end memory jobs and only
// then shuts the owner down, so for that stretch the run is ended and still owns the store. It is a run whose present life
// (`life_pids`: every adapter pid its rows since the last end recorded, a re-run of the same run id included) has the pid, with
// its creation time when the row has one, that holds the owner lock now; that run is closing whichever run the review acts for,
// since its shutdown ends this review's connection just the same. A historical ended run whose process is gone, or whose pid
// another process holds, is not closing. An unreadable creation time fails towards refusing, as the other facts do.
async function closingRuns(runs, dataDir, deps) {
  let lock = null;
  try { lock = deps && deps.ownerLock ? deps.ownerLock(dataDir) : readOwnerLock(dataDir); } catch { return []; }
  if (!lock || !lock.pid || lock.pid === process.pid || !pidAlive(lock.pid)) return [];
  let got; // the lock holder's creation time, read once and only if a candidate row recorded one
  const holderIs = async (created) => {
    if (created == null) return true;
    if (got === undefined) {
      try { got = await (deps && deps.createdOf ? deps.createdOf(lock.pid) : require('../core/process.cjs').createdOf(lock.pid)); } catch { got = null; }
    }
    return !(got && got.created != null && got.created !== created); // another process holds the pid now
  };
  const out = [];
  for (const r of runs) {
    if (r.ended_at == null) continue;
    for (const p of (Array.isArray(r.life_pids) ? r.life_pids : [])) {
      if (p.pid === lock.pid && await holderIs(p.created)) { out.push({ ...r, closing_pid: lock.pid }); break; }
    }
  }
  return out;
}
// The run the review acts for is live by the same two facts (alive, or unended while another process holds the owner).
async function actedForLive(core, runId, dataDir, deps) {
  try {
    const held = ownerHeldElsewhere(dataDir, deps);
    const r = ((await core.run.list({})).runs || []).find((x) => x.id === runId);
    return !!(r && (r.alive || (r.ended_at == null && held)));
  } catch { return false; }
}
const CLOSING_WARNING = 'this run is live; its close will shut the store owner under this review and cut it off (outcome unknown). Let the run end first for a review that finishes.';
function warned(res) {
  if (!res || typeof res !== 'object') return res;
  const text = typeof res.text === 'string' ? `warning: ${CLOSING_WARNING}
${res.text}` : res.text;
  const json = res.json && typeof res.json === 'object' ? { ...res.json, closing_warning: CLOSING_WARNING } : res.json;
  return { ...res, text, json };
}
async function otherLiveRun(core, runId, dataDir, deps) {
  let live = [], closing = [];
  try {
    const held = ownerHeldElsewhere(dataDir, deps);
    const runs = (await core.run.list({})).runs || [];
    live = runs.filter((r) => r.id !== runId && (r.alive || (r.ended_at == null && held)));
    closing = (await closingRuns(runs, dataDir, deps)).filter((r) => !live.some((l) => l.id === r.id));
  } catch { return null; }
  if (!live.length && !closing.length) return null;
  const all = [...live, ...closing];
  const ids = all.map((r) => r.id).join(', ');
  const message = live.length
    ? `run ${live.map((r) => r.id).join(', ')} is live in this data dir; wait for it to end (or stop it) and try again, because its close would shut the store owner under this review${closing.length ? `; run ${closing.map((r) => r.id).join(', ')} is also closing` : ''}`
    : `run ${ids} has ended but its process (pid ${closing[0].closing_pid}) still holds the store owner while it closes; wait for \`belay run\` to exit and try again, because its owner shutdown would cut this review off`;
  return { code: 1, text: `belay memory review: ${one(message)}
`, json: { error: { code: 'E_BUSY', message, live_runs: all.map((r) => r.id) } } };
}

// The stage's own core: the operator, as the run it acts for. Returns { rc, lv, runId, dataDir } or { fail }.
async function stageCore(core, parsed, ctx, found) {
  const { runId, live } = await chooseRun(core, parsed.opts.run, parsed.opts.project || null);
  if (!runId) {
    const message = live ? `the only run with notes on is live (${live}); its own close scrub is still to come, so pass --run ${live} to act on it now` : 'no ended run with notes on exists to act for; pass --run <id>';
    return { fail: { code: 1, text: `belay memory ${parsed.sub}: ${one(message)}\n`, json: { error: { code: 'E_NOT_FOUND', message, live_run: live || null } } } };
  }
  const dataDir = C.dataDirOf(found, ctx);
  const open = process.env.BELAY_TEST_MODE === '1' && typeof ctx.openCore === 'function' ? ctx.openCore : openCore;
  const rc = await open({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
  let row;
  try { row = (await rc.run.get({})).run; } catch (e) { await rc.close(); return { fail: { code: 1, text: `belay memory ${parsed.sub}: no run row for ${one(runId)} (${e.code || 'E_INTERNAL'})\n`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } } }; }
  let lv = null;
  try { lv = row && row.memory_levers ? { ...DEFAULTS, ...(typeof row.memory_levers === 'string' ? JSON.parse(row.memory_levers) : row.memory_levers) } : null; } catch { lv = null; }
  if (!lv || !lv.notes) { await rc.close(); return { fail: { code: 1, text: `belay memory ${parsed.sub}: run ${one(runId)} has memory.notes off, so it has no notes lifecycle\n`, json: { error: { code: 'E_LEVER_OFF', message: 'notes off', run_id: runId } } } }; }
  return { rc, lv, runId, dataDir, project: parsed.opts.project || row.project || lv.project || null, worktree: parsed.opts.worktree || (found.found ? found.dir : ctx.cwd) };
}

async function release(rc) {
  if (rc.belayReleased) return;
  rc.belayReleased = true;
  // The owner this command elected stays up while another client is attached and stops with the last (ADR 0051).
  try { if (typeof rc.isOwner === 'function' && rc.isOwner()) await require('./release-owner.cjs').releaseOwnerOf(rc); } catch { /* best effort */ }
  await rc.close();
}

function renderStage(name, o) {
  if (!o.ran) return `${name}: nothing to do (${o.reason}${o.message ? `: ${one(o.message)}` : ''})\n`;
  const lines = [`${name}: ran as ${o.job}${o.trigger ? ` (${o.trigger})` : ''}`];
  if (o.counts) lines.push(`  scope: ${Object.entries(o.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (o.result) lines.push(`  ${o.mode || ''} ${JSON.stringify(o.result.counts)}${o.result.refused && o.result.refused.length ? `  refused: ${o.result.refused.map((r) => `${r.id} ${r.code}`).join(', ')}` : ''}`.replace(/^ {2} /, '  '));
  if (typeof o.cost === 'number') lines.push(`  cost: $${o.cost.toFixed(4)}`);
  if (o.alarm) lines.push(`  ALARM: ${one(o.alarm.message)}`);
  if (o.survivor) lines.push(`  child pid ${o.survivor} is still alive after its kill (stop it by that pid)`);
  if (o.error) lines.push(`  failed: ${o.error.code}: ${one(o.error.message)}${o.owed && o.owed.length ? `; ${o.owed.length} item(s) owed to the next scrub` : ''}`);
  else if (o.owed && o.owed.length) lines.push(`  ${o.owed.length} item(s) over the cap are owed to the next scrub`);
  return `${lines.join('\n')}\n`;
}

async function runStage(which, core, parsed, ctx, found) {
  const s = await stageCore(core, parsed, ctx, found);
  if (s.fail) return s.fail;
  if (which === 'review' && !s.project) { await release(s.rc); return { code: 1, text: 'belay memory review: the run has no project, so there is no held queue to review; pass --project <p>\n', json: { error: { code: 'E_ARGS', message: 'no project' } } }; }
  if (which === 'review') {
    const busy = await otherLiveRun(core, s.runId, s.dataDir, (process.env.BELAY_TEST_MODE === '1' && ctx.stageDeps) || {});
    if (busy) { await release(s.rc); return busy; }
  }
  const warn = which === 'review' && await actedForLive(core, s.runId, s.dataDir, (process.env.BELAY_TEST_MODE === '1' && ctx.stageDeps) || {});
  const out2 = (r) => (warn ? warned(r) : r);
  try {
    if (which === 'review' && parsed.opts.start) return out2(await require('./review-run.cjs').launch({ core, s, project: s.project, parsed, ctx, release }));
    const deps = (process.env.BELAY_TEST_MODE === '1' && ctx.stageDeps) || {};
    const CS = require('../run/close-stages.cjs');
    const h = s.rc.harness();
    const getManager = CS.lazyManager({ core: h, runId: s.runId, dataDir: s.dataDir, lv: s.lv, worktree: s.worktree, paths: deps.paths, makeManager: deps.makeManager });
    const common = { core: h, runId: s.runId, lv: s.lv, dataDir: s.dataDir, getManager, worktree: s.worktree };
    if (which === 'review') return out2(await require('./review-run.cjs').claimedReview({ s, project: s.project, ctx, common, runReview: require('../run/review-stage.cjs').runReview, renderStage }));
    const out = await require('../run/scrub-stage.cjs').runScrub({ ...common, goal: parsed.opts.goal || null, summary: parsed.opts.summary || null });
    return { code: out.error || out.survivor ? 1 : 0, text: renderStage(which, out), json: { run_id: s.runId, ...out } };
  } finally { await release(s.rc); }
}

const scrub = (...a) => runStage('scrub', ...a);
const review = (...a) => runStage('review', ...a);

async function resolve(core, parsed) {
  const [id, how, of] = parsed.positional;
  const r = { id, resolve: how, ...(of ? { of } : {}), ...((how === 'supersedes' || (how === 'refines' && parsed.opts.evidence)) ? { evidence: [{ where: 'operator', saw: parsed.opts.evidence }] } : {}) };
  const res = await core.memory.noteResolve({ resolutions: [r] });
  const x = res.resolved[0];
  const text = x.resolved === 'repeats'
    ? `resolved ${x.id} as a repeat of ${x.of}: the sighting is on ${x.of} (seen ${x.seen_total}), the pending row is archived in ${x.archived_as} (nothing deleted)\n`
    : `resolved ${x.id} as ${x.resolved}${x.of ? ` ${x.of}` : ''}: now ${x.state} in ${x.namespace}\n`;
  return { code: 0, text: `${text}still pending in the project: ${res.still_pending}\n`, json: res };
}

module.exports = { VERB_FN: { scrub, review, resolve }, renderStage, release };
