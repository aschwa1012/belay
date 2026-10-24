import { mock } from 'claude-code/testing'
export const T0 = 1_000_000_000_000
export const RUN = 'r-7f3a'
export const iso = (ms: number) => new Date(ms).toISOString()
// Fixtures in the shapes belay's commands print today (cmd-agents + agents-derive, cmd-notices,
// cmd-transcript, cmd-settings). The orchestrator is `alive` in the run row; its display_state is derived.
export const TASK4 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const AGENTS = [
  { id: 'orchestrator', role: 'orchestrator', model: 'claude-opus-5-5', effort: 'high', state: 'alive', display_state: 'waiting', display_state_established_by: 'run alive; the last stream event is a call to worker_wait with no result after it', context_tokens: 380000, context_window: 1000000, context_pct: 38, cost_usd: 1.84, cost_source: 'stream', task: null, cache: { ttl_s: 3600, ttl_established_by: 'line uuid u1, message.usage.cache_creation.ephemeral_1h_input_tokens=9', last_request_at_ms: T0 - 12000, age_ms: 12000, left_ms: 3588000, state: 'warm' } },
  { id: 'coder-1', role: null, model: 'claude-sonnet-5-5', effort: 'medium', state: 'running', display_state: 'stalled', display_state_established_by: 'row state running, mid_turn, last event 340000 ms ago by stream mtime (over 300000 ms), pid 22016 alive', context_tokens: 610000, context_window: 1000000, context_pct: 61, cost_usd: 0.92, cost_source: 'worker row cost_usd', pid: 22016, permission_mode: 'auto', claude_code_version: '2.1.293', task: { id: TASK4, title: 'Fix the pid-poll null exit code', title_source: 'first non-empty line of the task spec', source: 'worker row task_id' }, cache: { ttl_s: 3600, ttl_established_by: 'line uuid u2, message.usage.cache_creation.ephemeral_1h_input_tokens=9', last_request_at_ms: T0 - 3000000, age_ms: 3000000, left_ms: 600000 - 1, state: 'low' } },
  { id: 'coder-2', role: null, model: 'claude-sonnet-5-5', effort: 'medium', state: 'running', display_state: 'permission', display_state_established_by: 'a pending permission row names this worker', context_pct: 22, cost_usd: 0.41, task: { id: 't-6', title: 'Add started_at' }, cache: { ttl_s: 300, left_ms: 170000, state: 'warm' } },
  { id: 'rev-1', role: 'reviewer', model: 'claude-opus-5-5', effort: 'high', state: 'running', display_state: 'running', display_state_established_by: 'row state running, mid_turn', context_pct: 80, cost_usd: null, task: { id: 't-5', title: 'Review t-4' }, cache: { ttl_s: 3600, left_ms: 0, state: 'cold' } },
  { id: 'coder-0', role: null, model: 'claude-sonnet-5-5', effort: 'medium', state: 'stopped', display_state: 'done', display_state_established_by: 'worker row state stopped', context_pct: 40, cost_usd: 0.71, task: { id: 't-1', title: 'Embedder warm-up guard' } },
]
export const FOOTER = { agents: 5, total_cost_usd: 3.88, cost_not_recorded: 1, as_of_ms: T0 - 60000, highest_context_pct: 80 }
export const EVENTS = [
  { kind: 'review_verdict', ts: T0 - 1560000, run_id: RUN, task_id: 't-2', executable: true, passed: true, verdict: 'holds', judged_by: 'rev-0' },
  { kind: 'worker_stopped', ts: T0 - 300000, run_id: RUN, worker_id: 'coder-0', exit_code: 0, exit_signal: null, death_established_by: null },
  { kind: 'worker_stalled', ts: T0 - 120000, run_id: RUN, worker_id: 'coder-1', state: 'running', last_event_age_ms: 340000, pid: 22016, pid_alive: true },
  { kind: 'permission_pending', ts: T0 - 60000, run_id: RUN, worker_id: 'coder-2', request_id: 'p-19', tool: 'Bash', age_ms: 60000 },
]
// Real-shaped long notices: a review verdict naming a UUID task, a dead worker with a long cause and "exit 1".
export const LONG_NOTICES = {
  run_id: RUN,
  events: [
    { kind: 'review_verdict', ts: T0 - 1560000, run_id: RUN, task_id: 'b18bb74e-9771-40b3-b4d1-0bb38cac0636', executable: true, passed: true, verdict: 'holds', judged_by: 'reviewer-1' },
    { kind: 'worker_dead', ts: T0 - 900000, run_id: RUN, worker_id: 'coder-0', exit_code: 1, exit_signal: null, death_established_by: 'pid not alive (process exit observed by the adapter)' },
    { kind: 'permission_pending', ts: T0 - 60000, run_id: RUN, worker_id: 'fixer-1', request_id: 'toolu_render_perm_1', tool: 'Bash', age_ms: 60000 },
    { kind: 'worker_stopped', ts: T0 - 300000, run_id: RUN, worker_id: 'reviewer-1', exit_code: 0, exit_signal: null, death_established_by: null },
  ],
}
export const NOTE_ID = '08954ec7-c37a-4f36-9ff5-641811cc54f9'
export const AWAITING = { total: 1, awaiting_operator: 1, entries: [{ note_id: NOTE_ID, project: 'acme', title: 'pid poll note', kind: 'wrong', ground: 'reported', awaiting_operator: true, undecided: { reason: 'cannot say' } }] }
export const NOTICES = { run_id: RUN, events: EVENTS }
const tool = (n: number) => ({ kind: 'tool', tool: 'mcp__belay__worker_wait', ids: { worker_id: `w-${n}` }, tool_use_id: `x${n}`, result: 'ok', error_code: null, ts: iso(T0 - 9000 + n * 100) })
// Words, then five tool calls: the last entries hold no words.
export const LONG_ENTRIES = [tool(1), tool(2), { kind: 'text', text: 'Reviewer 1 is done; creating the fix task.', ts: iso(T0 - 8000) }, tool(3), tool(4), tool(5), tool(6), tool(7)]
// Twelve texts; after text i come 3 tool calls (i odd) or 1 (i even).
export const MANY = Array.from({ length: 12 }, (_, k) => k + 1).flatMap(i => [
  { kind: 'text', text: `Step ${i} is under way.${i === 12 ? ` ${"y".repeat(700)} LAST WORD` : ""}`, ts: iso(T0 - 100000 + i * 1000) },
  ...Array.from({ length: i % 2 ? 3 : 1 }, (_, j) => tool(i * 10 + j)),
])
export const TRANSCRIPT = {
  run_id: RUN,
  entries: [
    { kind: 'text', text: 'Spawned rev-1 on t-5 against head 3e1de17.', ts: iso(T0 - 5000) },
    { kind: 'tool', tool: 'mcp__belay__worker_wait', ids: { worker_id: 'rev-1' }, tool_use_id: 'x', result: 'ok', error_code: null, ts: iso(T0 - 4000) },
  ],
}

