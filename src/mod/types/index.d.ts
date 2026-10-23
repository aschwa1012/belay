// belay's mod: the contract of the values it keeps in `$.state`, one block per feature under the
// plugin's name. Self-contained (the engine reads this file alone). The panel's block is `panel*`;
// the wake adds its own block beside it.

export type BelayDisplayState = 'running' | 'waiting' | 'idle' | 'stalled' | 'permission' | 'parked' | 'dead' | 'done' | 'starting' | 'stopping' | 'unknown'

export type BelayCache = {
  ttlS: number | null
  ttlBy: string | null
  lastRequestAtMs: number | null
  ageMs: number | null
  leftMs: number | null
  state: 'warm' | 'low' | 'cold' | 'unknown'
}

export type BelayAgent = {
  id: string
  role: string | null
  substrate: string | null
  model: string | null
  effort: string | null
  state: BelayDisplayState
  stateRaw: string | null
  stateBy: string | null
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPct: number | null
  costUsd: number | null
  costSource: string | null
  /** belay's word for how an estimated cost was made ("transcript, API rates"); null on every row today. */
  costBasis: string | null
  cache: BelayCache | null
  task: { id: string; title: string | null; titleSource: string | null; source: string | null } | null
  launchMode: string | null
  version: string | null
  pid: number | null
}

export type BelayNotice = {
  key: string
  kind: string
  tone: 'permission' | 'dead' | 'stalled' | 'holds' | 'refuted' | 'paused' | 'ended' | 'stopped' | 'memory'
  ts: number | null
  agentId: string | null
  taskId: string | null
  text: string
  ids: string
  cmd: string | null
}

export type BelayEntry = { kind: string; text: string; ts: number | null }

export type BelaySettings = {
  pane: 'docked' | 'above-prompt'
  marks: 'shapes' | 'words' | 'colour'
  cache: 'countdown' | 'bar' | 'both'
  context: 'figure' | 'bar' | 'both'
  task: 'kind' | 'title' | 'off'
  band: 'one-line' | 'two-lines' | 'minimal'
}

export type BelayPanelFooter = {
  agents: number
  totalCostUsd: number | null
  notRecorded: number
  asOfMs: number | null
  highestCtxPct: number | null
}

/** The newest archive review of a project, from belay's `review_running` / `review_ended` notices (the review's store-level claim). */
export type BelayReview = { project: string; state: 'running' | 'interrupted' | 'ok' | 'failed'; pid: number | null; text: string | null; ts: number | null; job?: string | null }

/** A held note that waits on the operator (an archive review left it undecided), from `belay memory held --awaiting`. */
export type BelayAwaitingNote = { id: string; project: string; title: string; reason: string }

/** Notes held for the on-demand Opus archive reviewer, from belay's `notes_held` notice, and the state of the project's review. */
export type BelayHeld = { count: number; unsupported: number; byProject: Record<string, number>; oldestAgeRuns: number; oldestAt?: number; reviews: BelayReview[]; byGround?: Record<string, number>; awaiting?: number; awaitingNotes?: BelayAwaitingNote[]; awaitingList?: { total: number; at: number; carried: boolean }; breakers?: { runId: string; disputed: number }[] }

/** `belay settings`' memory_notice: notes are on by default but no memory.project is set, so memory is off. null once a project is set. */
export type BelayMemoryNotice = { title: string; why: string; fix: string; configLine: string; short: string }

export type BelayPanelSnap = {
  fetchedAt: number
  runId: string | null
  mode: string | null
  /** From the orchestrator's row in the current successful agents read only; null when unknown or stale. */
  runState: 'running' | 'paused' | 'ended' | 'dead' | null
  /** The agents read of this round failed: the data above is from an earlier read. */
  stale: boolean
  /** A configuration error that stops every read (belay-run.json, no CLI). */
  fatal: string | null
  /** The last transcript read succeeded, and when (the snapshot's fetch time). */
  transcriptOk: boolean
  transcriptAt: number | null
  startedAtMs: number | null
  pausedAtMs: number | null
  /** The first read at which the orchestrator was dead: the elapsed time stops there. */
  frozenAtMs: number | null
  endedAtMs: number | null
  tasks: { done: number | null; total: number | null; held: number } | null
  /** The run row records the limit, not the rounds used. */
  maxFixRounds: number | null
  embedder: string | null
  agents: BelayAgent[]
  footer: BelayPanelFooter | null
  notices: BelayNotice[]
  /** null: belay reported no `notes_held` notice (nothing held, or not read yet). */
  held: BelayHeld | null
  transcript: BelayEntry[] | null
  settings: BelaySettings
  memoryNotice: BelayMemoryNotice | null
  /** One line per failing command: the command and its exit code. */
  errors: string[]
}

export type BelayPanelWatch = {
  runId: string | null
  dataDir: string | null
  cli: string | null
  node: string | null
  /** belay-run.json exists but is unusable. Nothing is read and nothing falls back. */
  error: string | null
  /** Bound by belay-run.json: the CLI is exactly [node, cli]; a lack of either is an error, not a fallback. */
  fixed: boolean
}

export type BelayPanelUi = {
  open: boolean
  selected: string | null
  legend: boolean
  foldOpen: boolean
  /** Keys of the orchestrator's tool-call groups the person expanded. */
  groups: string[]
  /** A docked Pane is actually seated; the inline panel is drawn while it is not. */
  placed: boolean
  seen: string[]
  /** The archive review button was pressed once: the project it would review and when. A second press inside CONFIRM_MS dispatches. */
  confirm: { project: string; at: number } | null
  /** The id of the awaiting note whose reason and buttons are shown; one at a time. Pure UI state: pressing runs nothing. */
  openNote?: string | null
}

/** A settle in progress, drawn inside the pane (the session has no AskUserQuestion). `reason`: the Input is asked; `confirm`: the exact reason is shown. `run` is the watch it started under. */
export type BelayPanelSettle = {
  id: string
  action: 'archive' | 'release' | 'reoffer'
  stage: 'reason' | 'confirm'
  reason: string
  title: string
  run: { runId: string | null; dataDir: string | null; cli: string | null; node: string | null }
}

declare module 'claude-code' {
  interface PluginState {
    belay: {
      panelWatch: BelayPanelWatch | null
      panelSnap: BelayPanelSnap | null
      panelUi: BelayPanelUi
      panelSettle: BelayPanelSettle | null
    }
  }
}
