'use strict';
// retrieval-view.cjs — what a run's pinned retrieval routing looks like to a human (ADR 0050 decision 6: "either way the failure is in belay status,
// in the panel and in the run receipt"). Pure: it reads the run row's `retrieval_routing` JSON and requires nothing, so `belay status` and the run
// receipt may use it. describe(row) -> null for a run that pinned nothing, else { pinned_at, profile, tiers, probe, warm, warmups, notices, behind, fallback }.
// `fallback` is set only while it is in force: it belongs to the epoch it was written in, so a later epoch (a resume) shows none.

// `owner` is what the reader knows of the store owner now (core.ownerInfo(): { pid, created?, alive } or null for none); leave it out when unknown.
const unserved = (row, owner, w) => row.ended_at != null || (owner !== undefined && (!owner || owner.alive === false || (w.owner_pid != null && owner.pid !== w.owner_pid) || (w.owner_created != null && owner.created != null && owner.created !== w.owner_created)));

function describe(row, owner) {
  if (!row || !row.retrieval_routing) return null;
  let p;
  try { p = typeof row.retrieval_routing === 'string' ? JSON.parse(row.retrieval_routing) : row.retrieval_routing; } catch { return null; }
  if (!p || !p.routing || !p.routing.run) return null;
  const t = (x) => ({ profile: x.profile, embedder: x.embedder, reranker: x.reranker, device: x.device });
  // An owner that stopped mid warm-up never wrote its end: a 'loading' record is unfinished (a shutdown, not a failure) when the run ended or the
  // owner that wrote it no longer serves (none now, not alive, another pid, or the same pid created at another time).
  const fb = p.fallback && p.fallback.epoch === row.epoch ? p.fallback : null;
  return {
    pinned_at: p.pinned_at, profile: p.routing.run.profile, run: t(p.routing.run),
    tiers: Object.fromEntries(Object.entries(p.routing.tiers || {}).map(([k, x]) => [k, t(x)])),
    probe: p.probe || null, warm: p.warm || null, warmups: (Array.isArray(p.warmups) ? p.warmups : []).map((w) => (w.state === 'loading' && unserved(row, owner, w) ? { ...w, state: 'unfinished' } : w)), notices: p.notices || [], behind: p.behind || null,
    fallback: fb ? { since: fb.at, cause: fb.cause } : null,
  };
}

// One short line per reranker that has a warm-up record: its newest. While warming it says so; once done it gives the time, the trigger and how many
// searches kept the fusion order meanwhile. A fact for the reader; nothing wakes anyone.
function warmLines(v) {
  const newest = new Map();
  for (const w of v.warmups || []) if (!newest.has(w.model) || w.started_at >= newest.get(w.model).started_at) newest.set(w.model, w);
  const out = [];
  for (const w of newest.values()) {
    const n = w.served_warming || 0, kept = n ? `; ${n} search${n === 1 ? '' : 'es'} kept the fusion order meanwhile` : '';
    if (w.state === 'loading') out.push(`retrieval: reranker ${w.model} is warming (${w.trigger.replace('_', ' ')})`);
    else if (w.state === 'unfinished') out.push(`retrieval: reranker ${w.model} warm-up did not finish: the owner that started it stopped (${w.trigger.replace('_', ' ')})`);
    else if (w.state === 'failed') out.push(`retrieval: reranker ${w.model} warm-up failed after ${w.ms} ms (${w.trigger.replace('_', ' ')}): ${w.error || 'no reason recorded'}${kept}`);
    else out.push(`retrieval: reranker ${w.model} warmed in ${w.ms} ms (${w.trigger.replace('_', ' ')})${kept}`);
  }
  return out;
}

// The pinned models and each one's state, from the row alone: [{ role, id, state: 'off' | 'warming' | 'ready' | 'failed' | 'unfinished' | 'fallback', warm }].
// 'fallback' is the row's own fact that the heavy tier failed and the run is served on the fallback profile, for both models. Otherwise an
// embedder is 'ready' once the pin warmed it, and a reranker's state is its NEWEST WARM-UP's ('ready' when the pin warmed it): it says the model
// was loaded, not that reranking is on. A dead GPU child or the in-memory sticky rerank fallback are not on the row, so they are not shown here
// (the panel labels the value as the warm-up's). 'off' when the profile pins no reranker.
function models(v) {
  if (!v) return [];
  const out = [{ role: 'embedder', id: v.run.embedder, state: v.fallback ? 'fallback' : 'ready', warm: null }];
  const rr = v.run.reranker;
  if (!rr) return [...out, { role: 'reranker', id: null, state: 'off', warm: null }];
  const mine = (v.warmups || []).filter((w) => w.model === rr).sort((a, b) => a.started_at - b.started_at);
  const last = mine[mine.length - 1] || null;
  const state = v.fallback ? 'fallback' : !last ? 'ready' : last.state === 'loading' ? 'warming' : last.state;
  return [...out, { role: 'reranker', id: rr, state, warm: last ? { trigger: last.trigger, ms: last.ms === undefined ? null : last.ms, served_warming: last.served_warming || 0, error: last.error || null } : null }];
}

function lines(v) {
  if (!v) return [];
  const out = [`retrieval: profile ${v.profile} (embedder ${v.run.embedder}, reranker ${v.run.reranker || 'none'}); pinned at run start`];
  for (const n of v.notices) out.push(`retrieval notice (${n.code}): ${n.message}`);
  if (v.behind && v.behind.choice) out.push(`retrieval: ${v.behind.embedders.map((b) => `${b.embedder} was ${b.rows} behind`).join('; ')}; on_heavy_behind ${v.behind.choice}`);
  out.push(...warmLines(v));
  if (v.fallback) out.push(`WARNING retrieval: the heavy tier failed and the run is served on the fallback profile (${v.fallback.cause.code}: ${v.fallback.cause.message}); fix it and resume, or drain with belay memory embed --model <id>`);
  return out;
}

module.exports = { describe, lines, models };
