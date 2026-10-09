// The panel: a band above the prompt and a side pane over a belay run. Read-only. It runs belay's own
// read commands by argv, keeps what it read in `$.state`, and draws it. It never writes the store or a
// stream, and it submits nothing to the model: its commands answer with a toast, never with text the
// model would read.
//
// The engine follows `$` only into functions declared at the top of this file, so every helper that
// takes `$` lives here; the pure parts (parsing, drawing) live in model.ts, fetch.ts and view.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { BelayPanelSnap, BelayPanelWatch } from '../../types/index'
import { argvFor, buildSnapshot, fatalSnapshot, fwd, isWindowsPath, parseRan, parseRunFile, projectRootOf, repoCliGuess, type Ran, type RunFileRead } from './fetch'
import { DEFAULT_SETTINGS, DEFAULT_UI } from './model'
import { Band, BandWaiting, Fallback, Pane, type Act, type Els } from './view'

const PANE = 'belay'
const watchA = atom({ plugin: 'belay', key: 'panelWatch' } as const, null)
const snapA = atom({ plugin: 'belay', key: 'panelSnap' } as const, null)
const uiA = atom({ plugin: 'belay', key: 'panelUi' } as const, DEFAULT_UI)

// A round starts this long after the previous round ENDS (a slow belay is never chased).
const PANE_EVERY_MS = 4000
const BAND_EVERY_MS = 5000
const SETTINGS_EVERY_MS = 10000
const COMMAND_TIMEOUT_MS = 4000
// `belay transcript --tail N`: the band reads the last 10 entries (it shows the newest words among them), the pane the last 50. Null would read it all.
const TRANSCRIPT_TAIL: { band: number | null; pane: number | null } = { band: 10, pane: 50 }
const BACKOFF_FIRST_MS = 10000
const BACKOFF_MAX_MS = 60000
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const NO_CLI_WINDOWS = 'belay CLI not found: on Windows set belay_cli and node in belay-run.json, or load this plugin from <repo>/src/mod'

type Host = EngineInterface
type Resolved = { cli: string[] } | { error: string }

// Local to this load of the module. A hot reload drops the timer with the module, and every entry
// point calls ensureTicker, so the first event after a reload starts it again.
let timer: Timer | null = null
let inflight = false
let lastFetchAt = 0
let lastSettingsAt = 0
let timeoutStreak = 0
let backoffUntil = 0

// null: there is no run file. Anything else that goes wrong with an existing file is an error state.
async function readRunFile($: Host): Promise<RunFileRead | null> {
  const path = `${fwd($.plugin.root)}/belay-run.json`
  let exists: boolean
  try { exists = await $.fs.exists(path) } catch { return { error: 'belay-run.json could not be checked' } }
  if (!exists) return null
  try { return parseRunFile((await $.fs.read(path)) as string) } catch { return { error: 'belay-run.json could not be read' } }
}

// Bound by belay-run.json: exactly [node, belay_cli]. A watching session (no file): `node <repo>/src/cli/belay.cjs`
// when the plugin sits at <repo>/src/mod, else `belay` on PATH, which on Windows cannot be started without
// a shell and so is an error naming the fix.
async function resolveCli($: Host, watch: BelayPanelWatch): Promise<Resolved> {
  if (watch.fixed) return watch.cli && watch.node ? { cli: [fwd(watch.node), fwd(watch.cli)] } : { error: 'belay-run.json lacks belay_cli/node' }
  const guess = repoCliGuess($.plugin.root)
  try {
    if (await $.fs.exists(guess)) return { cli: ['node', guess] }
  } catch { /* fall through */ }
  return isWindowsPath($.plugin.root) ? { error: NO_CLI_WINDOWS } : { cli: ['belay'] }
}

