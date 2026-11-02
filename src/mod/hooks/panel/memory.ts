// The Memory menu's model: `belay memory menu --json` in, plain facts out, and the rules the menu keeps (the routing's fit, the routing draft, the
// one allowed argv per write). Pure: no `$`, no drawing. Everything is read defensively; a field that is missing or the wrong type becomes null.
// The panel reads belay's facts and never loads a GPU, rerank or embedding module (belay invariants 6 and 9): this file knows tables, not models.

import type { BelayMenu, BelayMenuModel, BelayMenuProfile, BelayRouteDraft, BelayRoutePick } from '../../types/index'

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const obj = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const strs = (x: unknown): string[] => arr(x).filter((s): s is string => typeof s === 'string')
const one = (s: string, cap = 120): string => { const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); return t.length > cap ? t.slice(0, cap - 1) + '…' : t }

export const MEM_TABS = ['profiles', 'routing', 'models'] as const
// Cycling picks, not free text: the preset values of the two numeric levers. belay settings still judges the value.
export const DEPTH_PRESETS = [10, 25, 50, 100, 200]
export const CAP_PRESETS = [100, 250, 500, 1000, 5000]

function pickOf(x: unknown): BelayRoutePick {
  if (typeof x === 'string') return x
  const o = obj(x)
  if (o && typeof o.embedder === 'string') return { embedder: o.embedder, ...(typeof o.reranker === 'string' ? { reranker: o.reranker } : {}) }
  return null
}
function mapOf<T>(x: unknown, f: (v: unknown) => T): Record<string, T> | null {
  const o = obj(x)
  if (!o) return null
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(o)) out[one(k, 32)] = f(v)
  return Object.keys(out).length ? out : null
}

function normModel(raw: unknown): BelayMenuModel | null {
  const m = obj(raw)
  const id = m && str(m.id)
  if (!m || !id) return null
  const kind = m.kind === 'reranker' ? 'reranker' : 'embedder'
  return {
    id, kind, runtime: m.runtime === 'gguf' ? 'gguf' : 'onnx', device: m.device === 'gpu' ? 'gpu' : 'cpu', label: one(str(m.label) ?? id, 60),
    bytes: num(m.bytes) ?? 0, vramMb: num(m.vram_mb), vramSource: str(m.vram_source), state: m.state === 'ready' ? 'ready' : 'download',
    inUse: m.in_use === true, inUseBy: strs(m.in_use_by).map(s => one(s, 40)), heavy: m.heavy === true, backlog: num(m.backlog),
  }
}
function normProfile(raw: unknown): BelayMenuProfile | null {
  const p = obj(raw)
  const name = p && str(p.name)
  const embedder = p && str(p.embedder)
  if (!p || !name || !embedder) return null
  return { name, embedder, reranker: str(p.reranker), device: p.device === 'gpu' ? 'gpu' : 'cpu', embedderLabel: one(str(p.embedder_label) ?? embedder, 50), rerankerLabel: one(str(p.reranker_label) ?? 'none', 50), timeS: num(p.time_s) ?? 0, vramMb: num(p.vram_mb) ?? 0 }
}

export function normMenu(json: unknown): BelayMenu | null {
  const j = obj(json)
  const lv = j && obj(j.levers)
  const g = j && obj(j.gpu)
  if (!j || !lv || !g || j.v !== 1) return null
  const rt = obj(g.runtime)
  const types = obj(j.agent_types)
  const models = arr(j.models).map(normModel).filter((m): m is BelayMenuModel => m !== null)
  const profiles = arr(j.profiles).map(normProfile).filter((p): p is BelayMenuProfile => p !== null)
  if (!models.length || !profiles.length) return null
  const disk = obj(j.disk)
  return {
    project: str(j.project),
    gpu: {
      state: g.state === 'probed' ? 'probed' : 'not_probed', device: str(g.device) ? one(str(g.device)!, 60) : null, freeMb: num(g.free_mb), totalMb: num(g.total_mb),
      ok: typeof g.ok === 'boolean' ? g.ok : null, reason: str(g.reason), at: str(g.at), runtimeInstalled: rt?.installed === true, runtimeOk: rt?.ok === true,
      runtimeCommand: one(str(rt?.command) ?? 'belay embedder fetch --gpu', 80),
    },
    levers: {
      profile: str(lv.profile) ?? 'cpu-fast', profileCpu: str(lv.profile_cpu) ?? 'cpu-fast', onHeavyFailure: str(lv.on_heavy_failure) ?? 'fallback', onHeavyBehind: str(lv.on_heavy_behind) ?? 'wait',
      rerankDepth: num(lv.rerank_depth) ?? 50, searchLog: lv.search_log === true, searchLogCapMb: num(lv.search_log_cap_mb) ?? 500, routing: mapOf(lv.routing, pickOf), routingCpu: mapOf(lv.routing_cpu, v => str(v)),
    },
    headroomMb: num(j.headroom_mb) ?? 768, profiles, models,
    mainTypes: strs(types?.main).map(s => one(s, 32)), advancedTypes: strs(types?.advanced).map(s => one(s, 32)),
    selectedEmbedder: str(j.selected_embedder), behind: num(j.behind) ?? 0, backlogReason: str(j.backlog_reason) ? one(str(j.backlog_reason)!, 80) : null,
    diskBytes: num(disk?.bytes) ?? 0, diskModels: num(disk?.models) ?? 0,
  }
}

