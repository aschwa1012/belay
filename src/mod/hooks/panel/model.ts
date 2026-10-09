// The panel's model: belay's JSON in, plain facts out. Pure; no `$`, no drawing. Everything is read
// defensively. A field that is missing or the wrong type becomes null and its column hides or falls
// back, and nothing here invents a value (belay invariant 4: every fact names what established it).

import type {
  BelayAgent, BelayCache, BelayDisplayState, BelayEntry, BelayNotice, BelayPanelFooter, BelayPanelSnap,
  BelayPanelUi, BelaySettings,
} from '../../types/index'
import { cells, clipCells } from './wrap'

// `brk` marks the first segment of a part that may be dropped whole when the line is too wide (fitSegs).
export type Seg = { t: string; c?: string; dim?: boolean; bold?: boolean; brk?: true }

export const DEFAULT_SETTINGS: BelaySettings = {
  pane: 'docked', marks: 'shapes', cache: 'both', context: 'both', band: 'two-lines', task: 'kind',
}
export const DEFAULT_UI: BelayPanelUi = { open: false, selected: null, legend: false, foldOpen: false, groups: [], placed: false, seen: [] }

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const obj = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
// Control characters and line breaks never reach a Text: one line, one row.
const clean = (s: string, cap = 200): string => {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t
}

// ---- settings -----------------------------------------------------------------------------------

const ALLOWED: { [K in keyof BelaySettings]: readonly BelaySettings[K][] } = {
  pane: ['docked', 'above-prompt'], marks: ['shapes', 'words', 'colour'], cache: ['countdown', 'bar', 'both'],
  context: ['figure', 'bar', 'both'], band: ['one-line', 'two-lines', 'minimal'], task: ['kind', 'title', 'off'],
}

// `belay settings --json` is { found, path, parse_error, settings: [{ key, value, source, allowed }] }.
// A value outside the allowed set is ignored and the default stands.
export function parseSettings(json: unknown): BelaySettings {
  const out: BelaySettings = { ...DEFAULT_SETTINGS }
  for (const r of arr(obj(json)?.settings)) {
    const o = obj(r)
    const key = o && str(o.key)
    if (!o || !key || !key.startsWith('mod.')) continue
    const name = key.slice(4) as keyof BelaySettings
    if (name in ALLOWED && (ALLOWED[name] as readonly unknown[]).includes(o.value)) (out as Record<string, unknown>)[name] = o.value
  }
  return out
}

// ---- agents -------------------------------------------------------------------------------------

const STATES: readonly BelayDisplayState[] = ['running', 'waiting', 'idle', 'stalled', 'permission', 'parked', 'dead', 'done', 'starting', 'stopping', 'unknown']
// Without a valid `display_state` the mark is unknown: the row's own state is never mapped to a rung.

function normCache(raw: unknown): BelayCache | null {
  const c = obj(raw)
  if (!c) return null
  const s = c.state
  return {
    ttlS: num(c.ttl_s), ttlBy: str(c.ttl_established_by), lastRequestAtMs: num(c.last_request_at_ms),
    ageMs: num(c.age_ms), leftMs: num(c.left_ms),
    state: s === 'warm' || s === 'low' || s === 'cold' ? s : 'unknown',
  }
}

function normAgent(raw: unknown): BelayAgent | null {
  const a = obj(raw)
  const id = a && str(a.id)
  if (!a || !id) return null
  const rawState = str(a.state)
  const ds = str(a.display_state)
  const fromDisplay = ds && (STATES as readonly string[]).includes(ds) ? (ds as BelayDisplayState) : null
  const t = obj(a.task)
  const task = t && str(t.id) ? { id: str(t.id) as string, title: str(t.title), titleSource: str(t.title_source), source: str(t.source) } : null
  return {
    id, role: str(a.role), substrate: str(a.substrate), model: str(a.model), effort: str(a.effort),
    state: fromDisplay ?? 'unknown',
    stateRaw: rawState,
    stateBy: fromDisplay ? str(a.display_state_established_by) : null,
    ctxTokens: num(a.context_tokens), ctxWindow: num(a.context_window), ctxPct: num(a.context_pct),
    costUsd: num(a.cost_usd), costSource: str(a.cost_source),
    cache: normCache(a.cache), task,
    launchMode: str(a.permission_mode) ?? str(a.launch_mode), version: str(a.claude_code_version) ?? str(a.version),
    pid: num(a.pid),
  }
}

