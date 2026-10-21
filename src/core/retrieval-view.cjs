'use strict';
// retrieval-view.cjs — what a run's pinned retrieval routing looks like to a human (ADR 0050 decision 6: "either way the failure is in belay status,
// in the panel and in the run receipt"). Pure: it reads the run row's `retrieval_routing` JSON and requires nothing, so `belay status` and the run
// receipt may use it. describe(row) -> null for a run that pinned nothing, else { pinned_at, profile, tiers, probe, warm, notices, behind, fallback }.
// `fallback` is set only while it is in force: it belongs to the epoch it was written in, so a later epoch (a resume) shows none.

function describe(row) {
  if (!row || !row.retrieval_routing) return null;
  let p;
  try { p = typeof row.retrieval_routing === 'string' ? JSON.parse(row.retrieval_routing) : row.retrieval_routing; } catch { return null; }
  if (!p || !p.routing || !p.routing.run) return null;
  const t = (x) => ({ profile: x.profile, embedder: x.embedder, reranker: x.reranker, device: x.device });
  const fb = p.fallback && p.fallback.epoch === row.epoch ? p.fallback : null;
  return {
    pinned_at: p.pinned_at, profile: p.routing.run.profile, run: t(p.routing.run),
    tiers: Object.fromEntries(Object.entries(p.routing.tiers || {}).map(([k, x]) => [k, t(x)])),
    probe: p.probe || null, warm: p.warm || null, notices: p.notices || [], behind: p.behind || null,
    fallback: fb ? { since: fb.at, cause: fb.cause } : null,
  };
}

function lines(v) {
  if (!v) return [];
  const out = [`retrieval: profile ${v.profile} (embedder ${v.run.embedder}, reranker ${v.run.reranker || 'none'}); pinned at run start`];
  for (const n of v.notices) out.push(`retrieval notice (${n.code}): ${n.message}`);
  if (v.behind && v.behind.choice) out.push(`retrieval: ${v.behind.embedders.map((b) => `${b.embedder} was ${b.rows} behind`).join('; ')}; on_heavy_behind ${v.behind.choice}`);
  if (v.fallback) out.push(`WARNING retrieval: the heavy tier failed and the run is served on the fallback profile (${v.fallback.cause.code}: ${v.fallback.cause.message}); fix it and resume, or drain with belay memory embed --model <id>`);
  return out;
}

module.exports = { describe, lines };