export const DEFAULTS: Record<string, string> = { pane: 'docked', marks: 'shapes', cache: 'both', context: 'both', band: 'two-lines', task: 'kind' }
export const NOTICE = { code: 'memory_project_unset', title: 'Memory is off for this project', why: 'Memory notes are on by default, but they are kept per project and belay never guesses a project name, so with none set nothing is saved or recalled.', short: 'set one: belay settings memory.project <name> · or turn notes off: belay settings memory.notes false', fix: 'Add "memory": { "project": "<name>" } to belay.config.json (or to the run spec), or run: belay settings memory.project <name>. A name is lowercase letters, digits, dot, underscore or dash (^[a-z0-9][a-z0-9._-]{0,63}$). To turn notes off and silence this: belay settings memory.notes false.', config_line: '"memory": { "project": "<name>" }', name_rule: '^[a-z0-9][a-z0-9._-]{0,63}$' }
export const SETTINGS = (mod: Record<string, string> = {}, memoryNotice: unknown = null) => ({
  found: true, path: 'C:/x/belay.config.json', parse_error: null, memory_notice: memoryNotice,
  settings: Object.keys(DEFAULTS).map(k => ({ key: `mod.${k}`, value: mod[k] ?? DEFAULTS[k], source: 'default', allowed: [] })),
})
export const FULL_RUNFILE = { role: 'orchestrator', run_id: RUN, data_dir: 'C:/d/.belay', belay_cli: 'C:/x/belay.cjs', node: 'C:/n/node.exe' }
export type World = {
  file?: boolean; runFile?: unknown; repoCli?: boolean; watchId?: string
  mode?: string | null; mod?: Record<string, string>; notices?: unknown
  failAgents?: boolean; transcriptFail?: boolean; orchDisplay?: string; noDisplay?: boolean; noRun?: boolean
  extra?: string[]; paused?: number; ended?: number; maxFix?: number | null; rejectAfter?: { verb: string; ms: number; msg: string }; startedAgo?: number; honorTail?: boolean; toolsOnly?: boolean; nullTs?: boolean; manyTexts?: boolean; longTranscript?: boolean; runId?: string; launcher?: { exitCode: number; stdout: string; stderr: string }; longNotices?: boolean; noPlace?: boolean; coder2Left?: number; coder1Title?: string; hang?: string | null; slow?: number; memoryNotice?: boolean; orchNoCost?: boolean; orchBasis?: string; deadReview?: boolean; deadCoder?: boolean; orchTokensOnly?: boolean; orchCost?: number; awaitingFail?: boolean; awaitingHang?: boolean; agentIds?: string[]; footer?: unknown
  /** Answers the dialogs give, in order (the reason, then the confirm); an empty queue dismisses. */
  awaitingList?: unknown
  settleReject?: string
  /** The launcher's answers, one per start (the last one repeats). */
  /** The launcher's process call itself fails (a timeout, a rejection). */
  launcherReject?: string
  launchers?: { exitCode: number; stdout: string; stderr: string }[]
  /** Held inside the settle's process call: the test looks at the panel while the write is in flight. */
  settleHold?: Promise<void>
  /** Held at the settle's consuming write (the confirm press): the test changes the world meanwhile, then opens the gate. */
  settleGate?: Promise<void>
  settleOut?: { exitCode: number; stdout: string; stderr: string }
}