// The main page badge: a number only when the CURRENTLY selected embedder (belay says which) has notes behind it. `belay memory menu --badge` and the
// full menu both give `behind`; the badge state keeps whichever was read last.
export const badgeOf = (s: { behind: number } | null): number => (s && s.behind > 0 ? s.behind : 0)
export function normBadge(json: unknown): number | null {
  const j = obj(json)
  return j && j.v === 1 && j.badge === true && num(j.behind) !== null ? Math.max(0, num(j.behind)!) : null
}

// ---- figures ------------------------------------------------------------------------------------

export const gb = (mb: number): string => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`
export const bytesText = (b: number): string => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`)
export const secs = (s: number): string => (s <= 0 ? 'no extra time' : `~${s} s`)

export const profileByName = (m: BelayMenu, name: string): BelayMenuProfile | null => m.profiles.find(p => p.name === name) ?? null
export const modelById = (m: BelayMenu, id: string): BelayMenuModel | null => m.models.find(x => x.id === id) ?? null

// One profile as the picker row's text: models, extra time and VRAM.
export function profileText(p: BelayMenuProfile): string {
  const models = p.reranker ? `${p.embedderLabel} + ${p.rerankerLabel}` : `${p.embedderLabel}, no reranker`
  // The cost is one unit for the wrap (no-break spaces): a profile line breaks between its name, its models and its cost, never inside the cost.
  const cost = `${secs(p.timeS)}  ${p.vramMb > 0 ? gb(p.vramMb) : 'no VRAM'}`.replace(/ /g, '\u00a0')
  return `${p.name}  ${models}  ${cost}`
}

// ---- routing ------------------------------------------------------------------------------------

export const gpuOptions = (m: BelayMenu): (string | null)[] => [null, ...m.profiles.map(p => p.name)]
export const cpuOptions = (m: BelayMenu): (string | null)[] => [null, ...m.profiles.filter(p => p.device === 'cpu').map(p => p.name)]

// The saved routing as a draft to edit.
export function draftOf(m: BelayMenu): BelayRouteDraft {
  return { gpu: { ...(m.levers.routing ?? {}) }, cpu: { ...(m.levers.routingCpu ?? {}) } }
}

// The next option after a pick, wrapping: "run default" (null) is first. A custom pair is not in the list, so a press takes it to "run default".
export function nextPick<T extends BelayRoutePick>(opts: (string | null)[], cur: T | undefined): string | null {
  const i = typeof cur === 'string' ? opts.indexOf(cur) : cur === null || cur === undefined ? 0 : -1
  return opts[(i + 1) % opts.length] ?? null
}

export function cycleDraft(m: BelayMenu, d: BelayRouteDraft, side: 'gpu' | 'cpu', type: string): BelayRouteDraft {
  if (side === 'gpu') return { ...d, gpu: { ...d.gpu, [type]: nextPick(gpuOptions(m), d.gpu[type]) } }
  return { ...d, cpu: { ...d.cpu, [type]: nextPick(cpuOptions(m), d.cpu[type]) } }
}

// What the draft writes: a null pick is no entry; an empty map is null (the lever's own "no routing").
export function draftMaps(d: BelayRouteDraft): { routing: Record<string, BelayRoutePick> | null; routingCpu: Record<string, string> | null } {
  const routing: Record<string, BelayRoutePick> = {}
  for (const [k, v] of Object.entries(d.gpu)) if (v !== null && v !== undefined) routing[k] = v
  const routingCpu: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.cpu)) if (typeof v === 'string') routingCpu[k] = v
  return { routing: Object.keys(routing).length ? routing : null, routingCpu: Object.keys(routingCpu).length ? routingCpu : null }
}
export const sameDraft = (m: BelayMenu, d: BelayRouteDraft): boolean => {
  const a = draftMaps(d), b = draftMaps(draftOf(m))
  return JSON.stringify(a) === JSON.stringify(b)
}

