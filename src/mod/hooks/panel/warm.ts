// The run's retrieval models and each one's live state: `retrieval_models` in `belay agents --json`, read from the run row (belay's facts only).
// Pure: no `$`, no drawing. The panel never loads a GPU, rerank or embedding module (belay invariants 6 and 9); this file knows words, not models.

import type { BelayRetrievalModel } from '../../types/index'

const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const obj = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const one = (s: string, cap = 60): string => { const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); return t.length > cap ? t.slice(0, cap - 1) + '…' : t }
const STATES = ['off', 'warming', 'ready', 'failed', 'unfinished', 'fallback'] as const

export function normRetrievalModels(raw: unknown): BelayRetrievalModel[] {
  if (!Array.isArray(raw)) return []
  const out: BelayRetrievalModel[] = []
  for (const r of raw) {
    const m = obj(r)
    const role = m && (m.role === 'embedder' || m.role === 'reranker' ? m.role : null)
    const state = m && STATES.find(s => s === m.state)
    if (!m || !role || !state) continue
    const w = obj(m.warm)
    out.push({
      role, id: str(m.id) ? one(str(m.id)!) : null, state,
      warm: w ? { trigger: str(w.trigger) ? one(str(w.trigger)!, 20).replace('_', ' ') : null, ms: num(w.ms), served: num(w.served_warming) ?? 0, error: str(w.error) ? one(str(w.error)!, 80) : null } : null,
    })
  }
  return out
}

/** The name as the panel shows it: no org prefix, no -GGUF/-ONNX suffix. The full id is in the Memory menu's models list. */
export const shortModel = (id: string): string => (id.split('/').pop() ?? id).replace(/-(GGUF|ONNX)$/i, '')

type WSeg = { t: string; c?: 'success' | 'warning' | 'error'; dim?: boolean; brk?: true }
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/**
 * One row per model, the state first so a narrow pane cuts the name or the detail and never the state: `reranker warm-up ready · Qwen3-Reranker-4B`,
 * then `· warmed 2.0 s` and the searches that kept the fusion order as parts that drop whole when they do not fit (fitSegs).
 * A reranker's state is its warm-up's (it says the model was loaded, not that reranking is on). A stop is a shutdown, not a failure: unfinished is dim.
 */
export function modelRows(models: BelayRetrievalModel[]): WSeg[][] {
  return models.map((m): WSeg[] => {
    const row: WSeg[] = [{ t: `${m.role} `, dim: true }]
    if (m.state === 'off') return [...row, { t: 'off', dim: true }]
    if (m.role === 'reranker' && m.state !== 'fallback') row.push({ t: 'warm-up ', dim: true })
    const look = m.state === 'unfinished' ? { dim: true as const } : { c: m.state === 'ready' ? 'success' as const : m.state === 'failed' ? 'error' as const : 'warning' as const }
    row.push({ t: m.state === 'fallback' ? 'fallback profile' : m.state, ...look })
    if (m.id) row.push({ t: ` · ${shortModel(m.id)}`, dim: true })
    const w = m.warm
    if (w && m.state === 'ready' && w.ms !== null) row.push({ t: ` · warmed ${secs(w.ms)}`, dim: true, brk: true })
    if (w && w.served > 0) row.push({ t: ` · ${w.served} search${w.served === 1 ? '' : 'es'} kept the fusion order`, dim: true, brk: true })
    if (w && m.state === 'failed' && w.error) row.push({ t: ` · ${w.error}`, dim: true, brk: true })
    if (m.state === 'unfinished') row.push({ t: ' · the owner stopped', dim: true, brk: true })
    return row
  })
}