// Every command has a hard timeout. A rejection after the full wait (or one that says it timed out) is a
// timeout, which the caller turns into a skipped round and a back-off; any other rejection is a command
// that did not run.
async function runJson($: Host, cli: string[], args: string[], dataDir: string | null, cwd: string | null = null): Promise<Ran> {
  const t0 = await $.clock.now()
  try {
    const r = await $.process.run(argvFor(cli, args, dataDir), { timeoutMs: COMMAND_TIMEOUT_MS, ...(cwd ? { cwd } : {}) })
    return parseRan(args, r)
  } catch (err) {
    const waited = (await $.clock.now()) - t0
    const said = err instanceof Error ? err.message : String(err)
    if (waited >= COMMAND_TIMEOUT_MS - 100 || /time/i.test(said)) return { error: `belay ${args.join(' ')} timed out (${COMMAND_TIMEOUT_MS / 1000} s)`, timedOut: true }
    return parseRan(args, null)
  }
}

const timedOut = (r: Ran | null): boolean => !!r && 'timedOut' in r

// One round: agents, notices, then (headless runs only) the transcript, then settings. Sequential, so at
// most one belay process at a time. The orchestrator's words are read only for a headless run.
// A timeout skips the rest of the round: what was read stays, what was not read is kept from before.
async function fetchSnapshot($: Host, watch: BelayPanelWatch, prev: BelayPanelSnap | null, o: { withSettings: boolean; now: number; open: boolean }): Promise<{ snap: BelayPanelSnap; timedOut: boolean }> {
  if (watch.error) return { snap: fatalSnapshot(watch.error, null, o.now), timedOut: false }
  const r = await resolveCli($, watch)
  if ('error' in r) return { snap: fatalSnapshot(r.error, watch.runId, o.now), timedOut: false }
  const cli = r.cli
  const agents = await runJson($, cli, ['agents', ...(watch.runId ? [watch.runId] : [])], watch.dataDir)
  const seen = 'json' in agents ? (agents.json as { run_id?: string; mode?: string }) : null
  const runId = watch.runId ?? seen?.run_id ?? prev?.runId ?? null
  const runArg = runId ? [runId] : []
  const cut = (a: Ran, n: Ran | null, t: Ran | null, s: Ran | null) => ({ snap: buildSnapshot({ watch, prev, now: o.now, agents: a, notices: n, transcript: t, settings: s }), timedOut: true })
  if (timedOut(agents)) return cut(agents, null, null, null)
  const notices = await runJson($, cli, ['notices', ...runArg], watch.dataDir)
  if (timedOut(notices)) return cut(agents, notices, null, null)
  const mode = watch.fixed ? 'interactive' : seen ? seen.mode : prev?.mode
  const tail = o.open ? TRANSCRIPT_TAIL.pane : TRANSCRIPT_TAIL.band
  const transcript = mode === 'headless' ? await runJson($, cli, ['transcript', ...runArg, ...(tail === null ? [] : ['--tail', String(tail)])], watch.dataDir) : null
  if (timedOut(transcript)) return cut(agents, notices, transcript, null)
  const settings = o.withSettings ? await runJson($, cli, ['settings'], watch.dataDir, watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null) : null
  return { snap: buildSnapshot({ watch, prev, now: o.now, agents, notices, transcript, settings }), timedOut: timedOut(settings) }
}

// Open or close the docked pane. Only a person's action calls this (a command or a press), because an
// unasked open waits undrawn below 144 columns. If the pane is not placed the panel is drawn inline.
async function setOpen($: Host, open: boolean): Promise<void> {
  const snap = await read($, snapA)
  const ui = await read($, uiA)
  let placed = false
  if (open && (snap?.settings ?? DEFAULT_SETTINGS).pane === 'docked') placed = (await $.ui.open({ id: PANE, title: 'belay' })).isPlaced
  if (!open && ui.placed) await $.ui.close({ id: PANE })
  // Opening the panel is the person seeing the notices (decision 3): the current ones are marked seen.
  const seen = open ? [...new Set([...ui.seen, ...(snap?.notices ?? []).map(n => n.key)])].slice(-200) : ui.seen
  await update($, uiA, u => ({ ...u, open, placed, seen }))
  lastFetchAt = 0
  $.ui.invalidate('ui.render')
}