// The host beneath the plugin: a run file (or none), belay's read commands as fixtures, and a recorder
// of every call the panel makes. An event the panel does not expect has no hook, so the kit throws.
export function world(on: any, w: World) {
  const clock = mock.clock(on, { now: T0 })
  const ran: string[][] = []
  const writes: string[] = []
  const opened: string[] = []
  const openArgs: any[] = [] // every ui.open the panel makes, with its arguments
  const commands: string[] = []
  const toasts: string[] = []
  const spawned: string[][] = [] // every review launcher (`... memory review --project p --start`) the panel runs: only the review button may run one
  const attempts: { verb: string; t: number; timeoutMs: number; cwd?: string; argv: string[] }[] = []
  const stat = { active: 0, maxActive: 0 }
  const settled: string[][] = [] // every `memory held settle` the panel runs: only the settle buttons may run one
  const asked: string[] = [] // every dialog question
  // The real session has no AskUserQuestion (the interactive orchestrator is launched with --tools Read,Glob,Grep,Edit,Write): an ask is
  // recorded and rejected as it is there, so a panel that asks a dialog cannot do its work in these tests.
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    asked.push(String(e.questions?.[0]?.question ?? ''))
    return { deny: 'no tool named "AskUserQuestion"; the session has Bash, Edit, Glob, Grep, Read, Write' }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path.endsWith('belay-run.json') ? (w.file ?? false) : (w.repoCli ?? true) }))
  on('fs.read', () => ({ value: typeof w.runFile === 'string' ? w.runFile : JSON.stringify(w.runFile ?? FULL_RUNFILE) }))
  on('fs.write', ($: any, e: any) => { writes.push(e.path); return { value: undefined } })
  on('prompt.submit', () => { writes.push('prompt.submit'); return { value: undefined } })
  on('command.register', ($: any, e: any) => { commands.push(e.name); return { value: { command: e.name } } })
  on('ui.open', ($: any, e: any) => { opened.push(e.id); openArgs.push({ ...e }); return { value: { isPlaced: !w.noPlace } } })
  // A seam on the settle write's consuming step: the write waits here, after the confirm press and before anything is rechecked.
  let seamFired = false
  on('state.set', { plugin: 'belay', key: 'panelSettle' }, async ($: any, e: any, next: any) => {
    if (w.settleGate && !seamFired && e.value === null && e.previous && e.previous.stage === 'confirm') { seamFired = true; await w.settleGate }
    return next(e)
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', async ($: any, e: any) => {
    if (e.argv.includes('settle')) {
      settled.push([...e.argv])
      if (w.settleHold) await w.settleHold
      if (w.settleReject) return { deny: w.settleReject }
      return { value: w.settleOut ?? { exitCode: 0, stdout: JSON.stringify({ id: e.argv[e.argv.indexOf('settle') + 1], action: 'archive', outcome: 'archived', receipt: 'held-settle:x@1' }), stderr: '' } }
    }
    if (e.argv.includes('--awaiting')) {
      ran.push([...e.argv])
      if (w.awaitingHang) return { deny: 'timed out' }
      if (w.awaitingFail) return { value: { exitCode: 3, stdout: '', stderr: 'boom' } }
      return { value: { exitCode: 0, stdout: JSON.stringify(w.awaitingList ?? AWAITING), stderr: '' } }
    }
    if (e.argv.includes('--start')) {
      spawned.push([...e.argv])
      if (w.launcherReject) return { deny: w.launcherReject }
      if (w.launchers) return { value: w.launchers[Math.min(spawned.length - 1, w.launchers.length - 1)]! }
      return { value: w.launcher ?? { exitCode: 0, stdout: JSON.stringify({ started: true, project: 'acme', run_id: 'r-1', pid: 4242, job: 'archreview-r-1', claim_id: 'me-1' }), stderr: '' } }
    }
    ran.push([...e.argv])
    const verb = e.argv.find((a: string) => ['agents', 'notices', 'transcript', 'settings'].includes(a))
    attempts.push({ verb, t: clock.now(), timeoutMs: e.init?.timeoutMs, cwd: e.init?.cwd, argv: [...e.argv] })
    stat.active += 1
    stat.maxActive = Math.max(stat.maxActive, stat.active)
    try {
      if (w.slow) await clock.sleep(w.slow)
    } finally {
      stat.active -= 1
    }
    if (w.hang && w.hang === verb) return { deny: 'timed out' }
    if (w.rejectAfter && w.rejectAfter.verb === verb) {
      await clock.sleep(w.rejectAfter.ms)
      return { deny: w.rejectAfter.msg }
    }
    const agents = AGENTS.map(a => {
      const x: any = { ...a }
      if (a.id === 'orchestrator' && w.orchDisplay) x.display_state = w.orchDisplay
      if (a.id === 'orchestrator' && w.orchNoCost) x.cost_usd = null
      if (a.id === 'orchestrator' && w.orchCost !== undefined) x.cost_usd = w.orchCost
      if (a.id === 'orchestrator' && w.orchTokensOnly) { x.context_tokens = 18247; x.context_window = null; x.context_pct = null }
      if (a.id === 'orchestrator' && w.orchBasis) x.cost_basis = w.orchBasis
      if (a.id === 'coder-2' && w.coder2Left !== undefined) x.cache = { ttl_s: 300, left_ms: w.coder2Left, state: 'warm' }
      if (a.id === 'coder-1' && w.coder1Title) x.task = { ...a.task, title: w.coder1Title }
      if (w.noDisplay) delete x.display_state
      return x
    })
    const extra = (w.extra ?? []).map(d => ({ id: `w-${d}`, role: null, model: 'claude-sonnet-5-5', state: d, display_state: d, display_state_established_by: `test ${d}`, context_pct: 5, cost_usd: null, task: null }))
    const dead = [...(w.deadReview ? ['archreview-r-7f3a-mvln6h2p'] : []), ...(w.deadCoder ? ['coder-dead'] : [])].map(id => ({ id, role: null, model: 'claude-opus-5-5', state: 'dead', display_state: 'dead', display_state_established_by: 'worker row state dead, death_established_by exit-event', pid: 23184, context_pct: null, cost_usd: 0.12, task: null }))
    const named = (w.agentIds ?? []).map(id => ({ id, role: null, model: 'claude-sonnet-5-5', state: 'running', display_state: 'running', display_state_established_by: 'test', context_pct: 5, cost_usd: 0.1, task: null }))
    const body: Record<string, unknown> = {
      agents: {
        run_id: w.noRun ? null : (w.runId ?? RUN), mode: 'mode' in w ? w.mode : 'headless', mode_source: 'test', started_at_ms: T0 - (w.startedAgo ?? 42 * 60000), paused_at_ms: w.paused ?? null, ended_at_ms: w.ended ?? null,
        tasks: { done: 1, total: 3 }, max_fix_rounds: 'maxFix' in w ? w.maxFix : 2, memory_notice: w.memoryNotice ? NOTICE : null, agents: w.noRun ? [] : [...agents, ...extra, ...named, ...dead], footer: 'footer' in w ? w.footer : FOOTER,
      },
      notices: w.notices ?? (w.longNotices ? LONG_NOTICES : NOTICES),
      transcript: w.nullTs ? { ...TRANSCRIPT, entries: TRANSCRIPT.entries.map(x => ({ ...x, ts: null })) } : w.manyTexts ? { run_id: RUN, entries: MANY } : w.toolsOnly ? { ...TRANSCRIPT, entries: TRANSCRIPT.entries.filter(x => x.kind !== 'text') } : w.longTranscript ? { run_id: RUN, entries: LONG_ENTRIES.slice(-Number(e.argv[e.argv.indexOf('--tail') + 1])) } : w.honorTail ? { ...TRANSCRIPT, entries: TRANSCRIPT.entries.slice(-Number(e.argv[e.argv.indexOf('--tail') + 1])) } : TRANSCRIPT,
      settings: SETTINGS(w.mod, w.memoryNotice ? NOTICE : null),
    }
    if ((verb === 'agents' && w.failAgents) || (verb === 'transcript' && w.transcriptFail)) return { value: { exitCode: verb === 'agents' ? 3 : 4, stdout: '', stderr: 'boom' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(body[verb]), stderr: '' } }
  })
  return { clock, openArgs, settled, asked, ran, writes, opened, commands, toasts, spawned, attempts, stat, w }
}

