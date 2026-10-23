// What the panel does with belay's answers, as pure functions. The commands themselves are run from
// index.tsx: the engine follows `$` only inside the file that declares the hooks.

import type { BelayAgent, BelayHeld, BelayPanelSnap, BelayPanelWatch } from '../../types/index'
import { countAwaiting, normAwaiting, normHeld } from './held'
import { DEFAULT_SETTINGS, normAgents, normNotices, normTranscript, parseMemoryNotice, parseSettings, type AgentsRead } from './model'

export type RunFile = { role: string; runId: string; dataDir: string; cli: string; node: string; orchDir: string | null }
export type RunFileRead = { file: RunFile } | { error: string }
export type Ran = { json: unknown } | { error: string; timedOut?: true }

export const fwd = (p: string): string => p.split('\\').join('/')

// Resolve `..` by hand: the module has no `path`.
export function normalise(p: string): string {
  const out: string[] = []
  for (const part of fwd(p).split('/')) {
    if (part === '..' && out.length > 1 && out[out.length - 1] !== '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/')
}

const RUN_FILE_FIELDS: [keyof RunFile, string][] = [
  ['role', 'role'], ['runId', 'run_id'], ['dataDir', 'data_dir'], ['cli', 'belay_cli'], ['node', 'node'],
]

// belay-run.json must carry role, run_id, data_dir, belay_cli and node. A file that does not parse, or
// lacks one, is an error state, never a partial binding.
export function parseRunFile(text: string): RunFileRead {
  let j: Record<string, unknown>
  try { j = JSON.parse(text) as Record<string, unknown> } catch { return { error: 'belay-run.json is not valid JSON' } }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { error: 'belay-run.json is not an object' }
  const missing = RUN_FILE_FIELDS.filter(([, k]) => typeof j[k] !== 'string' || j[k] === '').map(([, k]) => k)
  if (missing.length) return { error: `belay-run.json lacks ${missing.join('/')}` }
  if (j.role !== 'orchestrator') return { error: 'belay-run.json role must be "orchestrator"' }
  const s = (k: string): string => j[k] as string
  return { file: { role: s('role'), runId: s('run_id'), dataDir: s('data_dir'), cli: s('belay_cli'), node: s('node'), orchDir: typeof j.orchestrator_dir === 'string' && j.orchestrator_dir !== '' ? j.orchestrator_dir : null } }
}

// A Windows path: there a bare `belay` is usually a .cmd shim, which cannot be started without a shell.
export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
// Where the repo's CLI would be if this plugin sits at <repo>/src/mod.
export const repoCliGuess = (pluginRoot: string): string => normalise(`${pluginRoot}/../../src/cli/belay.cjs`)

// Where `belay settings` runs for a run bound by belay-run.json: the project root that holds data_dir, so it
// reads the run's repo config. A .belay data dir sits in its project root; any other data_dir is the root.
export function projectRootOf(dataDir: string): string {
  const d = fwd(dataDir).replace(/\/+$/, '')
  return /\/\.belay$/.test(d) ? d.slice(0, d.length - '/.belay'.length) || '/' : d
}

// What the review launcher printed (`--json` is always on the argv, so the real output is a JSON receipt or error), as one short toast line.
// Falls back to the first line of plain text. Never raw JSON.
export function launcherLine(exitCode: number, stdout: string, stderr: string, project: string): string {
  const first = (s: string): string => (s.split('\n').map(l => l.trim()).find(l => l !== '') ?? '').slice(0, 160)
  const asObj = (s: string): Record<string, unknown> | null => { try { const p: unknown = JSON.parse(s); return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null } catch { return null } }
  // --json prints a receipt to stdout and an error to stderr (pretty-printed); a plain-text answer falls back to its first line.
  const j = asObj(stdout)
  const ej = asObj(stderr)
  const err = j && j.error !== null && typeof j.error === 'object' ? (j.error as Record<string, unknown>) : ej && ej.error !== null && typeof ej.error === 'object' ? (ej.error as Record<string, unknown>) : null
  const warnRaw = j && typeof j.closing_warning === 'string' ? j.closing_warning : j && typeof j.warning === 'string' ? j.warning : null // a review acting for a live run carries one
  const warn = warnRaw ? ` · warning: ${warnRaw.replace(/\s+/g, ' ').slice(0, 200)}` : ''
  if (exitCode === 0 && j && j.started === true) return `belay: archive review of ${project} started: pid ${String(j.pid ?? '?')}, job ${String(j.job ?? '?')}${warn}`
  if (exitCode === 0 && j && j.ended !== undefined) return `belay: archive review of ${project} ended at once: ${first(JSON.stringify(j.ended))}${warn}`
  const plainErr = typeof j?.error === 'string' ? j.error : typeof ej?.error === 'string' ? ej.error : null // a usage error prints {"error": "<text>"}
  const said = err ? `${typeof err.code === 'string' ? `${err.code}: ` : ''}${typeof err.message === 'string' ? err.message.slice(0, 160) : ''}` : plainErr !== null ? first(plainErr) : first(stdout.trim() ? stdout : stderr)
  return exitCode === 0 ? `belay: ${said || 'archive review started'}` : `belay: the review was not started (exit ${exitCode})${said ? `: ${said}` : ''}`
}

// The review launcher refuses with E_NOT_FOUND and `live_run` (a run id) when the only run with notes on is still live and it was not named (cmd-memory-stages.cjs).
// That field, never the words, tells the panel to say which run it means. null when the launcher said anything else.
export function needsRun(exitCode: number, stdout: string, stderr: string, runId: string | null): boolean {
  if (exitCode === 0 || !runId) return false
  for (const text of [stdout, stderr]) {
    try {
      const e = (JSON.parse(text) as { error?: { code?: unknown; live_run?: unknown } }).error
      if (e && typeof e === 'object' && e.code === 'E_NOT_FOUND' && e.live_run === runId) return true // only the run the panel watches; another live run's refusal names that run and is shown as it is
    } catch { /* not JSON */ }
  }
  return false
}

export const argvFor = (cli: string[], args: string[], dataDir: string | null): string[] =>
  [...cli, ...args, '--json', ...(dataDir ? ['--data', dataDir] : [])]

export function parseRan(args: string[], r: { exitCode: number; stdout: string } | null): Ran {
  const label = `belay ${args.join(' ')}`
  if (!r) return { error: `${label} did not run` }
  if (r.exitCode !== 0) return { error: `${label} exit ${r.exitCode}` }
  try { return { json: JSON.parse(r.stdout) } } catch { return { error: `${label} exit 0, output is not JSON` } }
}

// A snapshot that only carries an error that stops every read: nothing is run, nothing falls back.
export function fatalSnapshot(message: string, runId: string | null, now: number): BelayPanelSnap {
  return {
    fetchedAt: now, runId, mode: null, runState: null, stale: false, fatal: message, transcriptOk: false, transcriptAt: null,
    startedAtMs: null, pausedAtMs: null, frozenAtMs: null, endedAtMs: null, tasks: null, maxFixRounds: null, embedder: null, agents: [], footer: null, notices: [], held: null, transcript: null,
    settings: DEFAULT_SETTINGS, memoryNotice: null, errors: [],
  }
}

export type Parts = {
  watch: BelayPanelWatch
  prev: BelayPanelSnap | null
  now: number
  agents: Ran
  notices: Ran | null
  transcript: Ran | null
  settings: Ran | null
  /** `belay memory held --awaiting`: read only while some held note waits on the operator. */
  awaiting?: Ran | null
}

// The orchestrator's row in THIS successful agents read decides the run state; it is never carried over.
function runStateOf(agents: BelayAgent[], stateRaw: string | null): BelayPanelSnap['runState'] {
  const orch = agents.find(a => a.role === 'orchestrator')
  if (!orch) return null
  if (stateRaw === 'paused') return 'paused'
  if (orch.state === 'done') return 'ended'
  if (orch.state === 'dead') return 'dead'
  if (orch.state === 'unknown') return null
  return 'running'
}

// The held line plus the ids of the notes that wait on the operator: this round's read, else the last round's while some still wait.
function heldWith(h: BelayHeld | null, aw: unknown, prev: BelayHeld | null, now: number): BelayHeld | null {
  if (!h) return h
  if (!(h.awaiting ?? 0)) { const { awaitingNotes: _gone, ...rest } = h; return rest }
  // The list and its own total come from one read. A list carried over from an earlier round (this round's read failed) says so and keeps
  // the total and the time of the read it came from; the heading's count is a different read and is never mixed into the list's.
  if (aw !== undefined) return { ...h, awaitingNotes: normAwaiting(aw), awaitingList: { total: countAwaiting(aw), at: now, carried: false } }
  const notes = prev?.awaitingNotes ?? h.awaitingNotes ?? []
  const was = prev?.awaitingList
  return { ...h, awaitingNotes: notes, ...(notes.length || was ? { awaitingList: { total: was?.total ?? notes.length, at: was?.at ?? now, carried: true } } : {}) }
}

export function buildSnapshot(p: Parts): BelayPanelSnap {
  const { prev } = p
  const errors: string[] = []
  const take = (r: Ran | null): unknown => {
    if (!r) return undefined
    if ('error' in r) { errors.push(r.error); return undefined }
    return r.json
  }
  const aj = take(p.agents)
  const ag: AgentsRead | null = aj !== undefined ? normAgents(aj) : null
  const stale = ag === null
  if (ag && ag.runId === null && p.watch.runId === null) errors.push('no belay run found (this session\'s directory has no belay store, or the store has no runs)')
  const nj = take(p.notices) // null: the round was cut short by a timeout, so the earlier notices stand
  const notices = nj !== undefined ? normNotices(nj) : (prev?.notices ?? [])
  // belay-run.json means this is the orchestrator's own window; otherwise the run's mode, null when unknown.
  const mode = p.watch.fixed ? 'interactive' : ag ? ag.mode : (prev?.mode ?? null)
  const tj = take(p.transcript)
  let transcript = mode === 'headless' ? (prev?.transcript ?? null) : null
  let transcriptOk = mode === 'headless' ? (prev?.transcriptOk ?? false) : false
  let transcriptAt = mode === 'headless' ? (prev?.transcriptAt ?? null) : null
  if (mode === 'headless' && p.transcript) {
    transcriptOk = tj !== undefined
    if (tj !== undefined) {
      transcript = normTranscript(tj)
      // A one-entry tail may hold no words (a tool call or a turn end): the last words seen stay, and their age shows.
      const lastText = (xs: typeof transcript) => (xs ?? []).filter(e => e.kind === 'text').slice(-1)
      if (!lastText(transcript).length) transcript = [...lastText(prev?.transcript ?? null), ...(transcript ?? [])]
      transcriptAt = p.now
    }
  }
  const aw = take(p.awaiting ?? null)
  const sj = take(p.settings)
  const settings = sj !== undefined ? parseSettings(sj) : (prev?.settings ?? DEFAULT_SETTINGS)
  // The settings read sees the config file only. A run answers for itself (its launch recorded the notice, or none: notes on, notes
  // off on purpose, memory null), whatever the config says now; the config's notice is for a panel with no run to read.
  const runRead = aj !== undefined && typeof (aj as { run_id?: unknown }).run_id === 'string'
  // A failed agents read leaves the selected run as it was: its cached notice stands, null included.
  const runSelected = aj === undefined && (p.watch.runId ?? prev?.runId ?? null) !== null
  const memoryNotice = runRead ? parseMemoryNotice(aj) : runSelected ? (prev?.memoryNotice ?? null) : sj !== undefined ? parseMemoryNotice(sj) : (prev?.memoryNotice ?? null)
  const orchRaw = aj !== undefined ? ((aj as { agents?: { role?: string; state?: string }[] }).agents ?? []).find(a => a.role === 'orchestrator')?.state ?? null : null
  return {
    // the cache countdown is anchored to when the agents were last read, not to a failed round
    fetchedAt: ag ? p.now : (prev?.fetchedAt ?? p.now),
    runId: ag?.runId ?? p.watch.runId ?? prev?.runId ?? null,
    mode,
    runState: ag ? runStateOf(ag.agents, orchRaw) : null,
    stale, fatal: null, transcriptOk, transcriptAt,
    startedAtMs: ag ? ag.startedAtMs : (prev?.startedAtMs ?? null),
    frozenAtMs: ag && runStateOf(ag.agents, orchRaw) === 'dead' ? (prev?.runState === 'dead' && prev.frozenAtMs !== null ? prev.frozenAtMs : p.now) : null,
    pausedAtMs: ag ? ag.pausedAtMs : (prev?.pausedAtMs ?? null),
    endedAtMs: ag ? ag.endedAtMs : (prev?.endedAtMs ?? null),
    tasks: ag ? ag.tasks : (prev?.tasks ?? null),
    maxFixRounds: ag ? ag.maxFixRounds : (prev?.maxFixRounds ?? null),
    embedder: ag ? ag.embedder : (prev?.embedder ?? null),
    agents: ag ? ag.agents : (prev?.agents ?? []),
    footer: ag ? ag.footer : (prev?.footer ?? null),
    notices, held: heldWith(nj !== undefined ? normHeld(nj) : (prev?.held ?? null), aw, prev?.held ?? null, p.now), transcript, settings, memoryNotice, errors,
  }
}