export type AgentsRead = Pick<BelayPanelSnap, 'runId' | 'mode' | 'startedAtMs' | 'pausedAtMs' | 'endedAtMs' | 'tasks' | 'maxFixRounds' | 'embedder' | 'agents' | 'footer'>

// Only belay's two words count; anything else is an unknown mode.
const modeOf = (m: string | null): 'headless' | 'interactive' | null => (m === 'headless' || m === 'interactive' ? m : null)

export function normAgents(json: unknown): AgentsRead {
  const j = obj(json) ?? {}
  const agents = arr(j.agents).map(normAgent).filter((a): a is BelayAgent => a !== null)
  const f = obj(j.footer)
  const footer: BelayPanelFooter | null = f ? {
    agents: num(f.agents) ?? agents.length, totalCostUsd: num(f.total_cost_usd), notRecorded: num(f.cost_not_recorded) ?? 0,
    asOfMs: num(f.as_of_ms), highestCtxPct: num(f.highest_context_pct),
  } : null
  const run = obj(j.run) ?? {}
  const tc = obj(j.tasks) ?? obj(run.tasks)
  const held = new Set(agents.filter(a => a.task).map(a => a.task!.id)).size
  const tasks = tc ? { done: num(tc.done), total: num(tc.total), held } : held ? { done: null, total: null, held } : null
  return {
    runId: str(j.run_id), mode: modeOf(str(j.mode) ?? str(run.mode)),
    startedAtMs: num(j.started_at_ms), pausedAtMs: num(j.paused_at_ms), endedAtMs: num(j.ended_at_ms),
    tasks, maxFixRounds: num(j.max_fix_rounds),
    embedder: str(j.embedder) ?? str(run.embedder), agents, footer,
  }
}

// ---- notices ------------------------------------------------------------------------------------

export const TONE: Record<BelayNotice['tone'], { glyph: string; color: string; rank: number }> = {
  permission: { glyph: '▲', color: 'permission', rank: 0 },
  dead: { glyph: '✕', color: 'error', rank: 1 },
  refuted: { glyph: '✕', color: 'error', rank: 2 },
  stalled: { glyph: '◌', color: 'warning', rank: 3 },
  paused: { glyph: '‖', color: 'planMode', rank: 4 },
  holds: { glyph: '✓', color: 'merged', rank: 5 },
  stopped: { glyph: '✓', color: 'inactive', rank: 6 },
  ended: { glyph: '✓', color: 'inactive', rank: 7 },
}

export function normNotices(json: unknown): BelayNotice[] {
  const out: BelayNotice[] = []
  for (const raw of arr(obj(json)?.events)) {
    const e = obj(raw)
    const kind = e && str(e.kind)
    if (!e || !kind) continue
    const ts = num(e.ts)
    const w = str(e.worker_id)
    const mk = (tone: BelayNotice['tone'], id: string, text: string, ids: string, cmd: string | null, agentId: string | null = w, taskId: string | null = null): void => {
      out.push({ key: `${kind}|${id}|${ts ?? ''}`, kind, tone, ts, agentId, taskId, text: clean(text), ids: clean(ids), cmd })
    }
    if (kind === 'permission_pending') {
      const r = str(e.request_id) ?? '?'
      mk('permission', r, `${r} · ${w ?? '?'} wants ${str(e.tool) ?? 'a tool'}`, r, `belay approve ${r}   ·   belay deny ${r}`)
    } else if (kind === 'worker_dead') {
      mk('dead', w ?? '?', `${w} dead · established by ${str(e.death_established_by) ?? 'not recorded'}`, `exit ${e.exit_code ?? '?'}`, `belay logs ${w}`)
    } else if (kind === 'worker_stopped') {
      mk('stopped', w ?? '?', `${w} stopped`, `exit ${e.exit_code ?? '?'}`, `belay logs ${w}`)
    } else if (kind === 'worker_stalled') {
      const age = num(e.last_event_age_ms)
      mk('stalled', w ?? '?', `${w} stalled · no event for ${age === null ? '?' : dur(age, true)}`, `pid ${e.pid ?? '?'}`, `belay logs ${w}`)
    } else if (kind === 'review_verdict') {
      const t = str(e.task_id) ?? '?'
      const holds = e.verdict === 'holds' || (e.passed === true && e.verdict == null)
      const refuted = e.verdict === 'refuted' || (e.passed === false && e.executable !== false)
      if (!holds && !refuted) continue
      mk(holds ? 'holds' : 'refuted', t, `review ${t} ${holds ? 'holds' : 'refuted'}${str(e.judged_by) ? ` · ${str(e.judged_by)}` : ''}`, t, null, null, t)
    } else if (kind === 'run_paused') {
      mk('paused', str(e.run_id) ?? '?', `run paused${str(e.paused_by) ? ` by ${str(e.paused_by)}` : ''}`, str(e.run_id) ?? '', null, null)
    } else if (kind === 'run_ended') {
      mk('ended', str(e.run_id) ?? '?', `run ended · ${str(e.exit_reason) ?? 'reason not recorded'}`, str(e.run_id) ?? '', null, null)
    }
  }
  return out
}

