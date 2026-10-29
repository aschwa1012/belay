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

const short = (id: string): string => { const t = id.split('/').pop() ?? id; return t.replace(/-GGUF$/i, '') }

/** The segments of the one line: `models  embedder <name> ready · reranker <name> warming`. A finished warm-up adds its time, an error its words. */
export function modelSegs(models: BelayRetrievalModel[]): { t: string; c?: 'success' | 'warning' | 'error'; dim?: boolean }[] {
  const segs: { t: string; c?: 'success' | 'warning' | 'error'; dim?: boolean }[] = []
  models.forEach((m, i) => {
    segs.push({ t: i ? '   ' : 'models ', dim: true }, { t: `${m.role} `, dim: true })
    if (m.state === 'off') { segs.push({ t: 'off', dim: true }); return }
    segs.push({ t: `${m.id ? short(m.id) : ''} `.trimStart() })
    // A reranker's state is its warm-up's (it says the model was loaded, not that reranking is on), so it says so.
    if (m.role === 'reranker' && m.state !== 'fallback') segs.push({ t: 'warm-up ', dim: true })
    // A stop is a shutdown, not a failure: an unfinished warm-up is dim, not error-coloured.
    const look = m.state === 'unfinished' ? { dim: true } : { c: m.state === 'ready' ? 'success' as const : m.state === 'failed' ? 'error' as const : 'warning' as const }
    segs.push({ t: m.state === 'fallback' ? 'fallback profile' : m.state === 'unfinished' ? 'unfinished (the owner stopped)' : m.state, ...look })
    const w = m.warm
    if (w && m.state === 'ready' && w.ms !== null) segs.push({ t: ` (warmed in ${w.ms} ms${w.served ? `; ${w.served} search${w.served === 1 ? '' : 'es'} kept the fusion order meanwhile` : ''})`, dim: true })
    if (w && m.state === 'failed') segs.push({ t: w.error ? ` (${w.error})` : '', dim: true })
  })
  return segs
}