function pairIds(m: BelayMenu, pick: BelayRoutePick | undefined): string[] {
  if (pick === null || pick === undefined) return []
  if (typeof pick === 'string') { const p = profileByName(m, pick); return p ? [p.embedder, ...(p.reranker ? [p.reranker] : [])] : [] }
  return [pick.embedder, ...(pick.reranker && pick.reranker !== 'none' ? [pick.reranker] : [])]
}

export type Fit = { models: { id: string; label: string; mb: number }[]; sumMb: number; needMb: number; freeMb: number | null; ok: boolean | null }

// The GPU models the routing loads together: the run's profile (what an unset type takes, and what the first-message index takes) and every GPU pick.
// Each counts once, at its measured peak when probed and the reference figure otherwise (belay's `vram_mb`). The same rule as resolveRouting's gpu_models.
// ok is null while the GPU has not been probed (the free memory is unknown): nothing is refused on a guess, and the probe at run start still decides.
export function routeFit(m: BelayMenu, d: BelayRouteDraft): Fit {
  const ids = new Set<string>(pairIds(m, m.levers.profile))
  for (const pick of Object.values(d.gpu)) for (const id of pairIds(m, pick)) ids.add(id)
  const models = [...ids].map(id => modelById(m, id)).filter((x): x is BelayMenuModel => x !== null && x.device === 'gpu').map(x => ({ id: x.id, label: x.label, mb: x.vramMb ?? 0 }))
  const sumMb = models.reduce((n, x) => n + x.mb, 0)
  const needMb = models.length ? sumMb + m.headroomMb : 0
  const freeMb = m.gpu.state === 'probed' ? m.gpu.freeMb : null
  return { models, sumMb, needMb, freeMb, ok: !models.length ? true : freeMb === null ? null : needMb <= freeMb }
}

// ---- the commands -------------------------------------------------------------------------------

export type MemAction =
  | { kind: 'tab'; tab: 'main' | 'profiles' | 'routing' | 'models' }
  | { kind: 'cycle'; side: 'gpu' | 'cpu'; type: string }
  | { kind: 'cmd'; line: string }
  | { kind: 'refresh' }
  | { kind: 'set'; key: string; value: string }
  | { kind: 'setMany'; pairs: [string, string][] }
  | { kind: 'verify'; model: string | null }
  | { kind: 'delete'; model: string }
  | { kind: 'saveRouting' }

// The only settings keys the menu writes, and the only commands: belay settings <key> <value>, belay embedder verify, belay embedder delete.
export const SETTABLE = ['memory.profile', 'memory.profile_cpu', 'memory.on_heavy_failure', 'memory.on_heavy_behind', 'memory.rerank_depth', 'memory.search_log', 'memory.search_log_cap_mb', 'memory.routing', 'memory.routing_cpu']
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

// The argv (after the belay CLI) a confirmed write runs, or why it is refused. A model must be one the menu lists.
export function writeArgv(a: MemAction, m: BelayMenu): string[][] | { error: string } {
  if (a.kind === 'set') {
    if (!SETTABLE.includes(a.key)) return { error: `${a.key} is not a setting the Memory menu writes` }
    if (a.value === '' || a.value.length > 2000 || /[\u0000-\u001f]/.test(a.value)) return { error: 'that value cannot be written' }
    return [['settings', a.key, a.value]]
  }
  if (a.kind === 'setMany') {
    if (!a.pairs.length || a.pairs.length > 4) return { error: 'that is not a set of settings the menu writes' }
    const argv = ['settings']
    for (const [k, v] of a.pairs) {
      if (!SETTABLE.includes(k) || v === '' || v.length > 2000 || /[\u0000-\u001f]/.test(v)) return { error: `${k} is not a setting the Memory menu writes, or its value cannot be written` }
      argv.push('--set', k, v)
    }
    return [argv]
  }
  if (a.kind === 'verify' || a.kind === 'delete') {
    if (a.kind === 'verify' && a.model === null) return [['embedder', 'verify', '--gpu']]
    const id = a.model
    const row = id !== null && MODEL_ID.test(id) ? modelById(m, id) : null
    if (!row) return { error: `${id ?? '?'} is not a model of the menu` }
    if (a.kind === 'delete') return [['embedder', 'delete', row.id]]
    return [['embedder', 'verify', ...fetchFlags(row)]]
  }
  if (a.kind === 'saveRouting') return { error: 'a routing is saved through its two settings' }
  return { error: 'that action writes nothing' }
}