// A stopped worker is not one of decision 5's notices: it is listed in the pane, never in the band or the count.
export const unseenNotices = (ns: BelayNotice[], ui: BelayPanelUi): BelayNotice[] =>
  ns.filter(n => n.tone !== 'stopped' && !ui.seen.includes(n.key)).sort((a, b) => TONE[a.tone].rank - TONE[b.tone].rank || (b.ts ?? 0) - (a.ts ?? 0))

// ---- transcript ---------------------------------------------------------------------------------

export function normTranscript(json: unknown): BelayEntry[] {
  const out: BelayEntry[] = []
  for (const raw of arr(obj(json)?.entries)) {
    const e = obj(raw)
    const kind = e && str(e.kind)
    if (!e || !kind) continue
    let text = ''
    if (kind === 'tool') {
      const ids = Object.entries(obj(e.ids) ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
      const res = e.result === null || e.result === undefined ? 'no result yet' : e.result === 'ok' ? 'ok' : (str(e.error_code) ?? 'error')
      text = `${(str(e.tool) ?? 'tool (call outside the window)').replace(/^mcp__belay__/, '')}${ids ? ' ' + ids : ''} → ${res}`
    } else if (kind === 'result') {
      text = `turn end${num(e.total_cost_usd) !== null ? ` · $${(e.total_cost_usd as number).toFixed(2)}` : ''}`
    } else text = str(e.text) ?? ''
    const at = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN // belay gives an ISO string
    if (text) out.push({ kind, text: clean(text, kind === 'text' ? 4000 : 400), ts: Number.isFinite(at) ? at : null })
  }
  return out
}

export const lastWords = (t: BelayEntry[] | null): BelayEntry | null => {
  for (let i = (t?.length ?? 0) - 1; i >= 0; i -= 1) if (t![i]!.kind === 'text') return t![i]!
  return null
}

// Two periods of the slowest poll (the band's 5 s): older than this, or after a failed read, the line is stale.
export const TRANSCRIPT_STALE_MS = 10000

// ---- figures ------------------------------------------------------------------------------------

export function dur(ms: number, fine = false): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return fine && s % 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
export const money = (x: number | null): string => (x === null ? '$ —' : `$${x.toFixed(2)}`)

export function bar(frac: number, width: number): { on: string; off: string } {
  const p = Math.max(0, Math.min(1, frac))
  const n = Math.round(p * width)
  return { on: '▰'.repeat(n), off: '▱'.repeat(width - n) }
}

// The cache's time left now: the fetched left_ms less the time since the fetch (a local tick between
// fetches). null when belay did not give a left_ms; the state then falls back to belay's own word.
export function cacheNow(c: BelayCache | null, fetchedAt: number, now: number): { leftMs: number | null; state: BelayCache['state'] } {
  if (!c) return { leftMs: null, state: 'unknown' }
  if (c.leftMs === null) return { leftMs: null, state: c.state }
  const left = c.leftMs - Math.max(0, now - fetchedAt)
  const low = Math.min(600000, (c.ttlS ?? 3600) * 1000 * 0.2)
  return { leftMs: left, state: left <= 0 ? 'cold' : left < low ? 'low' : 'warm' }
}
const CACHE_COLOR = { warm: 'success', low: 'warning', cold: 'inactive', unknown: 'inactive' } as const

export function cacheSegs(a: BelayAgent, s: BelaySettings, fetchedAt: number, now: number): Seg[] {
  const { leftMs, state } = cacheNow(a.cache, fetchedAt, now)
  const c = CACHE_COLOR[state]
  if (state === 'unknown' || (leftMs === null && state !== 'cold')) return [{ t: '—', dim: true }]
  const txt = state === 'cold' ? 'cold' : dur(leftMs as number)
  const b = state === 'cold' || leftMs === null || !a.cache?.ttlS ? null : bar(leftMs / (a.cache.ttlS * 1000), 5)
  const barSegs: Seg[] = b ? [{ t: b.on, c }, { t: b.off, dim: true }] : []
  if (s.cache === 'countdown') return [{ t: txt, c }]
  if (s.cache === 'bar') return barSegs.length ? barSegs : [{ t: txt, c }]
  return barSegs.length ? [...barSegs, { t: ' ' }, { t: txt, c }] : [{ t: txt, c }]
}

export function ctxSegs(a: BelayAgent, s: BelaySettings): Seg[] {
  if (a.ctxPct === null) return [{ t: '—', dim: true }]
  const c = a.ctxPct > 75 ? 'warning' : 'suggestion'
  const fig: Seg = { t: `${Math.round(a.ctxPct)}%` }
  const b = bar(a.ctxPct / 100, 6)
  const barSegs: Seg[] = [{ t: b.on, c }, { t: b.off, dim: true }]
  if (s.context === 'figure') return [fig]
  if (s.context === 'bar') return barSegs
  return [...barSegs, { t: ' ' }, fig]
}

// ---- marks --------------------------------------------------------------------------------------

const GLYPH: Record<BelayDisplayState, string> = { running: '●', waiting: '◐', idle: '○', stalled: '◌', permission: '▲', parked: '‖', dead: '✕', done: '✓', starting: '●', stopping: '●', unknown: '?' }
const WORD: Record<BelayDisplayState, string> = { running: 'run ', waiting: 'wait', idle: 'idle', stalled: 'stal', permission: 'perm', parked: 'park', dead: 'dead', done: 'done', starting: 'star', stopping: 'stop', unknown: '?   ' }
export const STATE_COLOR: Record<BelayDisplayState, string> = {
  running: 'success', waiting: 'success', idle: 'inactive', stalled: 'warning', permission: 'permission', parked: 'inactive', dead: 'error', done: 'inactive', starting: 'inactive', stopping: 'inactive', unknown: 'inactive',
}
export const STATE_NAME: Record<BelayDisplayState, string> = {
  running: 'running', waiting: 'waiting inside a call', idle: 'idle, no turn running', stalled: 'stalled', permission: 'waiting on a permission',
  parked: 'parked, session kept', dead: 'dead', done: 'finished', starting: 'starting, no pid recorded yet', stopping: 'stopping', unknown: 'state unknown (belay gave no display_state)',
}

export function markSeg(state: BelayDisplayState, marks: BelaySettings['marks']): Seg {
  const c = STATE_COLOR[state]
  if (marks === 'colour') return { t: '●', c }
  if (marks === 'words') return { t: `[${WORD[state]}]`, c }
  return { t: GLYPH[state], c }
}
export const markWidth = (m: BelaySettings['marks']): number => (m === 'words' ? 6 : 2)

// ---- run summary --------------------------------------------------------------------------------

export const isLive = (a: BelayAgent): boolean => a.state !== 'done'
export const isBusy = (a: BelayAgent): boolean => ['running', 'waiting', 'stalled', 'permission'].includes(a.state)

// Elapsed run time: frozen at the end, at the pause while one is set, and where the orchestrator was first read dead.
export function elapsedMs(snap: BelayPanelSnap, now: number): number | null {
  if (snap.startedAtMs === null) return null
  return (snap.endedAtMs ?? snap.pausedAtMs ?? snap.frozenAtMs ?? now) - snap.startedAtMs
}

// The run line is parts: brand and id; state and elapsed; stale; agents; cost. A narrow width drops parts from the
// END and never shrinks a kept one; the brand and id come first and stay whole while they fit.
export function runBrief(snap: BelayPanelSnap, now: number): Seg[] {
  const segs: Seg[] = [{ t: 'belay', c: 'claude', bold: true }, { t: ` ${snap.runId ?? '—'}` }]
  if (snap.runState) {
    const c = snap.runState === 'paused' ? 'planMode' : snap.runState === 'dead' ? 'error' : snap.runState === 'ended' ? 'inactive' : 'success'
    segs.push({ t: '  ', brk: true }, { t: '●', c }, { t: ` ${snap.runState}` })
    const el = elapsedMs(snap, now)
    if (el !== null) segs.push({ t: ` ${dur(el)}` })
  }
  if (snap.stale) segs.push({ t: '  stale: last read failed', dim: true, brk: true })
  return segs
}

export function runLine(snap: BelayPanelSnap, now: number): Seg[] {
  const live = snap.agents.filter(isLive).length
  const busy = snap.agents.filter(isBusy).length
  const segs: Seg[] = [...runBrief(snap, now), { t: '  │  ', dim: true, brk: true }, { t: `${live} agents · ${busy} busy` }]
  if (snap.footer) segs.push({ t: '  │  ', dim: true, brk: true }, { t: money(snap.footer.totalCostUsd) })
  if (snap.footer?.asOfMs) segs.push({ t: ` @${new Date(snap.footer.asOfMs).toTimeString().slice(0, 5)}`, dim: true })
  return segs
}

const width = (xs: Seg[]): number => xs.reduce((n, s) => n + cells(s.t), 0)

// Fit a line to `room` cells: whole parts are kept while they fit and the rest are dropped from the end.
// If the first part alone is too long, it is cut at its end with an ellipsis. Nothing is ever shrunk.
export function fitSegs(segs: Seg[], room: number): Seg[] {
  const parts: Seg[][] = []
  for (const s of segs) {
    if (s.brk || !parts.length) parts.push([s])
    else parts[parts.length - 1]!.push(s)
  }
  const out: Seg[] = []
  let used = 0
  for (let i = 0; i < parts.length; i += 1) {
    const w = width(parts[i]!)
    if (used + w <= room) { out.push(...parts[i]!); used += w; continue }
    if (i === 0) {
      for (const s of parts[0]!) {
        const left = room - used
        if (left <= 0) break
        const w = cells(s.t)
        if (w <= left) { out.push(s); used += w } else { out.push({ ...s, t: clipCells(s.t, left) }); used = room; break }
      }
    }
    break
  }
  return out
}

export const plain = (segs: Seg[]): string => segs.map(s => s.t).join('')

// The band's second element: the newest unseen notice wins, else the orchestrator's latest line
// (headless only, with its age, marked stale when the last read failed or is old), else a plain statement.
// `cols` bounds the text so the band never wraps.
export function bandMessage(snap: BelayPanelSnap, ui: BelayPanelUi, cols: number, now: number): Seg[] {
  const top = unseenNotices(snap.notices, ui)[0]
  if (top) {
    const t = TONE[top.tone]
    return [{ t: `${t.glyph} ${top.text}`, c: t.color }]
  }
  if (snap.mode === 'interactive') return [{ t: 'orchestrator is in its own window', dim: true }]
  if (snap.mode !== 'headless') return [{ t: 'run mode unknown', dim: true }]
  const last = lastWords(snap.transcript)
  if (!last) return [{ t: 'no orchestrator line yet', dim: true }]
  const stale = !snap.transcriptOk || snap.transcriptAt === null || now - snap.transcriptAt > TRANSCRIPT_STALE_MS
  const age = last.ts !== null ? ` ${dur(now - last.ts)} ago` : ' (kept, age unknown)'
  const room = Math.max(10, cols - 30)
  return [
    { t: `orch${age}${stale ? ' (stale)' : ''}: `, dim: true },
    { t: clipCells(last.text, room), dim: stale },
  ]
}

export function bandLines(snap: BelayPanelSnap, ui: BelayPanelUi, now: number, cols: number): Seg[][] {
  const head = runLine(snap, now)
  const un = unseenNotices(snap.notices, ui)
  if (snap.settings.band === 'minimal') {
    const t = un[0] ? TONE[un[0].tone] : null
    return [[...runBrief(snap, now), ...(t ? [{ t: `  ${t.glyph}${un.length}`, c: t.color, brk: true as const }] : [])]]
  }
  const msg = bandMessage(snap, ui, cols, now)
  if (snap.settings.band === 'one-line') return [[...head, { t: '  │  ', dim: true, brk: true }, ...msg]]
  return [head, msg]
}
