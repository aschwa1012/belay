// The panel: a band above the prompt and a side pane over a belay run. Read-only, with TWO exceptions below. It runs belay's own
// read commands by argv, keeps what it read in `$.state`, and draws it. It never writes the store or a
// stream, and it submits nothing to the model: its commands answer with a toast, never with text the
// model would read.
//
// The one exception, at the operator's request (2026-10-15): the memory line's button runs `belay memory review --project <p> --start`,
// which launches the Opus archive reviewer DETACHED and returns once the review's claim shows in the store. The review writes the store and
// spends money. It is narrowly scoped: exactly that one command; reachable ONLY from the button's onPress (view.tsx Held -> act.review ->
// reviewPress -> dispatchReview), never from a command, a hook, a notice, a tool call, a model or a message; and it needs two presses (the
// first only asks). The launcher is short, so a hot reload of this panel (which ends what the panel spawned) cannot end the review: the
// detached belay CLI is the parent of the Opus child (invariant 1), holds the review's claim in the store, and is read back through belay's
// notices (review_running, review_ended), so a reloaded panel still shows it and offers no second dispatch.
//
// The second exception (ADR 0050 amendment 3, the operator's Memory menu): the Memory tabs write the CONFIG FILE through belay's own commands, never the
// store: `belay settings <key> <value>` for a short list of memory settings (memory.ts SETTABLE), `belay embedder verify` and `belay embedder delete`. They
// are reachable ONLY from a press (view.tsx and memview.tsx act.mem -> memAct -> memPress -> dispatchMenu), need two presses of the same button, and run the
// same validation as the command line, so a refused value shows belay's error and writes nothing. A download, an embed and the GPU runtime's install run for
// minutes and a reload of this panel would end them, so those buttons print the exact command for the person to run.
//
// The engine follows `$` only into functions declared at the top of this file, so every helper that
// takes `$` lives here; the pure parts (parsing, drawing) live in model.ts, fetch.ts and view.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { BelayMenu as BelayMenuT, BelayPanelMenu, BelayPanelSettled, BelayPanelSnap, BelayPanelUi, BelayPanelWatch } from '../../types/index'
import { argvFor, buildSnapshot, fatalSnapshot, fwd, launcherLine, isWindowsPath, needsRun, parseRan, parseRunFile, projectRootOf, refreshEvery, repoCliGuess, roundParts, type Ran, type RunFileRead } from './fetch'
import { CONFIRM_MS, reasonProblem, reviewProject, SETTLE_ACTIONS, SETTLE_UNKNOWN, PENDING_STALE_MS, pruneSettled, settleArgs, settleKind, settleLine, settledActive, shortId, type SettleAction } from './held'
import { DEFAULT_SETTINGS, DEFAULT_UI } from './model'
import { actionId, PROFILE_KEYS, cmdToast, confirmText, cycleDraft, draftOf, gb, modelById, normBadge, normMenu, resultLine, routeFit, routingWrites, sameDraft, writeArgv, type MemAction } from './memory'
import { Band, BandWaiting, Fallback, Pane, type Act, type Els } from './view'

const PANE = 'belay'
const watchA = atom({ plugin: 'belay', key: 'panelWatch' } as const, null)
const snapA = atom({ plugin: 'belay', key: 'panelSnap' } as const, null)
const uiA = atom({ plugin: 'belay', key: 'panelUi' } as const, DEFAULT_UI)
const menuA = atom({ plugin: 'belay', key: 'panelMenu' } as const, { menu: null, error: null, at: 0, behind: 0 } as BelayPanelMenu)
const settleA = atom({ plugin: 'belay', key: 'panelSettle' } as const, null)
const settledA = atom({ plugin: 'belay', key: 'panelSettled' } as const, {} as BelayPanelSettled)

// A round starts after the previous round ENDS (a slow belay is never chased): refreshEvery (fetch.ts) gives the wait, by whether the pane is open and whether the run has ended.
const SETTINGS_EVERY_MS = 10000
const COMMAND_TIMEOUT_MS = 8000 // the panel's patience under host load (reads of 3.5 to 4.8 s were seen), not a product budget
const ROUND_TIMEOUT_MS = 25000 // one panel-read runs up to five reads, each bounded at 6 s inside the verb; this bounds the process
// `belay transcript --tail N`: the band reads the last 10 entries (it shows the newest words among them), the pane the last 50. Null would read it all.
const TRANSCRIPT_TAIL: { band: number | null; pane: number | null } = { band: 10, pane: 50 }
const BACKOFF_FIRST_MS = 10000
const BACKOFF_MAX_MS = 60000
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const REVIEW_ARGS = ['memory', 'review', '--project'] // the one write the panel makes; the project follows, then START_FLAG
const START_FLAG = '--start'
const RUN_FLAG = '--run' // the review acts for the watched run, a live one included (the CLI never defaults to a live run)
const READ_VERBS = ['panel-read'] // the only command runJson runs besides the Memory menu's read: one process that runs the panel's reads
const MENU_EVERY_MS = 30000 // the Memory menu's facts while only the badge needs them; 10 s while the menu is open
const MENU_OPEN_EVERY_MS = 10000
const MEM_TIMEOUT_MS = { set: 20000, delete: 30000, verify: 180000 } as const // a verify hashes the whole model
const START_TIMEOUT_MS = 40000 // the launcher waits up to 20 s for the claim
const NO_CLI_WINDOWS = 'belay CLI not found: on Windows set belay_cli and node in belay-run.json, or load this plugin from <repo>/src/mod'