async function tick($: Host): Promise<void> {
  try {
    const watch = await read($, watchA)
    if (!watch) { timer?.cancel(); timer = null; return }
    if (watch.error) return
    const ui = await read($, uiA)
    const now = await $.clock.now()
    if (!inflight && now >= backoffUntil && now - lastFetchAt >= (ui.open ? PANE_EVERY_MS : BAND_EVERY_MS)) {
      inflight = true
      try {
        const prev = await read($, snapA)
        const settingsDue = !prev || now - lastSettingsAt >= SETTINGS_EVERY_MS
        const { snap, timedOut: slow } = await fetchSnapshot($, watch, prev, { withSettings: settingsDue, now, open: ui.open })
        // Back off while commands keep timing out: 10 s, doubling to 60 s; one success resets it.
        timeoutStreak = slow ? timeoutStreak + 1 : 0
        backoffUntil = slow ? (await $.clock.now()) + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (timeoutStreak - 1)) : 0
        if (settingsDue) lastSettingsAt = now
        await update($, snapA, () => snap)
        // `/belay watch` with no id resolved the newest run: pin that id once.
        if (!watch.runId && snap.runId) await update($, watchA, w => (w && !w.runId ? { ...w, runId: snap.runId } : w))
        // While the panel is open, notices that arrive are seen as they arrive.
        if (ui.open) await update($, uiA, u => ({ ...u, seen: [...new Set([...u.seen, ...snap.notices.map(n => n.key)])].slice(-200) }))
        // A switch to above-prompt closes the docked pane. A switch to docked opens nothing from a timer:
        // the panel stays inline until the person reopens it.
        if (ui.open && ui.placed && snap.settings.pane === 'above-prompt') {
          await $.ui.close({ id: PANE })
          await update($, uiA, u => ({ ...u, placed: false }))
        }
      } finally {
        inflight = false
        lastFetchAt = await $.clock.now()
      }
    }
    $.ui.invalidate('ui.render') // the cache countdown ticks locally between fetches
  } catch {
    /* a tick never throws; the next one tries again */
  }
}

function ensureTicker($: Host): void {
  if (timer) return
  timer = $.clock.every(1000, () => { void tick($) })
}

const sameWatch = (a: BelayPanelWatch | null, b: BelayPanelWatch): boolean =>
  !!a && a.runId === b.runId && a.dataDir === b.dataDir && a.cli === b.cli && a.node === b.node && a.fixed === b.fixed && a.error === b.error

// A repeated session.start (a hot reload) with an unchanged watch keeps the snapshot and the seen notices.
async function watchRun($: Host, next: BelayPanelWatch): Promise<void> {
  const cur = await read($, watchA)
  if (sameWatch(cur, next)) { if (!next.error) ensureTicker($); return }
  await update($, watchA, () => next)
  await update($, uiA, u => ({ ...DEFAULT_UI, open: u.open, placed: u.placed }))
  if (next.error) {
    const now = await $.clock.now()
    await update($, snapA, () => fatalSnapshot(next.error as string, null, now))
    return
  }
  await update($, snapA, () => null)
  lastFetchAt = 0
  lastSettingsAt = 0
  timeoutStreak = 0
  backoffUntil = 0
  ensureTicker($)
}

function acts($: Host): Act {
  return {
    select: id => { void update($, uiA, u => ({ ...u, selected: u.selected === id ? null : id })) },
    legend: () => { void update($, uiA, u => ({ ...u, legend: !u.legend })) },
    fold: () => { void update($, uiA, u => ({ ...u, foldOpen: !u.foldOpen })) },
    group: key => { void update($, uiA, u => ({ ...u, groups: u.groups.includes(key) ? u.groups.filter(g => g !== key) : [...u.groups, key].slice(-50) })) },
    seen: key => { void update($, uiA, u => (u.seen.includes(key) ? u : { ...u, seen: [...u.seen, key].slice(-200) })) },
    close: () => { void setOpen($, false) },
    toggle: () => { void read($, uiA).then(u => setOpen($, !u.open)) },
  }
}