export const START = { cwd: '/x', surface: 'terminal', isInteractive: true } as const
export const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const
export const PANE_PROPS = { title: 'belay', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
export const PRES = { isFullscreen: true, columns: 110 }
export const cmd = ($: any, command: string, args = '') => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: PRES })
// Every colour a drawing names, to prove they are all theme keys and none a fixed value.
export function colours(node: any, out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach(n => colours(n, out))
    else {
      for (const k of ['color', 'borderColor', 'backgroundColor']) if (typeof node.props?.[k] === 'string') out.push(node.props[k])
      colours(node.children, out)
    }
  }
  return out
}

// Everything a drawing shows, as one string: text children in document order.
export function words(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return (node.type === 'Button' ? String(node.props?.label ?? '') : '') + words(node.children)
}

// A watching session (no run file) by default: /belay watch, then the first tick reads belay.
export async function boot($: any, on: any, w: World = {}) {
  const wd = world(on, w)
  await $.session.start(START)
  if (!w.file) await cmd($, 'belay', `watch ${w.watchId ?? w.runId ?? RUN}`.trim())
  await wd.clock.advance(1000)
  await wd.clock.settle()
  return wd
}
export async function later(wd: any, ms: number) {
  await wd.clock.advance(ms)
  await wd.clock.settle()
}
export async function band($: any, surface = 'terminal', cols = 110) {
  const ui = await $.ui.mount({ plugin: 'belay', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: cols }, viewport: { columns: 110, rows: 40 } })
  return { ui, text: words(await ui.drawn()) }
}
export async function pane($: any, surface = 'terminal', cols = 200, isFocused = false) {
  const ui = await $.ui.mount({ plugin: 'belay', surface, component: 'Pane', requestId: 'belay', props: { ...PANE_PROPS, isFocused, bodyColumns: cols }, viewport: { columns: 70, rows: 40 } })
  return { ui, text: words(await ui.drawn()) }
}
export async function openPane($: any, wd: any) {
  await cmd($, 'orch')
  await later(wd, 2000)
}
export const READ_VERBS = ['agents', 'notices', 'transcript', 'settings']

