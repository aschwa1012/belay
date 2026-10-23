// The memory line's model: notes held for the archive reviewer and the state of its review, from belay's notices. Pure; no `$`.

import type { BelayAwaitingNote, BelayHeld, BelayReview } from '../../types/index'
import { arr, clean, dur, num, obj, str } from './model'

// The estimated cost of one archive review, once the batch study has produced one. Null until then: the confirm says so.
export const REVIEW_COST_ESTIMATE_USD: number | null = null
// A first press waits this long for the second; after it, or after any other press, the confirm is gone.
export const CONFIRM_MS = 8000

// belay's `notes_held` notice (a standing count while any hold waits) and its `review_running` / `review_ended` notices (the store-level
// claim of an archive review, which survives a reload of this panel), read defensively. Not notices of the panel's own list: they are the
// memory line, with the review button. null when there is neither a count nor a review to show.
export function normHeld(json: unknown): BelayHeld | null {
  let count = 0
  let unsupported = 0
  let oldestAgeRuns = 0
  let oldestAt: number | null = null
  const byProject: Record<string, number> = {}
  const byGround: Record<string, number> = {}
  let awaiting = 0
  const reviews: BelayReview[] = [], breakers: { runId: string; disputed: number }[] = []
  for (const raw of arr(obj(json)?.events)) {
    const e = obj(raw)
    if (!e) continue
    if (e.kind === 'notes_held') {
      count = num(e.count) ?? 0
      unsupported = Math.min(count, num(e.unsupported) ?? 0)
      oldestAgeRuns = num(e.oldest_age_runs) ?? 0
      oldestAt = num(e.oldest_at)
      for (const [k, v] of Object.entries(obj(e.by_project) ?? {})) if (num(v) !== null && k !== '') byProject[clean(k, 64)] = v as number
      for (const [k, v] of Object.entries(obj(e.by_ground) ?? {})) if (num(v) !== null && k !== '') byGround[clean(k, 40)] = v as number
      awaiting = Math.min(count, num(e.awaiting_operator) ?? 0)
    } else if (e.kind === 'run_disputed') {
      if (str(e.disputed_run) && breakers.length < 3) breakers.push({ runId: clean(str(e.disputed_run)!, 64), disputed: num(e.disputed) ?? 0 })
    } else if (e.kind === 'review_running' || e.kind === 'review_ended') {
      const project = str(e.project)
      if (!project) continue
      const state: BelayReview['state'] = e.kind === 'review_running' ? (e.pid_alive === true ? 'running' : 'interrupted') : (e.ok === true ? 'ok' : 'failed')
      reviews.push({ project: clean(project, 64), state, pid: num(e.pid), text: str(e.text) === null ? (str(e.code) === null ? null : clean(str(e.code)!, 40)) : clean(str(e.text)!, 240), ts: num(e.ts), job: str(e.job) })
    }
  }
  if (count <= 0 && !reviews.length) return null
  return { count: Math.max(0, count), unsupported, byProject, oldestAgeRuns, ...(oldestAt !== null && oldestAt > 0 ? { oldestAt } : {}), reviews, ...(Object.keys(byGround).length ? { byGround, awaiting } : {}), ...(breakers.length ? { breakers } : {}) }
}

// The review of a project that is in flight: the panel offers no button over it.
export const runningReview = (h: BelayHeld, project: string | null): BelayReview | null =>
  h.reviews.find(r => r.state === 'running' && (project === null || r.project === project)) ?? null

// belay's summary of a finished review is `ran as <job>: {"verdicts":1,"applied":1,...}`. Words for it, or null when it is not that.
export function reviewOutcome(text: string | null): string | null {
  const m = text && /^ran as \S+: (\{.*\})$/.exec(text)
  if (!m) return null
  let c: Record<string, unknown>
  try { c = JSON.parse(m[1]!) as Record<string, unknown> } catch { return null }
  if (c === null || typeof c !== 'object') return null
  const n = (k: string): number => (typeof c[k] === 'number' && (c[k] as number) > 0 ? (c[k] as number) : 0)
  const parts = ['applied', 'refused', 'undecided', 'refused_stale'].filter(k => n(k) > 0).map(k => `${n(k)} ${k === 'refused_stale' ? 'stale' : k}`)
  const v = typeof c.verdicts === 'number' ? `${c.verdicts} verdict${c.verdicts === 1 ? '' : 's'}` : null
  return [v, parts.join(', ') || null].filter(Boolean).join(': ') || null
}