// The routing save: both settings in ONE `belay settings --set k v --set k v` call, which validates both before writing either and writes the file once
// (the GPU picks, then the CPU picks; null clears the lever). A refusal of either writes neither.
export function routingWrites(d: BelayRouteDraft): MemAction {
  const x = draftMaps(d)
  return { kind: 'setMany', pairs: [['memory.routing', x.routing === null ? 'null' : JSON.stringify(x.routing)], ['memory.routing_cpu', x.routingCpu === null ? 'null' : JSON.stringify(x.routingCpu)]] }
}

// The flags that name a model to `belay embedder fetch|verify`.
export const fetchFlags = (r: BelayMenuModel): string[] => (r.runtime === 'gguf' ? ['--gpu', '--model', r.id] : r.kind === 'reranker' ? ['--reranker', r.id] : r.id === 'onnx-community/voyage-4-nano-ONNX' ? [] : ['--model', r.id])

// Commands too long to run from a panel that a reload ends: the person runs them, and the menu prints each exactly.
export const fetchLine = (r: BelayMenuModel): string => `belay embedder fetch${fetchFlags(r).map(f => ` ${f}`).join('')}`
export const runtimeLine = (m: BelayMenu): string => m.gpu.runtimeCommand
export const embedLine = (m: BelayMenu, r: BelayMenuModel): string => `belay memory embed --model ${r.id}${m.project ? ` --project ${m.project}` : ' --project <p>'}`
// The probe runs inside a GPU model's load, so the nearest command is the first heavy embedder that is fetched (it probes, then embeds its backlog).
export function probeLine(m: BelayMenu): string {
  const h = m.models.find(x => x.heavy && x.state === 'ready')
  if (!h) return `${runtimeLine(m)}  then  belay embedder fetch --gpu --model ${m.models.find(x => x.heavy)?.id ?? '<id>'}`
  return embedLine(m, h)
}

// What a finished command says, as one toast line: a settings receipt (`old -> new`), an embedder receipt, or the refusal's first line.
export function resultLine(a: MemAction, exitCode: number, stdout: string, stderr: string): string {
  let j: Record<string, unknown> | null = null
  try { j = obj(JSON.parse(stdout)) } catch { j = null }
  const said = (): string => {
    const e = j && (typeof j.error === 'string' ? j.error : obj(j.error) && typeof obj(j.error)!.message === 'string' ? (obj(j.error)!.message as string) : null)
    return one(e ?? ((stdout.trim() ? stdout : stderr).split('\n').map(l => l.trim()).find(l => l !== '') ?? 'no answer'), 160)
  }
  if (a.kind === 'set') {
    if (exitCode === 0 && j && typeof j.key === 'string') return `belay: ${a.key} set to ${a.value} (was ${JSON.stringify(obj(j.old)?.value ?? null)})`
    return `belay: ${a.key} was not written: ${said()}`
  }
  if (a.kind === 'setMany') return exitCode === 0 && j && Array.isArray(j.keys) ? `belay: ${a.pairs.map(p => p[0]).join(' and ')} saved` : `belay: nothing was written: ${said()}`
  if (a.kind === 'verify') return exitCode === 0 && j && j.verified === true ? `belay: ${a.model ?? 'the GPU runtime'} verified` : `belay: verify of ${a.model ?? 'the GPU runtime'} failed: ${said()}`
  if (a.kind === 'delete') return exitCode === 0 && j && j.removed === true ? `belay: ${a.model} removed (${bytesText(num(j.bytes) ?? 0)})` : `belay: ${a.model} was not removed: ${said()}`
  return `belay: ${said()}`
}

// A stable id for a confirmed action, and the line the confirm shows.
export const actionId = (a: MemAction): string => (a.kind === 'set' ? `set:${a.key}:${a.value}` : a.kind === 'setMany' ? `setMany:${a.pairs.map(p => p[0]).join(',')}` : a.kind === 'verify' ? `verify:${a.model ?? 'runtime'}` : a.kind === 'delete' ? `delete:${a.model}` : a.kind)
export function confirmText(a: MemAction, m: BelayMenu | null): string {
  if (a.kind === 'set') return `set ${a.key} to ${a.key === 'memory.routing' || a.key === 'memory.routing_cpu' ? 'the new routing' : a.value}`
  if (a.kind === 'verify') return `hash ${a.model ?? 'the GPU runtime'} against its table (reads the whole model)`
  if (a.kind === 'delete') return `delete ${a.model} from belay's model cache${m ? ` (${bytesText(modelById(m, a.model)?.bytes ?? 0)})` : ''}`
  if (a.kind === 'setMany') return 'save the routing (memory.routing and memory.routing_cpu)'
  if (a.kind === 'saveRouting') return 'save the routing (memory.routing and memory.routing_cpu)'
  return a.kind
}