// A flex row shrinks its items when they do not fit. This is the width each element asks for, so that a
// Box that asks for more than it has (and would squeeze its children) can be found: Text that wraps asks for
// nothing, a Box with a number width asks for that number.
export function widthOf(n: any): number {
  if (n === null || n === undefined || typeof n === 'boolean') return 0
  if (typeof n === 'string' || typeof n === 'number') return [...String(n)].length
  if (Array.isArray(n)) return n.reduce((t: number, x: any) => t + widthOf(x), 0)
  const p = n.props ?? {}
  if (n.type === 'Text') return p.wrap === 'wrap' ? 0 : widthOf(n.children)
  if (n.type === 'Button') return [...String(p.label ?? '')].length
  const extra = (p.paddingLeft ?? 0) + (p.paddingRight ?? 0) + (p.marginLeft ?? 0) + (p.marginRight ?? 0)
  if (typeof p.width === 'number') return p.width + extra
  const kids = Array.isArray(n.children) ? n.children : [n.children]
  const inner = p.flexDirection === 'column' ? Math.max(0, ...kids.map(widthOf)) : kids.reduce((t: number, k: any) => t + widthOf(k), 0)
  return p.flexGrow > 0 ? extra : inner + extra
}
// Every Box without a fixed width whose children ask for more than `room`: those are squeezed.
export function squeezed(n: any, room: number, out: string[] = []): string[] {
  if (n && typeof n === 'object') {
    if (Array.isArray(n)) n.forEach((x: any) => squeezed(x, room, out))
    else {
      if (n.type === 'Box' && typeof n.props?.width !== 'number' && widthOf(n) > room) out.push(`${widthOf(n)} > ${room}: ${words(n).slice(0, 60)}`)
      squeezed(n.children, room, out)
    }
  }
  return out
}
// Every text or button leaf, so a one-character-per-row wrap shows as a stray single letter.
export function leaves(n: any, out: string[] = []): string[] {
  if (n && typeof n === 'object') {
    if (Array.isArray(n)) n.forEach((x: any) => leaves(x, out))
    else if (n.type === 'Text') out.push(words(n))
    else if (n.type === 'Button') out.push(String(n.props?.label ?? ''))
    else leaves(n.children, out)
  }
  return out
}
