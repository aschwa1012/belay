'use strict';
// heavy-behind.cjs — a pinned run's heavy tier found BEHIND mid-run (ADR 0050 decision 4: "wait or fall back, never a hard failure mid-run").
// Rows can reach the run's scope without passing through the run's own write path: an operator's import, promote or restore, another run or a
// memory job on the same project, rows left behind across a resume. When a search on a pinned run's heavy tier finds such rows:
//   1. it embeds them INLINE, within a short bound (2,000 ms by default, inside the search's own budget);
//   2. all embedded within the bound: the search is served on the heavy tier;
//   3. not all: THIS search is served on nano, loudly (`tier_fallback: { cause: 'behind', behind: n }`, a modes_failed entry and the warning), and
//      ONE background catch-up drain starts for that run and embedder (single-flight, bounded, owner only, ended at the owner's stop). This is NOT a
//      heavy failure and NOT sticky: later searches serve heavy again once caught up;
//   4. a real embed FAILURE (an error, a dead child, a failed load) is a heavy failure: on_heavy_failure applies (sticky fallback, or pause);
//   5. a search outside a pinned run (no run, a scope the run does not own, a copy) keeps E_TIER_BEHIND by name: it is not mid-run.
// Owner only; it requires the heavy modules lazily, so no read path loads a GPU module.

const HT = require('./heavy-tier.cjs');
const RP = require('./retrieval-profiles.cjs');
const rows = require('./rows.cjs');

let inlineBoundMs = 2000;
const CATCHUP_PASS_MS = 5000;
const CATCHUP_TOTAL_MS = 300000;
function setTestOptions(o) { if (process.env.BELAY_TEST_MODE !== '1') throw new Error('setTestOptions is a test seam'); inlineBoundMs = (o && o.inlineBoundMs) || 2000; }

const scopeOfRun = (E, runId) => require('./retrieval-pin.cjs').scopeOf(rows.current(E.store, 'run', runId));

// Whether this search is mid-run on a pinned heavy tier whose scope the run owns.
function eligible(E, caller, o) {
  if (!E.owner || !caller || !caller.run_id || !o.tier || o.tier.embedder === RP.NANO || o.tier.source === 'fallback') return false;
  if (!HT.pinOf(E, caller.run_id) || HT.fallbackOf(E, caller.run_id)) return false;
  const scope = new Set(scopeOfRun(E, caller.run_id));
  return o.namespaces.length > 0 && o.namespaces.every((n) => scope.has(n));
}

// Runs `fn`; an E_TIER_BEHIND from it is handled here for an eligible search (the tier on `o` may be swapped), then `fn` runs once more.
async function guard(E, caller, o, lv, fn) {
  try { return await fn(); } catch (e) {
    if (!(e && e.code === 'E_TIER_BEHIND') || !eligible(E, caller, o)) throw e;
    await handle(E, caller, o, lv);
    return fn();
  }
}

async function handle(E, caller, o, lv) {
  const HD = require('./heavy-drain.cjs'), HE = require('./heavy-embed.cjs'), EP = require('./embed-provider.cjs');
  const embedder = o.tier.embedder, namespaces = o.namespaces;
  const missing = HD.backlogOf(E, embedder, namespaces);
  if (!missing.length) return; // caught up meanwhile
  const bound = Math.max(1, Math.min(inlineBoundMs, require('./search-tier.cjs').boundFor(inlineBoundMs, o.t0 || Date.now())));
  const deadline = Date.now() + bound;
  try {
    const key = HD.keyOfModel(embedder), impl = EP.get({ embedder }, { owner: E.owner });
    if (!impl) throw Object.assign(new Error(`no embed provider for ${embedder}`), { code: 'E_NO_EMBEDDER', detail: { gpu: true, cause: 'absent' } });
    const ids = missing.map((r) => r.id);
    for (let i = 0; i < ids.length && Date.now() < deadline; i += 16) await HD.embedIds(E, key, impl, ids.slice(i, i + 16), { deadline });
  } catch (e) { // a real failure, not a deadline: on_heavy_failure decides
    e.detail = { ...(e.detail || {}), embedder: true, heavy: true, stage: 'heavy_embed', tier_embedder: embedder };
    const f = HE.failure(E, caller, o, lv, e);
    o.tier = f.fallback.tier; o.tierFallback = f.fallback;
    return;
  }
  const left = HD.backlogOf(E, embedder, namespaces).length;
  if (!left) return; // all embedded within the bound: serve heavy
  startCatchUp(E, caller, embedder, namespaces);
  const message = `${left} note${left === 1 ? ' is' : 's are'} not yet embedded by ${embedder} (written outside this run's own writes), so this search is served on the ${RP.FALLBACK_PROFILE} profile; a background catch-up is embedding them and later searches serve the heavy tier again`;
  o.tier = { ...HT.FALLBACK_TIER, source: 'behind', fallback_from: o.tier.profile };
  o.tierFallback = { cause: { code: 'E_TIER_BEHIND', reason: 'behind', message }, behind: left };
}

// ONE background drain per (run, embedder), in the owner: bounded, ended at the owner's stop, never throwing. A real failure of it is a heavy failure.
function startCatchUp(E, caller, embedder, namespaces) {
  const owner = E.owner;
  const map = owner.catchUps || (owner.catchUps = new Map());
  const k = `${caller.run_id}\u0000${embedder}`;
  if (map.has(k)) return map.get(k);
  const HD = require('./heavy-drain.cjs');
  const p = (async () => {
    const t0 = Date.now();
    try {
      while (!owner.stopped && !owner.catchUpsCancelled && Date.now() - t0 < CATCHUP_TOTAL_MS) {
        const r = await HD.drainHeavy(E, embedder, { namespaces, boundMs: CATCHUP_PASS_MS });
        if (r.done || r.written === 0) break;
      }
    } catch (e) {
      if (!owner.stopped && !owner.catchUpsCancelled) require('./heavy-notes.cjs').policy(E, caller, 'memory.search', { embedder, code: e && e.code, message: e && e.message, cause: e && e.detail && e.detail.cause });
    } finally { map.delete(k); }
  })();
  map.set(k, p);
  return p;
}

// Every catch-up of this owner has finished (a test seam, and the owner's stop).
const idle = (owner) => Promise.allSettled([...((owner && owner.catchUps) || new Map()).values()]);
async function cancel(owner, boundMs = 3000) {
  if (!owner) return;
  owner.catchUpsCancelled = true;
  let timer;
  try { await Promise.race([idle(owner), new Promise((r) => { timer = setTimeout(r, boundMs); })]); } finally { clearTimeout(timer); }
}

// What a served-on-fallback answer says: the failed-mode entry and the answer's tier_fallback.
function failedEntry(tierFb, tier) {
  return tierFb.behind !== undefined
    ? { mode: 'heavy_behind', code: 'E_TIER_BEHIND', message: tierFb.cause.message }
    : { mode: 'heavy_embed', code: tierFb.cause.code, message: `the heavy tier failed (${tierFb.cause.message}); this search and the rest of the run are served on the ${tier.profile} profile` };
}
function answerOf(tierFb, tier) {
  return tierFb.behind !== undefined
    ? { to: tier.profile, from: tier.fallback_from || null, cause: 'behind', behind: tierFb.behind, message: tierFb.cause.message }
    : { to: tier.profile, from: tier.fallback_from || null, cause: tierFb.cause };
}

module.exports = { guard, handle, startCatchUp, idle, cancel, failedEntry, answerOf, setTestOptions };