export function registerPanel(on: On): void {
  on('session.start', async ($, e, next) => {
    const rf = await readRunFile($)
    if (rf && 'error' in rf) {
      await watchRun($, { runId: null, dataDir: null, cli: null, node: null, error: rf.error, fixed: true })
      return next(e) // the error state: no commands are registered and nothing is read
    }
    if (rf) await watchRun($, { runId: rf.file.runId, dataDir: rf.file.dataDir, cli: rf.file.cli, node: rf.file.node, error: null, fixed: true })
    await $.command.register({ name: 'orch', description: "Toggle belay's panel for the watched run" })
    if (!rf) await $.command.register({ name: 'belay', description: 'Watch a belay run: watch [run-id] | unwatch', argumentHint: 'watch [run-id] | unwatch' })
    const w = await read($, watchA)
    if (w && !w.error) ensureTicker($)
    return next(e)
  })

  on('command.run', { command: 'orch' }, async $ => {
    const w = await read($, watchA)
    if (!w || w.error) { $.ui.toast('belay: no run is watched. /belay watch [run-id]'); return {} }
    ensureTicker($)
    const ui = await read($, uiA)
    await setOpen($, !ui.open)
    return {}
  })

  on('command.run', { command: 'belay' }, async ($, e) => {
    const [verb, id, ...extra] = e.args.trim().split(/\s+/)
    if (verb === 'unwatch') {
      await update($, watchA, () => null)
      await update($, snapA, () => null)
      timer?.cancel(); timer = null
      if ((await read($, uiA)).placed) await $.ui.close({ id: PANE })
      await update($, uiA, u => ({ ...u, open: false, placed: false }))
      $.ui.toast('belay: no longer watching a run.')
    } else if (verb === 'watch' && extra.length === 0 && (id === undefined || RUN_ID.test(id))) {
      const cur = await read($, watchA)
      if (cur?.fixed) $.ui.toast(`belay: this session is bound by belay-run.json to run ${cur.runId}; it cannot be changed.`)
      else {
        await watchRun($, { runId: id ?? null, dataDir: null, cli: null, node: null, error: null, fixed: false })
        $.ui.toast(`belay: watching ${id ?? 'the newest run'}. /orch opens the panel.`)
      }
    } else $.ui.toast('usage: /belay watch [run-id] | /belay unwatch')
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, uiA, u => ({ ...u, open: false, placed: false }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e) as unknown as Els
    const { Box, Text } = E
    const watch = await read($, watchA)
    const snap = await read($, snapA)
    const ui = await read($, uiA)
    const now = await $.clock.now()
    if (!watch) return <Box><Text dimColor>No belay run is watched. /belay watch [run-id]</Text></Box>
    if (!snap) return <BandWaiting E={E} runId={watch.runId} errors={[]} cols={e.props.bodyColumns} />
    const c = { E, snap, ui, now, cols: e.props.bodyColumns, act: acts($) }
    return e.surface === 'terminal' ? <Pane {...c} /> : <Fallback {...c} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const watch = await read($, watchA)
    if (e.props.hasSurvey || !watch) return next(e)
    const E = $.ui.resolve(e) as unknown as Els
    const { Box } = E
    const snap = await read($, snapA)
    const ui = await read($, uiA)
    const now = await $.clock.now()
    if (!snap) return <BandWaiting E={E} runId={watch.runId} errors={[]} cols={e.props.bodyColumns} />
    const c = { E, snap, ui, now, cols: e.props.bodyColumns, act: acts($) }
    // Inline when the person chose above-prompt, or when the docked pane is not seated (a narrow terminal).
    const inline = ui.open && (snap.settings.pane === 'above-prompt' || !ui.placed)
    if (e.surface !== 'terminal') return inline ? <Fallback {...c} /> : <Band {...c} />
    return inline ? <Box flexDirection="column"><Band {...c} /><Pane {...c} /></Box> : <Band {...c} />
  })
}
