'use strict';
// rerank-stage.cjs — the rerank stage of a search (ADR 0050 decision 5). After fusion, the top `depth` candidates are scored by the
// tier's reranker provider (rerank-provider.cjs) and reordered by score; a row's fusion rank is the tiebreak, and the caller cuts to
// the page afterwards. The stage runs inside its own bound. Every way it can fail, an absent provider, a timeout, a thrown error and
// an answer that does not score every document, raises E_RERANK with `detail.reason`; whether that falls back to the fusion order or
// pauses the run is the caller's decision (search-tier.cjs), never made silently here.

const { err } = require('./errors.cjs');
const provider = require('./rerank-provider.cjs');

const fail = (reason, message, more) => err('E_RERANK', `the rerank stage failed (${reason}): ${message}`, { reason, stage: 'rerank', embedder: true, ...more });

// ranked: [{ id, ... }] best first. textOf(id) -> the text to score, or null when the row is gone.
// Returns { ranked: the head reordered then the untouched rest, info: { ran: true, model, device, ms, depth, reranked } }.
async function rerank({ tier, query, ranked, textOf, depth, boundMs, owner }) {
  if (typeof query !== 'string' || !query) throw fail('no_query', 'a rerank needs the query text, and this search was given only a vector');
  const impl = provider.get(tier, { owner: owner === true });
  if (!impl) throw fail('absent', `no rerank provider is registered for ${tier.reranker}`, { reranker: tier.reranker });
  const head = ranked.slice(0, depth);
  const docs = [];
  for (const h of head) { const text = textOf(h.id); if (typeof text === 'string') docs.push({ id: h.id, text }); }
  if (!docs.length) return { ranked, info: { ran: true, model: tier.reranker, device: tier.device, ms: 0, depth, reranked: 0 } };
  let timer;
  const t0 = Date.now();
  let answer;
  try {
    const call = Promise.resolve().then(() => impl.rerank({ query, docs, depth, boundMs }));
    call.catch(() => {}); // an answer that comes after the bound is not read
    const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('timeout', `the reranker did not answer within ${boundMs} ms`, { bound_ms: boundMs })), boundMs); });
    answer = await Promise.race([call, bound]);
  } catch (e) {
    if (e && e.code === 'E_RERANK') throw e;
    throw fail('error', `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`, { cause: e && e.code ? e.code : null });
  } finally { clearTimeout(timer); }
  const list = answer && Array.isArray(answer.scores) ? answer.scores : null;
  if (!list) throw fail('malformed', 'the provider answered without a scores list');
  const byId = new Map();
  for (const s of list) if (s && typeof s.id === 'string' && Number.isFinite(s.score)) byId.set(s.id, s.score);
  const missing = docs.filter(d => !byId.has(d.id)).length;
  if (missing) throw fail('malformed', `the provider scored ${docs.length - missing} of ${docs.length} documents`);
  const pos = new Map(head.map((h, i) => [h.id, i]));
  // A document that could not be rendered (its row vanished) has no score and keeps its fusion place behind the scored ones.
  const sc = h => (byId.has(h.id) ? byId.get(h.id) : -Infinity);
  const order = head.slice().sort((a, b) => (sc(a) === sc(b) ? pos.get(a.id) - pos.get(b.id) : sc(b) > sc(a) ? 1 : -1));
  const out = order.map(h => (byId.has(h.id) ? { ...h, rerank_score: byId.get(h.id) } : h));
  return {
    ranked: [...out, ...ranked.slice(depth)],
    info: { ran: true, model: answer.model || tier.reranker, device: answer.device || tier.device, ms: Number.isFinite(answer.ms) ? answer.ms : Date.now() - t0, depth, reranked: docs.length, ...(answer.warnings && answer.warnings.length ? { warnings: answer.warnings } : {}) },
  };
}

module.exports = { rerank };