type Host = EngineInterface
type Resolved = { cli: string[] } | { error: string }

// Local to this load of the module. A hot reload drops the timer with the module, and every entry
// point calls ensureTicker, so the first event after a reload starts it again.
let timer: Timer | null = null
let inflight = false
let lastFetchAt = 0
let lastRunState: BelayPanelSnap['runState'] = null // the last run state any read gave, kept across failed reads
let lastSettingsAt = 0
let timeoutStreak = 0
let backoffUntil = 0
let lastMenuAt = 0
let menuForce = false // a write, or opening the menu, asks for a fresh read now
let menuInflight = false // the menu read runs beside the rounds, never inside one, and one at a time
const starting = new Set<string>() // projects whose launcher is running now (up to START_TIMEOUT_MS); the store's claim is the authority past that

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
async function runJson($: Host, cli: string[], args: string[], dataDir: string | null, cwd: string | null = null, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<Ran> {
  const menuRead = args[0] === 'memory' && args[1] === 'menu' && (args.length === 2 || (args.length === 3 && args[2] === '--badge')) // `belay memory menu [--badge]`: the Memory menu's read
  if (!READ_VERBS.includes(args[0] ?? '') && !menuRead) return { error: `belay ${args[0] ?? ''}: the read helper runs only ${READ_VERBS.join(', ')} and memory menu` } // never a write, whatever called it
  const t0 = await $.clock.now()
  try {
    const r = await $.process.run(argvFor(cli, args, dataDir), { timeoutMs, ...(cwd ? { cwd } : {}) })
    return parseRan(args, r)
  } catch (err) {
    const waited = (await $.clock.now()) - t0
    const said = err instanceof Error ? err.message : String(err)
    if (waited >= timeoutMs - 100 || /time/i.test(said)) return { error: `belay ${args.join(' ')} timed out (${timeoutMs / 1000} s)`, timedOut: true }
    return parseRan(args, null)
  }
}

// One round: `belay panel-read`, one process that runs the reads the panel needs (agents, notices, the awaiting list while a held note waits,
// the transcript for a headless run, settings when they are due) one after another and answers with all of them. A part that timed out ends
// the round inside the verb; what was read stays, what was not read is kept from before (buildSnapshot with prev).
async function fetchSnapshot($: Host, watch: BelayPanelWatch, prev: BelayPanelSnap | null, o: { withSettings: boolean; now: number; open: boolean }): Promise<{ snap: BelayPanelSnap; timedOut: boolean }> {
  if (watch.error) return { snap: fatalSnapshot(watch.error, null, o.now), timedOut: false }
  const r = await resolveCli($, watch)
  if ('error' in r) return { snap: fatalSnapshot(r.error, watch.runId, o.now), timedOut: false }
  const cli = r.cli
  const tail = o.open ? TRANSCRIPT_TAIL.pane : TRANSCRIPT_TAIL.band
  const got = await runJson($, cli, ['panel-read', ...(watch.runId ? [watch.runId] : []), ...(watch.orchDir ? ['--dir', watch.orchDir] : []), ...(tail === null ? [] : ['--tail', String(tail)]), ...(watch.fixed ? ['--fixed'] : []), ...(prev?.mode ? ['--prev-mode', prev.mode] : []), ...(prev?.runId ? ['--prev-run', prev.runId] : []), ...(o.withSettings ? ['--settings'] : [])], watch.dataDir, null, ROUND_TIMEOUT_MS)
  const { parts, slow } = roundParts(got)
  return { snap: buildSnapshot({ watch, prev, now: o.now, ...parts }), timedOut: slow }
}

// The Memory menu's facts: `belay memory menu`, a read (it copies the store to count a heavy embedder's backlog, and starts nothing). Its own atom, so a
// failure shows in the menu and never in the run's errors.
async function fetchMenu($: Host, watch: BelayPanelWatch, full: boolean): Promise<void> {
  const r = await resolveCli($, watch)
  const now = await $.clock.now()
  if ('error' in r) { await update($, menuA, m => ({ ...m, error: r.error, at: now })); return }
  const cli = r.cli
  const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null
  if (!full) { // the badge alone: the selected embedder's backlog, one count
    const light = await runJson($, cli, ['memory', 'menu', '--badge'], watch.dataDir, cwd)
    const behind = 'json' in light ? normBadge(light.json) : null
    await update($, menuA, m => (behind !== null ? { ...m, behind, at: now } : { ...m, error: 'error' in light ? light.error : 'belay memory menu --badge answered something the panel does not read', at: now }))
    return
  }
  const got = await runJson($, cli, ['memory', 'menu'], watch.dataDir, cwd)
  if ('error' in got) { await update($, menuA, m => ({ ...m, error: got.error, at: now })); return }
  const menu = normMenu(got.json)
  await update($, menuA, m => (menu ? { menu, error: null, at: now, behind: menu.behind } : { ...m, error: 'belay memory menu answered something the panel does not read', at: now }))
}

// Open or close the docked pane. Only a person's action calls this (a command or a press), because an
// unasked open waits undrawn below 144 columns. If the pane is not placed the panel is drawn inline.
async function setOpen($: Host, open: boolean): Promise<void> {
  const snap = await read($, snapA)
  const ui = await read($, uiA)
  let placed = false
  if (open && (snap?.settings ?? DEFAULT_SETTINGS).pane === 'docked') placed = (await $.ui.open({ id: PANE, title: 'belay' })).isPlaced
  if (!open && ui.placed) await $.ui.close({ id: PANE })
  if (!open) await update($, settleA, () => null) // a pending settle does not survive the panel closing
  // Opening the panel is the person seeing the notices (decision 3): the current ones are marked seen.
  const seen = open ? [...new Set([...ui.seen, ...(snap?.notices ?? []).map(n => n.key)])].slice(-200) : ui.seen
  await update($, uiA, u => ({ ...u, open, placed, seen }))
  lastFetchAt = 0; backoffUntil = 0 // opening or closing the pane, like a press, reads at once, back-off or not
  $.ui.invalidate('ui.render')
}

async function tick($: Host): Promise<void> {
  try {
    const watch = await read($, watchA)
    if (!watch) { timer?.cancel(); timer = null; return }
    if (watch.error) return
    const ui = await read($, uiA)
    const now = await $.clock.now()
    const known = await read($, snapA)
    // 5 s with the pane open, 10 s for the band alone, 60 s once the run has ended or died: each refresh is one belay process.
    if (!inflight && now >= backoffUntil && now - lastFetchAt >= refreshEvery(ui.open, known?.runState ?? lastRunState)) {
      inflight = true
      try {
        const prev = known
        const settingsDue = !prev || now - lastSettingsAt >= SETTINGS_EVERY_MS
        const { snap, timedOut: slow } = await fetchSnapshot($, watch, prev, { withSettings: settingsDue, now, open: ui.open })
        // Back off while commands keep timing out: 10 s, doubling to 60 s; one success resets it.
        const backOff = slow || snap.stale // a failed agents read backs off like a timeout, so a store that keeps failing is not hammered
        if (snap.runState) lastRunState = snap.runState // a failed read keeps the last known state: an ended run stays at the slow refresh
        timeoutStreak = backOff ? timeoutStreak + 1 : 0
        backoffUntil = backOff ? (await $.clock.now()) + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (timeoutStreak - 1)) : 0
        if (settingsDue) lastSettingsAt = now
        await update($, snapA, () => snap)
        // The Memory menu is read while it is open, after a write, and (for the badge) while the settings name a heavy profile or a routing.
        const everyMs = ui.memTab !== null ? MENU_OPEN_EVERY_MS : MENU_EVERY_MS
        if (!slow && !menuInflight && (menuForce || ((ui.memTab !== null || snap.memWanted) && now - lastMenuAt >= everyMs))) {
          // Off the round: a slow store copy never holds the next round, and never two at once. The request is only spent when a read really starts,
          // so a forced refresh that arrives during a badge read waits for it instead of being dropped.
          const full = menuForce || ui.memTab !== null
          menuForce = false
          lastMenuAt = now
          menuInflight = true
          void fetchMenu($, watch, full).catch(() => { /* a failed read is shown in the menu by the next one */ }).finally(() => { menuInflight = false })
        }
        // The settings stopped naming a heavy tier: the badge goes with them (it would otherwise keep the last count).
        if (!snap.memWanted && ui.memTab === null) await update($, menuA, m => (m.behind === 0 ? m : { ...m, behind: 0 }))
        // `/belay watch` with no id resolved the newest run: pin that id once.
        if (!watch.runId && snap.runId) await update($, watchA, w => (w && !w.runId ? { ...w, runId: snap.runId } : w))
        // While the panel is open, notices that arrive are seen as they arrive.
        if (ui.open) await update($, uiA, u => ({ ...u, seen: [...new Set([...u.seen, ...snap.notices.map(n => n.key)])].slice(-200) }))
        // A pending settle whose note left the list, or whose run changed, is cleared.
        await settleCheck($, snap, watch)
        // A note that has left the list closes.
        if (ui.openNote) await update($, uiA, u => (u.openNote && !(snap.held?.awaitingNotes ?? []).some(n => n.id === u.openNote) ? { ...u, openNote: null } : u))
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
  !!a && a.runId === b.runId && a.dataDir === b.dataDir && a.cli === b.cli && a.node === b.node && a.orchDir === b.orchDir && a.fixed === b.fixed && a.error === b.error

// A repeated session.start (a hot reload) with an unchanged watch keeps the snapshot and the seen notices.
async function watchRun($: Host, next: BelayPanelWatch): Promise<void> {
  const cur = await read($, watchA)
  if (sameWatch(cur, next)) { if (!next.error) ensureTicker($); return }
  await update($, watchA, () => next)
  await update($, uiA, u => ({ ...DEFAULT_UI, open: u.open, placed: u.placed }))
  if (await read($, settleA)) { await update($, settleA, () => null); $.ui.toast('belay: the watched run changed, so the settle was cleared.') }
  if (next.error) {
    const now = await $.clock.now()
    await update($, snapA, () => fatalSnapshot(next.error as string, null, now))
    return
  }
  await update($, snapA, () => null)
  lastFetchAt = 0
  lastRunState = null
  lastSettingsAt = 0
  lastMenuAt = 0
  menuForce = false
  menuInflight = false // a read of the old watch may still finish; it writes the atom below only if it finishes after this reset, which a later read corrects
  timeoutStreak = 0
  backoffUntil = 0
  await update($, menuA, () => ({ menu: null, error: null, at: 0, behind: 0 })) // another run, another store: nothing of the last one's menu stays
  ensureTicker($)
}

// Run the launcher `belay memory review --project <p> --start`: it starts the review detached, waits for its claim, prints it and exits. The
// panel toasts what it printed (the proof) or why it refused or failed. The review itself is read back through belay's notices.
// Called from reviewPress below and from nowhere else.
async function dispatchReview($: Host, project: string): Promise<void> {
  const watch = await read($, watchA)
  if (!watch || watch.error) { $.ui.toast('belay: no run is watched, so the review was not started.'); return }
  const r = await resolveCli($, watch)
  if ('error' in r) { $.ui.toast(`belay: the review was not started: ${r.error}`); return }
  if (starting.has(project)) { $.ui.toast(`belay: an archive review of ${project} is being started.`); return }
  starting.add(project)
  const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null
  // First without --run: the CLI chooses the newest ended run with notes on. Only if it says the one run with notes on is live (E_NOT_FOUND with live_run) is it
  // asked again, once, with the watched run named.
  const attempts: string[][] = [[], ...(watch.runId ? [[RUN_FLAG, watch.runId]] : [])]
  try {
    let res = { exitCode: 1, stdout: '', stderr: '' }
    for (const runArg of attempts) {
      res = await $.process.run(argvFor(r.cli, [...REVIEW_ARGS, project, START_FLAG, ...runArg], watch.dataDir), { timeoutMs: START_TIMEOUT_MS, ...(cwd ? { cwd } : {}) })
      if (!needsRun(res.exitCode, res.stdout, res.stderr, watch.runId)) break
    }
    $.ui.toast(launcherLine(res.exitCode, res.stdout, res.stderr, project))
  } catch (err) {
    $.ui.toast(`belay: the review launcher did not answer (${firstLine(err instanceof Error ? err.message : String(err)) || 'no reason given'}): whether it started is unknown; the notes line shows a running review`)
  } finally { starting.delete(project) }
}

const firstLine = (s: string): string => (s.split('\n').map(l => l.trim()).find(l => l !== '') ?? '').slice(0, 200)

// The review button. First press: ask (the memory line turns into a confirm). Second press inside CONFIRM_MS, for the same project:
// dispatch. The confirm is cleared either way. Any other press clears it too (calm below), and a timeout ends it (the line checks the age).
async function reviewPress($: Host): Promise<void> {
  const ui = await read($, uiA)
  const snap = await read($, snapA)
  const project = reviewProject(snap?.held ?? null)
  if (!project) return
  const now = await $.clock.now()
  if (ui.confirm && ui.confirm.project === project && now - ui.confirm.at <= CONFIRM_MS) {
    await update($, uiA, u => ({ ...u, confirm: null }))
    await dispatchReview($, project)
    return
  }
  await update($, uiA, u => ({ ...u, confirm: { project, at: now } }))
}

// ---- the Memory menu: tabs and routing picks change what is drawn; a write needs two presses and goes through belay's own commands -------------------
// Called from memPress below and from nowhere else. The argv comes from writeArgv (memory.ts): a settings key from a short list, or a model the menu lists.
async function dispatchMenu($: Host, a: MemAction, menu: BelayMenuT): Promise<void> {
  const watch = await read($, watchA)
  if (!watch || watch.error) { $.ui.toast('belay: no run is watched, so nothing was written.'); return }
  const r = await resolveCli($, watch)
  if ('error' in r) { $.ui.toast(`belay: nothing was written: ${r.error}`); return }
  const ui = await read($, uiA)
  const steps: MemAction[] = a.kind === 'saveRouting' ? [routingWrites(ui.routeDraft ?? draftOf(menu))] : [a]
  const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null
  let ok = true
  for (const step of steps) {
    const argv = writeArgv(step, menu)
    if ('error' in argv) { $.ui.toast(`belay: ${argv.error}`); ok = false; break }
    try {
      const res = await $.process.run(argvFor(r.cli, argv[0]!, watch.dataDir), { timeoutMs: step.kind === 'set' || step.kind === 'setMany' ? MEM_TIMEOUT_MS.set : step.kind === 'delete' ? MEM_TIMEOUT_MS.delete : MEM_TIMEOUT_MS.verify, ...(cwd ? { cwd } : {}) })
      // A profile write names the runs that are live NOW, so the menu is read again first (the cached one is up to 10 s old).
      const fresh = step.kind === 'set' && res.exitCode === 0 && PROFILE_KEYS.includes(step.key) ? await freshMenu($, watch, menu) : { menu, stale: false }
      $.ui.toast(resultLine(step, res.exitCode, res.stdout, res.stderr, fresh.menu) + (fresh.stale ? ' (the live-run list could not be re-read and may be out of date)' : ''))
      if (res.exitCode !== 0) { ok = false; break }
    } catch (err) {
      $.ui.toast(`belay: ${step.kind} did not finish: ${firstLine(err instanceof Error ? err.message : String(err)) || 'no answer'}`)
      ok = false
      break
    }
  }
  if (ok && a.kind === 'saveRouting') await update($, uiA, u => ({ ...u, routeDraft: null }))
  lastSettingsAt = 0 // what was written shows on the next round
  lastFetchAt = 0; backoffUntil = 0
  menuForce = true
  $.ui.invalidate('ui.render')
}

// A write's button. First press: ask (the banner turns into a confirm). Second press of the same button inside CONFIRM_MS: run it. A routing that does
// not fit, and a model the settings use, are refused here before any question, so a press never ends in silence.
async function memPress($: Host, a: MemAction): Promise<void> {
  const menu = (await read($, menuA)).menu
  if (!menu) { $.ui.toast('belay: the Memory menu has not been read yet.'); return }
  const ui = await read($, uiA)
  if (a.kind === 'saveRouting') {
    const d = ui.routeDraft ?? draftOf(menu)
    if (sameDraft(menu, d)) { $.ui.toast('belay: the routing has no changes to save.'); return }
    const fit = routeFit(menu, d)
    if (fit.ok === false) { $.ui.toast(`belay: the routing was not saved: its GPU models need ${gb(fit.needMb)} with headroom and ${gb(fit.freeMb ?? 0)} is free.`); return }
  }
  if (a.kind === 'delete') {
    const row = modelById(menu, a.model)
    if (row && row.inUse) { $.ui.toast(`belay: ${row.id} is in use by ${row.inUseBy.join(', ')}; it was not deleted.`); return }
  }
  const now = await $.clock.now()
  const id = actionId(a)
  if (ui.memConfirm && ui.memConfirm.id === id && now - ui.memConfirm.at <= CONFIRM_MS) {
    await update($, uiA, u => ({ ...u, memConfirm: null }))
    await dispatchMenu($, a, menu)
    return
  }
  await update($, uiA, u => ({ ...u, confirm: null, memConfirm: { id, text: confirmText(a, menu), at: now } }))
}

async function freshMenu($: Host, watch: BelayPanelWatch, was: BelayMenuT): Promise<{ menu: BelayMenuT; stale: boolean }> {
  try { await fetchMenu($, watch, true) } catch { return { menu: was, stale: true } }
  const got = await read($, menuA) // a failed read leaves the old menu in place and sets `error`
  return got.error || !got.menu ? { menu: was, stale: true } : { menu: got.menu, stale: false }
}

// One press of the Memory menu: a tab or a routing pick changes only what is drawn; a `cmd` prints the command to run (a download, an embed and the
// GPU runtime's install last long and a reload of this panel would end them, so the person runs them); the rest are writes (memPress).
async function memAct($: Host, a: MemAction): Promise<void> {
  if (a.kind === 'tab') {
    await update($, uiA, u => ({ ...u, confirm: null, memConfirm: null, memNote: null, memTab: a.tab === 'main' ? null : a.tab }))
    if (a.tab !== 'main') menuForce = true
    $.ui.invalidate('ui.render')
  } else if (a.kind === 'cycle') {
    const menu = (await read($, menuA)).menu
    if (menu) await update($, uiA, u => ({ ...calm(u), routeDraft: cycleDraft(menu, u.routeDraft ?? draftOf(menu), a.side, a.type) }))
  } else if (a.kind === 'cmd') {
    await update($, uiA, u => ({ ...calm(u), memNote: `run in a terminal: ${a.line}` }))
    $.ui.toast(cmdToast(a.line))
  } else if (a.kind === 'refresh') {
    menuForce = true
  } else await memPress($, a)
}

// The settle of a held note that waits on the operator, inside the pane (the interactive orchestrator has no AskUserQuestion, so nothing here asks
// a dialog). Four steps, each a press of a drawn element:
//   1. a settle button of the open note (view.tsx SettleRow -> act.settle -> settleStart) starts the reason stage: an Input and a cancel button;
//   2. Enter in the Input (act.reason -> reasonSubmit) checks the reason and moves to the confirm stage, which shows the exact reason;
//   3. the confirm button (act.confirm -> settlePress) is the ONLY way to the write: `belay memory held settle <id> --<action> --reason <text>`;
//   4. cancel, closing or opening a note, the note leaving the list or a change of run clears the pending state (the settleA atom).
// The reason is one argv element. Steps 1 and 2 and cancel run no process.
const settling = new Set<string>() // note ids whose settle is running
let inlineFocused = false // the inline band has no focus prop: true only after a $.ui.focus on its Input was answered without a denial

async function settleStart($: Host, action: SettleAction, id: string): Promise<void> {
  if (!SETTLE_ACTIONS.includes(action)) { $.ui.toast(`belay: unknown action ${action}.`); return }
  const snap = await read($, snapA)
  const listed = (snap?.held?.awaitingNotes ?? []).find(n => n.id === id)
  if (!listed) { $.ui.toast(`belay: note ${shortId(id)} no longer awaits you.`); return } // only a note belay named as waiting on the operator
  const watch = await read($, watchA)
  if (!watch || watch.error) { $.ui.toast('belay: no run is watched, so a note cannot be settled.'); return }
  if (settling.has(id) || settledActive((await read($, settledA))[id], snap, id)) { $.ui.toast(`belay: note ${shortId(id)} was just settled; wait for the next read before acting on it again.`); return }
  await update($, uiA, calm)
  await update($, settleA, () => ({ id, action, stage: 'reason', reason: '', title: listed.title, run: { runId: watch.runId, dataDir: watch.dataDir, cli: watch.cli, node: watch.node } }))
  void focusReason($, snap, id) // not awaited: the Input is drawn only after this press returns, and the ring can move to it only then
}

// The Input is `autoFocus`, which takes the ring when the site takes the keyboard. A pane Button's click or hotkey can take it too, but the panel does not rely
// on that: a docked pane is asked for the keys (`ui.open` with `focus`, a request and not a grant), which puts the ring on the autoFocus Input. That is the
// one focus call; a second `$.ui.focus` on the docked pane is denied as redundant ("the focus moved meanwhile"), so only the inline band, which has no pane
// to open, gets `$.ui.focus`. A refusal toasts nothing: the dim hint line in the reason stage, drawn while the pane is not focused, is the signal.
async function focusReason($: Host, snap: BelayPanelSnap | null, id: string): Promise<void> {
  const ui = await read($, uiA)
  inlineFocused = false
  if (!ui.open) return
  const inline = (snap?.settings ?? DEFAULT_SETTINGS).pane === 'above-prompt' || !ui.placed
  try {
    if (inline) { const r = await $.ui.focus({ requestId: 'above-prompt', key: `reason:${id}` }); inlineFocused = !r.deny; $.ui.invalidate('ui.render') }
    else await $.ui.open({ id: PANE, title: 'belay', focus: true })
  } catch { /* the hint line shows while the pane is not focused */ }
}

// Enter in the reason Input. A reason that cannot be sent is toasted and the Input stays; a good one moves to the confirm stage. Nothing is run.
async function reasonSubmit($: Host, value: string): Promise<void> {
  const p = await read($, settleA)
  if (!p || p.stage !== 'reason') { $.ui.toast('belay: no reason is being asked for.'); return }
  const reason = value.trim()
  if (reason === '') { $.ui.toast('belay: type a reason first, or press cancel.'); return }
  const problem = reasonProblem(reason)
  if (problem) { $.ui.toast(problem); return }
  await update($, settleA, s => (s && s.id === p.id && s.stage === 'reason' ? { ...s, stage: 'confirm', reason } : s))
}

async function settlePress($: Host, pressed: string): Promise<void> {
  const p = await read($, settleA)
  if (!p || p.stage !== 'confirm' || p.id !== pressed) { $.ui.toast('belay: no settle is waiting for a confirm.'); return }
  const { action, id, reason } = p
  if (settling.has(id)) { $.ui.toast(`belay: note ${shortId(id)} is being settled.`); return }
  if (settledActive((await read($, settledA))[id], await read($, snapA), id)) { await update($, settleA, () => null); $.ui.toast(`belay: note ${shortId(id)} was just settled; it was not settled again.`); return }
  settling.add(id)
  try {
    await update($, settleA, () => null) // consumed: a second press of the button finds nothing
    // The reason stage can stay open for minutes: the note and the watched run are checked again before anything is written.
    const watch = await read($, watchA)
    if (!watch || watch.error) { $.ui.toast('belay: no run is watched, so the note was not settled.'); return }
    if (watch.runId !== p.run.runId || watch.dataDir !== p.run.dataDir || watch.cli !== p.run.cli || watch.node !== p.run.node) { $.ui.toast('belay: the watched run changed since you started, so the note was not settled.'); return }
    const now = await read($, snapA)
    if (!(now?.held?.awaitingNotes ?? []).some(n => n.id === id)) { $.ui.toast(`belay: note ${shortId(id)} no longer awaits you, so it was not settled.`); return }
    const r = await resolveCli($, watch)
    if ('error' in r) { $.ui.toast(`belay: the note was not settled: ${r.error}`); return }
    // Written BEFORE the process runs: a hot reload that drops this function mid-settle leaves the note refused, as an unknown outcome, not open to a second settle.
    const t0 = await $.clock.now()
    await update($, settledA, m => ({ ...m, [id]: { label: 'settling…', at: t0, pending: true as const } }))
    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null
    try {
      const res = await $.process.run(argvFor(r.cli, settleArgs(action, id, reason), watch.dataDir), { timeoutMs: START_TIMEOUT_MS, ...(cwd ? { cwd } : {}) })
      const line = settleLine(res.exitCode, res.stdout, res.stderr)
      $.ui.toast(line)
      await markSettled($, id, line)
    } catch {
      $.ui.toast(SETTLE_UNKNOWN) // the command was started and did not answer (a timeout included): it may have written
      await markSettled($, id, SETTLE_UNKNOWN)
    }
  } finally { settling.delete(id) }
}

// The operator looked (belay memory held) after an unknown outcome. The row is not opened at once: it is marked re-checking, stamped now, so only a read started after
// this decides whether the note is still there; and not while a settle of it is still running.
async function recheckNote($: Host, id: string): Promise<void> {
  if (settling.has(id)) { $.ui.toast(`belay: note ${shortId(id)} is being settled; wait for it to finish.`); return }
  const at = await $.clock.now()
  await update($, settledA, m => (m[id] && (m[id]!.pending !== true || at - m[id]!.at > PENDING_STALE_MS) ? { ...m, [id]: { label: 're-checking', at } } : m))
  lastFetchAt = 0; backoffUntil = 0
  $.ui.invalidate('ui.render')
}

// Whatever the settle's outcome (written, unknown, refused), the note stays hidden and refused until a read taken after it has caught up: the snapshot the
// rechecks read is the one from before the write, and a second settle on it would write twice. The next tick reads at once.
async function markSettled($: Host, id: string, line: string): Promise<void> {
  const at = await $.clock.now() // stamped after the process returned; the API has only the epoch clock (no monotonic one), so this is compared with fetchedAt in the same clock
  const k = settleKind(line)
  await update($, settledA, m => pruneSettled({ ...m, [id]: { label: k.label, at, ...(k.kind === 'unknown' ? { unknown: true as const } : {}) } }, id))
  lastFetchAt = 0; backoffUntil = 0
  $.ui.invalidate('ui.render')
}

// A pending settle whose note has left the list, or whose run is no longer the watched one, is cleared, and the person is told.
async function settleCheck($: Host, snap: BelayPanelSnap, watch: BelayPanelWatch): Promise<void> {
  const p = await read($, settleA)
  if (!p) return
  const same = watch.runId === p.run.runId && watch.dataDir === p.run.dataDir && watch.cli === p.run.cli && watch.node === p.run.node
  const listed = (snap.held?.awaitingNotes ?? []).some(n => n.id === p.id)
  if (same && listed) return
  await update($, settleA, () => null)
  $.ui.toast(same ? `belay: note ${shortId(p.id)} no longer awaits you, so the settle was cleared.` : 'belay: the watched run changed, so the settle was cleared.')
}

// Every press that is not the review button cancels a pending confirm.
const calm = (u: BelayPanelUi): BelayPanelUi => (u.confirm || u.memConfirm ? { ...u, confirm: null, memConfirm: null } : u)

function acts($: Host): Act {
  return {
    select: id => { void update($, uiA, u => ({ ...calm(u), selected: u.selected === id ? null : id })) },
    legend: () => { void update($, uiA, u => ({ ...calm(u), legend: !u.legend })) },
    fold: () => { void update($, uiA, u => ({ ...calm(u), foldOpen: !u.foldOpen })) },
    group: key => { void update($, uiA, u => ({ ...calm(u), groups: u.groups.includes(key) ? u.groups.filter(g => g !== key) : [...u.groups, key].slice(-50) })) },
    seen: key => { void update($, uiA, u => (u.seen.includes(key) && !u.confirm ? u : { ...calm(u), seen: u.seen.includes(key) ? u.seen : [...u.seen, key].slice(-200) })) },
    close: () => { void update($, settleA, () => null); void update($, uiA, calm).then(() => setOpen($, false)) },
    toggle: () => { void update($, settleA, () => null); void update($, uiA, calm).then(() => read($, uiA)).then(u => setOpen($, !u.open)) },
    review: () => { void reviewPress($) },
    mem: a => { void memAct($, a) },
    settle: (action, id) => { void settleStart($, action, id) },
    reason: value => { void reasonSubmit($, value) },
    cancel: () => { void update($, settleA, () => null) },
    recheck: id => { void recheckNote($, id) },
    commit: id => { void settlePress($, id) },
    note: id => { void update($, settleA, () => null); void update($, uiA, u => ({ ...calm(u), openNote: u.openNote === id ? null : id })) }, // opening, switching or closing a note drops a pending settle
  }
}

export function registerPanel(on: On): void {
  on('session.start', async ($, e, next) => {
    const rf = await readRunFile($)
    if (rf && 'error' in rf) {
      await watchRun($, { runId: null, dataDir: null, cli: null, node: null, error: rf.error, fixed: true })
      return next(e) // the error state: no commands are registered and nothing is read
    }
    if (rf) await watchRun($, { runId: rf.file.runId, dataDir: rf.file.dataDir, cli: rf.file.cli, node: rf.file.node, orchDir: rf.file.orchDir, error: null, fixed: true })
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
    if (e.id === PANE && e.origin.kind === 'person') { await update($, settleA, () => null); await update($, uiA, u => ({ ...u, open: false, placed: false })) }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e) as unknown as Els
    const { Box, Text } = E
    const watch = await read($, watchA)
    const snap = await read($, snapA)
    const ui = await read($, uiA)
    const now = await $.clock.now()
    const menu = await read($, menuA)
    if (!watch) return <Box><Text dimColor>No belay run is watched. /belay watch [run-id]</Text></Box>
    if (!snap) return <BandWaiting E={E} runId={watch.runId} errors={[]} cols={e.props.bodyColumns} />
    const c = { E, snap, ui, now, cols: e.props.bodyColumns, act: acts($), pend: await read($, settleA), focused: e.props.isFocused, settled: await read($, settledA), menu }
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
    const menu = await read($, menuA)
    if (!snap) return <BandWaiting E={E} runId={watch.runId} errors={[]} cols={e.props.bodyColumns} />
    const c = { E, snap, ui, now, cols: e.props.bodyColumns, act: acts($), pend: await read($, settleA), focused: inlineFocused, settled: await read($, settledA), menu } // the band has no focus prop: the hint is for the docked pane
    // Inline when the person chose above-prompt, or when the docked pane is not seated (a narrow terminal).
    const inline = ui.open && (snap.settings.pane === 'above-prompt' || !ui.placed)
    if (e.surface !== 'terminal') return inline ? <Fallback {...c} /> : <Band {...c} />
    return inline ? <Box flexDirection="column"><Band {...c} /><Pane {...c} /></Box> : <Band {...c} />
  })
}