// The one line a review's state is shown as.
// A running review is shown from a pid check; belay proves identity (pid and creation time) only where it takes the claim. An old claim says so.
export const STALE_CLAIM_MS = 15 * 60 * 1000
export function reviewLine(r: BelayReview, now: number | null = null): string {
  if (r.state === 'running') return `archive review of ${r.project} running${r.pid ? ` · pid ${r.pid}` : ''}${now !== null && r.ts !== null && now - r.ts > STALE_CLAIM_MS ? ' · pid check only, may be stale: a new review checks the process' : ''}`
  if (r.state === 'interrupted') return `archive review of ${r.project} INTERRUPTED · its process is gone; the next review takes over`
  if (r.state === 'ok') {
    const w = reviewOutcome(r.text)
    if (w) return `archive review of ${r.project} done · ${w}${r.job ? ` · job ${r.job.length > 16 ? '…' + r.job.slice(-8) : r.job}` : ''}`
  }
  return `archive review of ${r.project} ${r.state === 'ok' ? 'ended ok' : 'FAILED'}${r.text ? ` · ${r.text}` : ''}`
}

// The project one press would review: the one with the most held notes, ties by name. null when belay named none.
export function reviewProject(h: BelayHeld | null): string | null {
  if (!h || h.count <= 0) return null
  const names = Object.keys(h.byProject).sort((a, b) => h.byProject[b]! - h.byProject[a]! || (a < b ? -1 : 1))
  return names[0] ?? null
}

const GROUND_LABEL: Record<string, string> = { reported: 'reported wrong', report_confirmed: 'reported wrong', code_contradicts: 'wrong', refuted_review: 'wrong', same_claim: 'duplicate', replaced_by_newer: 'superseded', unsupported: 'unsupported', none: 'other' }

// How long the oldest held note has waited, as a suffix, when belay reported when it was held (`now` is the panel's clock).
const waitedFor = (h: BelayHeld, now?: number): string => (now !== undefined && h.oldestAt !== undefined ? ` · oldest waited ${dur(Math.max(0, now - h.oldestAt))}` : '')
const flagFor = (h: BelayHeld): string => (h.breakers ?? []).map(b => ` · run ${b.runId.slice(0, 8)} disputed ${b.disputed}: review`).join('') // the breaker flag, ADR 0047 decision 9

export function heldLine(h: BelayHeld, now?: number): string {
  if (h.count <= 0) return ''
  const w = waitedFor(h, now) + flagFor(h)
  if (h.byGround && Object.keys(h.byGround).length) {
    const parts = new Map<string, number>()
    for (const [k, n] of Object.entries(h.byGround)) parts.set(GROUND_LABEL[k] ?? k, (parts.get(GROUND_LABEL[k] ?? k) ?? 0) + n)
    const a = h.awaiting ?? 0
    return `${h.count} held: ${[...parts].map(([k, n]) => `${n} ${k}`).join(', ')}${a > 0 ? `; ${a} await${a === 1 ? 's' : ''} you` : ''}${w}`
  }
  const names = Object.keys(h.byProject).sort()
  const warned = h.count - h.unsupported
  if (h.unsupported > 0) return `${warned > 0 ? `${warned} held as wrong or duplicate · ` : ''}${h.unsupported} unsupported awaiting review · oldest ${h.oldestAgeRuns} run${h.oldestAgeRuns === 1 ? '' : 's'}${names.length ? ` · ${names.join(', ')}` : ''}${w}`
  return `${h.count} note${h.count === 1 ? '' : 's'} held for review · oldest ${h.oldestAgeRuns} run${h.oldestAgeRuns === 1 ? '' : 's'}${names.length ? ` · ${names.join(', ')}` : ''}${w}`
}

export function confirmLine(h: BelayHeld, project: string): string {
  const cost = REVIEW_COST_ESTIMATE_USD === null ? 'cost: measured after first run' : `estimated cost $${REVIEW_COST_ESTIMATE_USD.toFixed(2)}`
  return `${h.byProject[project] ?? h.count} note${(h.byProject[project] ?? h.count) === 1 ? '' : 's'} held in ${project} · dispatch the Opus archive reviewer? ${cost}`
}

// ---- the operator's settle of a note the archive review left undecided ------------------------------

