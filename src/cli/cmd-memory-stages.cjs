'use strict';
// cmd-memory-stages.cjs — `belay memory scrub|review|resolve`, the run-close stages by hand and the operator's way out of pending/.
//   scrub [--run <id>]    the scrubber on the run's scope, as at run close. Spawns one short read-only child (the run's lever model),
//                         so it is a write: it elects an owner on demand and shuts it down again.
//   review [--project p] the Opus archive reviewer, ON DEMAND (the run-close trigger is off unless `archive_review_auto`), on the project's
//                         held queue (every kind), ignoring the triggers. `--project` picks the newest ended run whose notes project it is.
//                         It runs under a store-level claim (review-run.cjs): a second review of the project refuses while the first is
//                         alive. `--start` launches it DETACHED and returns once the claim shows (the panel's button runs this).
//   resolve <id> new | repeats <id> | supersedes <id> --evidence <text>
//                         settle a pending note as the operator: memory.noteResolve's own logic (a repeat archives the pending row,
//                         nothing is deleted). For a note whose run has ended and whose writer is gone.
// scrub and review act through the run's lever block and the run's caller identity, because the core's lifecycle writes belong to the
// caller's own run (memory.scrubApply, memory.reviewApply). `--run` names it; without it the newest live run, else the newest run.
// This file reaches src/run only inside functions (the stages), as run-memory-end.cjs does.

const C = require('./config.cjs');
const P = require('./panel-common.cjs');
const { openCore } = require('../core/index.cjs');
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
  if (o.error) lines.push(`  failed: ${o.error.code}: ${one(o.error.message)}${o.owed && o.owed.length ? `; ${o.owed.length} item(s) owed to the next scrub` : ''}`);
  else if (o.owed && o.owed.length) lines.push(`  ${o.owed.length} item(s) over the cap are owed to the next scrub`);
  return `${lines.join('\n')}\n`;
}

async function runStage(which, core, parsed, ctx, found) {
  const s = await stageCore(core, parsed, ctx, found);
  if (s.fail) return s.fail;
  if (which === 'review' && !s.project) { await release(s.rc); return { code: 1, text: 'belay memory review: the run has no project, so there is no held queue to review; pass --project <p>\n', json: { error: { code: 'E_ARGS', message: 'no project' } } }; }
  try {
    if (which === 'review' && parsed.opts.start) return await require('./review-run.cjs').launch({ core, s, project: s.project, parsed, ctx, release });
    const deps = (process.env.BELAY_TEST_MODE === '1' && ctx.stageDeps) || {};
    const CS = require('../run/close-stages.cjs');
    const h = s.rc.harness();
    const getManager = CS.lazyManager({ core: h, runId: s.runId, dataDir: s.dataDir, lv: s.lv, worktree: s.worktree, paths: deps.paths, makeManager: deps.makeManager });
    const common = { core: h, runId: s.runId, lv: s.lv, dataDir: s.dataDir, getManager, worktree: s.worktree };
    if (which === 'review') return await require('./review-run.cjs').claimedReview({ s, project: s.project, ctx, common, runReview: require('../run/review-stage.cjs').runReview, renderStage });
    const out = await require('../run/scrub-stage.cjs').runScrub({ ...common, goal: parsed.opts.goal || null, summary: parsed.opts.summary || null });
    return { code: out.error ? 1 : 0, text: renderStage(which, out), json: { run_id: s.runId, ...out } };
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
