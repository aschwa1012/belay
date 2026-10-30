'use strict';
// heavy-embed.cjs — a search's query vector on a HEAVY tier (ADR 0050 decisions 3 and 6). When the tier's embedder is a GGUF model and
// the call brought no query_embedding, the owner embeds the query through the heavy embed provider (embed-provider.cjs), with the
// model's own query prompt, under the same vector-call bound as nano's embed path. A failure is loud and is decided by the
// on_heavy_failure lever, never swallowed:
//   fallback  the search is served on the fallback profile (nano) and says so (`tier_fallback`); the rest of the run stays on it
//             (heavy-tier.cjs setFallback), so a failing GPU is not retried on every search;
//   pause     the run's ADR 0034 hook is told and the search fails with the cause, as the rerank stage's pause does.
// Nothing here loads a model itself: the provider does, in the owner only. A search outside the owner has no provider and fails by name.

const { err } = require('./errors.cjs');
const EP = require('./embed-provider.cjs');
const HT = require('./heavy-tier.cjs');
const { notifyEmbedderFailure } = require('./methods-memory.cjs');

const BOUND_MS = 100000; // the vector-call bound of nano's embed path (index.cjs EMBEDDING_READ_TIMEOUT_MS)

const coded = (e) => (e && e.code ? e : err('E_INTERNAL', `the heavy embedder failed: ${e && e.message ? e.message : String(e)}`, { gpu: true, cause: 'op_failed' }));

// -> { vec: number[], model } for the tier's embedder. Throws a coded error with detail.embedder true and detail.heavy true.
async function embedQuery(E, tier, text, boundMs = BOUND_MS) {
  if (typeof text !== 'string' || !text) throw err('E_NO_EMBEDDER', `a search on the ${tier.embedder} tier needs query text or a query_embedding`, { embedder: true, heavy: true });
  const impl = EP.get(tier, { owner: E.owner || false });
  if (!impl) throw err('E_NO_EMBEDDER', `no embedder for the ${tier.embedder} tier is available here (only the store owner loads a heavy embedder), so a search on it needs a query_embedding`, { embedder: true, heavy: true });
  let timer;
  try {
    const call = Promise.resolve().then(() => impl.embedQuery(text));
    call.catch(() => {}); // an answer that comes after the bound is not read
    const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(err('E_EMBEDDER_TIMEOUT', `the ${tier.embedder} embedder did not answer within ${boundMs} ms`, { gpu: true, cause: 'timeout', timeout_ms: boundMs })), boundMs); });
    const e = await Promise.race([call, bound]);
    return { vec: e.embedding, model: tier.embedder };
  } catch (x) {
    const e = coded(x);
    e.detail = { ...(e.detail || {}), embedder: true, heavy: true, stage: 'heavy_embed', tier_embedder: tier.embedder };
    throw e;
  } finally { clearTimeout(timer); }
}

const pauseAdvice = (caller, copy) => (caller.role === 'worker'
  ? 'Stop and wait: do not run belay commands; the operator will resume the run.'
  : caller.run_id && !copy ? `Tell the operator (belay status shows the run); fix the GPU embedder, or set on_heavy_failure to fallback, then belay resume ${caller.run_id}.` : 'Fix the GPU embedder, or set on_heavy_failure to fallback.');

// The query vector for a search on a heavy tier: { vec, model } or, when the failure fell back, { fallback: { tier, cause } } for the caller to
// re-embed on that tier. Throws (after telling the run's hook) under on_heavy_failure pause.
async function queryVector(E, caller, o, lv) {
  try { return await embedQuery(E, o.tier, o.query); } catch (e) { return failure(E, caller, o, lv, e); }
}

// A real heavy failure (an error, a dead child, a failed load) of a search on a heavy tier: on_heavy_failure decides. `pause` tells the run hook and
// throws; `fallback` records the sticky fallback on the run row and answers { fallback: { tier, cause } } for the caller to serve on nano.
function failure(E, caller, o, lv, e) {
  {
    // A stopping owner closed or never built the provider: that is not a heavy failure. This search is served on the fallback tier, with no
    // pause, no run hook and no sticky fallback written.
    if (E.owner && typeof E.owner === 'object' && E.owner.stopped) {
      const cause = { code: e.code || 'E_INTERNAL', reason: 'shutdown', message: e.message };
      return { fallback: { tier: { ...HT.FALLBACK_TIER, fallback_from: o.tier.profile, fallback_cause: cause }, cause } };
    }
    if (lv.on_heavy_failure === 'pause') {
      e.detail = { ...e.detail, advised: true };
      e.message = `${e.message} ${pauseAdvice(caller, !E.owner)}`;
      notifyEmbedderFailure(E, caller, 'memory.search', e);
      throw e;
    }
    const cause = { code: e.code || 'E_INTERNAL', reason: e.detail && e.detail.cause ? e.detail.cause : null, message: e.message };
    HT.setFallback(E, caller, cause);
    return { fallback: { tier: { ...HT.FALLBACK_TIER, fallback_from: o.tier.profile, fallback_cause: cause }, cause } };
  }
}

module.exports = { embedQuery, queryVector, failure, BOUND_MS };