export type SettleAction = 'archive' | 'release' | 'reoffer'
export const SETTLE_ACTIONS: readonly SettleAction[] = ['archive', 'release', 'reoffer']
const SETTLE_SHOWN = 3 // notes listed with buttons at once; the rest are counted

// `belay memory held --awaiting --json`: the notes waiting on the operator (a read). Ids and titles are belay's, still cleaned.
export function normAwaiting(json: unknown): BelayAwaitingNote[] {
  const out: BelayAwaitingNote[] = []
  for (const raw of arr(obj(json)?.entries)) {
    const e = obj(raw)
    const id = e ? str(e.note_id) : null
    if (!e || !id || e.awaiting_operator !== true || out.length >= SETTLE_SHOWN) continue
    out.push({ id: clean(id, 64), project: clean(str(e.project) ?? '', 64), title: clean(str(e.title) ?? '', 60), reason: clean(str(obj(e.undecided)?.reason) ?? '', 80) })
  }
  return out
}

export const shortId = (id: string): string => id.slice(0, 8)

// The argv tail of the settle write. The reason is ONE element, whatever it holds: belay's parser takes the element after --reason as the value.
export const settleArgs = (action: SettleAction, id: string, reason: string): string[] => ['memory', 'held', 'settle', id, `--${action}`, '--reason', reason]

export const settleVerb = (a: SettleAction): string => a[0]!.toUpperCase() + a.slice(1)
// The confirm shows the reason exactly as it is sent (a reason over REASON_MAX is refused first, so nothing is cut).
export const settleConfirm = (a: SettleAction, id: string, reason: string): string => `${settleVerb(a)} note ${shortId(id)}? reason: ${reason}`

export const REASON_MAX = 160
// belay strips its own global options out of the argv before any command sees it, so a reason that is exactly one of them never arrives.
const GLOBAL_FLAGS = ['--json', '--fix', '--data', '--help', '-h']
// null when the reason can be sent as it is; otherwise the toast that says why it is refused.
export function reasonProblem(reason: string): string | null {
  if (reason.length > REASON_MAX) return `belay: the reason is ${reason.length} characters; at most ${REASON_MAX}. Shorten it.`
  if (GLOBAL_FLAGS.includes(reason)) return `belay: a reason cannot be exactly ${reason}: belay would read it as its own option. Add a word to it.`
  return null
}

/** The error a belay command printed under --json: stdout, else stderr (the real CLI prints errors to stderr, pretty-printed). */
export type CliError = { code: string | null; message: string; unknown: boolean }
export function cliError(stdout: string, stderr: string): CliError | null {
  for (const text of [stdout, stderr]) {
    let j: Record<string, unknown> | null = null
    try { j = obj(JSON.parse(text)) } catch { continue }
    if (typeof j?.error === 'string' && j.error !== '') return { code: null, message: clean(j.error, 160), unknown: false } // a usage error: {"error": "<text>"}, exit 2
    const e = obj(j?.error)
    if (!e) continue
    const d = obj(e.detail) ?? {}
    const code = str(e.code)
    return { code, message: clean(str(e.message) ?? '', 160), unknown: code === 'E_TIMEOUT' || code === 'E_OWNER_LOST' || d.may_have_committed === true || d.sent === true }
  }
  return null
}

export const SETTLE_UNKNOWN = 'belay: outcome unknown: re-read with belay memory held'

// What `belay memory held settle --json` printed, as one toast line. Only a definite refusal says "not settled": a timeout, a lost owner,
// anything that may have committed, or output that is not a receipt says the outcome is unknown (a write lost after it was sent is not re-run).
export function settleLine(exitCode: number, stdout: string, stderr: string): string {
  let j: Record<string, unknown> | null = null
  try { j = obj(JSON.parse(stdout)) } catch { /* not a receipt */ }
  if (exitCode === 0 && j && str(j.id) && str(j.outcome)) return `belay: ${clean(String(j.action ?? 'settled'), 20)} ${shortId(String(j.id))}: ${clean(String(j.outcome), 40)}${str(j.receipt) ? ` · receipt ${clean(String(j.receipt), 80)}` : ''}`
  const err = cliError(stdout, stderr)
  if (exitCode !== 0 && err && !err.unknown) return `belay: the note was not settled (exit ${exitCode}): ${err.code ? `${err.code}: ` : ''}${err.message}`
  return `${SETTLE_UNKNOWN}${err?.code ? ` (${err.code})` : ` (exit ${exitCode})`}`
}
