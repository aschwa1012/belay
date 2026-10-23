// The panel's drawing: the band, the pane and a plain fallback. Colours are theme keys only. Nothing
// here fetches, writes or submits: a press only calls one of the `Act` handlers the caller passes.

import type { BelayAwaitingNote, BelayEntry, BelayNotice, BelayPanelSnap } from '../../types/index'
import {
  bandLines, cacheSegs, ctxSegs, isLive, markSeg, money, runLine, TONE, unseenNotices, bar,
  memoryTitleSegs, memoryFallbackSegs, type Seg,
} from './model'
import { CONFIRM_MS, confirmLine, heldLine, reviewLine, reviewProject, runningReview, SETTLE_ACTIONS, shortId } from './held'
import { cells, cmdLines, wordWrap } from './wrap'
import { clip, Line, shortModel, tp, type Act, type Ctx, type Els } from './base'
import { Table } from './table'

export type { Act, Els }

// ---- the band ----------------------------------------------------------------------------------

export function Band({ E, snap, ui, now, cols, act }: Ctx) {
  const { Box, Button } = E
  if (snap.fatal) return <Line E={E} w={cols} k="fatal" segs={[{ t: 'belay ', c: 'claude', bold: true }, { t: snap.fatal, c: 'error' }]} />
  const lines = bandLines(snap, ui, now, cols)
  const err = snap.errors[0]
  // The toggle shrinks to a bare mark on a narrow band so the run line keeps its room.
  const toggle = cols >= 60 ? (ui.open ? '  ▾ panel' : '  ▸ panel') : (ui.open ? ' ▾' : ' ▸')
  return (
    <Box flexDirection="column">
      {snap.memoryNotice && <MemoryNotice E={E} snap={snap} cols={cols} />}
      {lines.map((segs, i) => (
        <Box key={`band${i}`}>
          <Line E={E} segs={segs} k={`l${i}`} w={i === 0 ? cols - toggle.length : cols} />
          {i === 0 && <Button key="open" label={toggle} plain dimColor onPress={act.toggle} />}
        </Box>
      ))}
      {err && <Line E={E} w={cols} segs={[{ t: err, dim: true }]} k="err" />}
    </Box>
  )
}

export function BandWaiting({ E, runId, errors, cols = 80 }: { E: Els; runId: string | null; errors: string[]; cols?: number }) {
  const { Box } = E
  return (
    <Box flexDirection="column">
      <Line E={E} w={cols} segs={[{ t: 'belay', c: 'claude', bold: true }, { t: ` ${runId ?? 'latest run'}  `, dim: false }, { t: 'reading…', dim: true }]} k="w" />
      {errors[0] && <Line E={E} w={cols} segs={[{ t: errors[0], dim: true }]} k="we" />}
    </Box>
  )
}

// ---- the table ---------------------------------------------------------------------------------


// ---- notices, orchestrator, legend -------------------------------------------------------------

const hhmm = (ts: number | null): string => (ts === null ? '--:--' : new Date(ts).toTimeString().slice(0, 5))

// The line under a notice. An id wider than the room beside the time moves out to the notice's own indent, whole.
function IdLines({ E, ids, cols }: { E: Els; ids: string; cols: number }) {
  const { Box, Text } = E
  const pl = cells(ids) > cols - 8 ? 2 : 8
  return <Box paddingLeft={pl} flexShrink={0} flexDirection="column">{wordWrap(ids, cols - pl).map((t, i) => <Text key={`i${i}`} dimColor wrap="truncate-end">{clip(t, cols - pl)}</Text>)}</Box>
}

function Notices({ E, snap, ui, act, cols }: Ctx) {
  const { Box, Text, Button } = E
  const ordered = [...snap.notices].sort((a: BelayNotice, b: BelayNotice) => (b.ts ?? 0) - (a.ts ?? 0))
  const fresh = unseenNotices(ordered, ui).length
  if (!ordered.length) return <Line E={E} w={cols} k="nn" segs={[{ t: 'notices', dim: true, bold: true }, { t: '  none', dim: true }]} />
  return (
    <Box flexDirection="column">
      <Line E={E} w={cols} k="nh" segs={[{ t: 'notices', dim: true, bold: true }, ...(fresh ? [{ t: `  ${fresh} new`, c: 'warning' }] : [])]} />
      {ordered.slice(0, 8).map(n => {
        const t = TONE[n.tone]
        const seen = ui.seen.includes(n.key)
        return (
          <Box key={`n-${n.key}`} flexDirection="column">
            <Box>
              <Box width={2} flexShrink={0}><Text color={t.color}>{t.glyph}</Text></Box>
              <Box width={6} flexShrink={0}><Text dimColor>{hhmm(n.ts)}</Text></Box>
              <Button key={`notice:${n.key}`} label={clip(n.text, cols - 8)} plain dimColor={seen} onPress={() => act.seen(n.key)} />
            </Box>
            {n.ids ? <IdLines E={E} ids={n.ids} cols={cols} /> : null}
            {n.cmd ? <Box paddingLeft={2} flexShrink={0} flexDirection="column">{cmdLines(n.cmd, cols - 2).map((t, i) => <Text key={`c${i}`} dimColor wrap="truncate-end">{clip(t, cols - 2)}</Text>)}</Box> : null}
          </Box>
        )
      })}
      {ordered.length > 8 && <Line E={E} w={cols} k="nm" segs={[{ t: `  and ${ordered.length - 8} older`, dim: true }]} />}
    </Box>
  )
}

type Item = { kind: 'text'; e: BelayEntry } | { kind: 'line'; e: BelayEntry } | { kind: 'tools'; key: string; calls: BelayEntry[] }

// The orchestrator's last 8 text entries in full. Between (and after) them the tool calls collapse to one
// dim line, "· N tool calls", that opens on a press. A wake, an operator line or a note stays its own dim line.
export function orchestratorItems(entries: BelayEntry[]): Item[] {
  const items: Item[] = []
  let run: BelayEntry[] = []
  let lastText = ''
  const flush = () => { if (run.length) items.push({ kind: 'tools', key: lastText, calls: run }); run = [] }
  for (const e of entries) {
    if (e.kind === 'tool') run.push(e)
    else if (e.kind === 'text') { flush(); items.push({ kind: 'text', e }); lastText = String(e.ts ?? e.text.slice(0, 24)) }
    else if (e.kind === 'belay' || e.kind === 'operator' || e.kind === 'note') { flush(); items.push({ kind: 'line', e }) }
  }
  flush()
  const texts = items.map((it, i) => (it.kind === 'text' ? i : -1)).filter(i => i >= 0)
  const from = texts.length > 8 ? texts[texts.length - 8]! : 0
  return items.slice(from)
}

// The memory line: how many notes wait on the Opus archive reviewer, and the one button that dispatches it. The first press turns the
// line into a confirm; the second press (inside CONFIRM_MS) dispatches; the timeout or any other press cancels. This Button is the ONLY
// caller of act.review, and act.review is the only way to the dispatch (index.tsx).
// A note waiting on the operator: its short id and why the review could not decide, then archive / release / reoffer.
function SettleRow({ E, cols, n, act }: { E: Els; cols: number; n: BelayAwaitingNote; act: Act }) {
  const { Box, Button } = E
  const head = `  ${shortId(n.id)}${n.reason ? ` · ${n.reason}` : ''}`
  return (
    <Box flexDirection="column" key={`aw-${n.id}`}>
      <Line E={E} w={cols} k={`awl-${n.id}`} segs={[{ t: head, dim: true }]} />
      <Box>{SETTLE_ACTIONS.map(a => <Button key={`${a}-${n.id}`} plain label={`  ▸ ${a}`} onPress={() => act.settle(a, n.id)} />)}</Box>
    </Box>
  )
}

function Held({ E, snap, ui, now, act, cols }: Ctx) {
  const { Box, Button } = E
  const hd = snap.held
  if (!hd) return null
  const project = reviewProject(hd)
  const busy = project !== null && runningReview(hd, project) !== null // a review of that project holds its claim: no second dispatch
  const asking = !busy && !!ui.confirm && project !== null && ui.confirm.project === project && now - ui.confirm.at <= CONFIRM_MS
  return (
    <Box flexDirection="column">
      {hd.reviews.map((r, i) => <Line E={E} w={cols} k={`hr${i}`} segs={[{ t: '◇ ', c: r.state === 'failed' || r.state === 'interrupted' ? 'error' : 'warning' }, { t: reviewLine(r, now), c: r.state === 'failed' || r.state === 'interrupted' ? 'error' : undefined }]} />)}
      {hd.count > 0 && wordWrap(asking && project ? confirmLine(hd, project) : heldLine(hd, now), Math.max(8, cols - 2)).map((t, i) => <Line E={E} w={cols} k={`hl${i}`} segs={[{ t: i === 0 ? '◇ ' : '  ', c: 'warning' }, { t, c: asking ? 'warning' : undefined }]} />)}
      {(hd.awaitingNotes ?? []).map(n => <SettleRow E={E} cols={cols} n={n} act={act} />)}
      {project !== null && !busy && <Button key="review" plain label={asking ? '  ▸ press again to dispatch · any other press cancels' : `  ▸ review the held notes${Object.keys(hd.byProject).length > 1 ? ` (${project} first)` : ''}`} onPress={act.review} />}
    </Box>
  )
}

function Orchestrator({ E, snap, ui, act, cols }: Ctx) {
  const { Box, Text, Button } = E
  const head = <Line E={E} w={cols} k="oh" segs={[{ t: 'orchestrator', dim: true, bold: true }]} />
  if (snap.mode === 'interactive') {
    return <Box flexDirection="column">{head}<Line E={E} w={cols} k="oi" segs={[{ t: 'Interactive: its words are already in its own window.', dim: true }]} /></Box>
  }
  if (snap.mode !== 'headless') return <Box flexDirection="column">{head}<Line E={E} w={cols} k="ou" segs={[{ t: 'run mode unknown', dim: true }]} /></Box>
  const entries = snap.transcript ?? []
  if (!entries.length) return <Box flexDirection="column">{head}<Line E={E} w={cols} k="oe" segs={[{ t: snap.transcript === null ? 'no transcript read yet' : 'no lines yet', dim: true }]} /></Box>
  return (
    <Box flexDirection="column">
      {head}
      {orchestratorItems(entries).map((it, i) => {
        if (it.kind === 'text' || it.kind === 'line') {
          return (
            <Box key={`o${i}`}>
              <Box width={6} flexShrink={0}><Text dimColor>{hhmm(it.e.ts)}</Text></Box>
              <Box flexGrow={1} flexShrink={1}><Text dimColor={it.kind === 'line'} wrap={it.kind === 'text' ? 'wrap' : 'truncate-end'}>{it.e.text}</Text></Box>
            </Box>
          )
        }
        const open = ui.groups.includes(it.key)
        return (
          <Box key={`o${i}`} flexDirection="column">
            <Button key={`tools:${it.key}`} plain dimColor label={`${open ? '▾' : '·'} ${it.calls.length} tool call${it.calls.length === 1 ? '' : 's'}`} onPress={() => act.group(it.key)} />
            {open && it.calls.map((c, j) => <Box key={`o${i}-${j}`} paddingLeft={2}><Text dimColor wrap="truncate-end">{c.text}</Text></Box>)}
          </Box>
        )
      })}
    </Box>
  )
}

function Legend({ E, cols }: Ctx) {
  const { Box } = E
  const m: [string, string, string][] = [
    ['success', '●', 'running'], ['success', '◐', 'waiting inside a call'], ['inactive', '○', 'idle, no turn running'], ['warning', '◌', 'stalled, no event for 5 min'],
    ['permission', '▲', 'needs your approval'],
    // Marks for these three confirmed by the operator, 2026-10-08.
    ['inactive', '●', 'starting or stopping'], ['inactive', '?', 'state unknown'], ['inactive', '‖', 'parked, session kept'], ['error', '✕', 'dead'], ['inactive', '✓', 'finished'],
  ]
  const b = bar(0.6, 4)
  const c: Seg[][] = [
    [{ t: b.on, c: 'success' }, { t: b.off, dim: true }, { t: ' cache time left', dim: true }],
    [{ t: b.on, c: 'suggestion' }, { t: b.off, dim: true }, { t: ' context used', dim: true }],
    [{ t: 'amber', c: 'warning' }, { t: ' look soon', dim: true }], [{ t: 'red', c: 'error' }, { t: ' failed', dim: true }],
    [{ t: 'purple', c: 'merged' }, { t: ' review holds', dim: true }],
  ]
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Line E={E} w={cols} k="lg" segs={[{ t: 'legend · ? closes', dim: true, bold: true }]} />
      {m.map(([col, g, t]) => <Line E={E} w={cols} k={`lg${g}`} segs={[{ t: g, c: col }, { t: ` ${t}`, dim: true }]} />)}
      {c.map((s, i) => <Line E={E} w={cols} k={`lc${i}`} segs={s} />)}
      <Line E={E} w={cols} k="lz" segs={[{ t: '@hh:mm cost is as of the last turn end · → command to act', dim: true }]} />
    </Box>
  )
}

// The compact notice, in the band and at the top of the pane while no memory.project is set: a title and one short line with the fix
// (the full text is in the CLI).
function MemoryNotice({ E, snap, cols }: { E: Els; snap: BelayPanelSnap; cols: number }) {
  const n = snap.memoryNotice
  if (!n) return null
  const { Box } = E
  const body = (t: string, k: string, dim = false) => wordWrap(t, cols - 2).map((l, i) => <Line E={E} w={cols} k={`${k}${i}`} segs={[{ t: `  ${l}`, dim }]} />)
  return (
    <Box flexDirection="column">
      <Line E={E} w={cols} k="mnt" segs={memoryTitleSegs(n)} />
      {body(n.short, 'mns', true)}
    </Box>
  )
}

// ---- the pane ----------------------------------------------------------------------------------

export function Pane(c: Ctx) {
  const { E, snap, ui, now, act, cols } = c
  const { Box, Button } = E
  const t = snap.tasks
  if (snap.fatal) return <Line E={E} w={cols} k="fatal" segs={[{ t: 'belay ', c: 'claude', bold: true }, { t: snap.fatal, c: 'error' }]} />
  const tasksLine: Seg[] = []
  if (t) {
    tasksLine.push({ t: 'tasks ', dim: true })
    if (t.total !== null) {
      const b = bar(t.total ? (t.done ?? 0) / t.total : 0, 10)
      tasksLine.push({ t: b.on, c: 'success' }, { t: b.off, dim: true }, { t: ` ${t.done ?? 0}/${t.total}` })
    } else tasksLine.push({ t: `${t.held} held by agents` })
  }
  if (snap.maxFixRounds !== null) tasksLine.push({ t: '   fix rounds ', dim: true }, { t: `max ${snap.maxFixRounds}` }) // the rounds used are not recorded, so no used count
  if (snap.embedder) tasksLine.push({ t: '   embedder ', dim: true }, { t: snap.embedder, c: snap.embedder === 'ok' ? 'success' : 'warning' })
  const f = snap.footer
  const costLine: Seg[] = f
    ? (f.totalCostUsd === null && !f.asOfMs
      ? [{ t: `no cost recorded yet${f.notRecorded ? ` · ${f.notRecorded} agent${f.notRecorded === 1 ? '' : 's'} unrecorded` : ''}`, dim: true }]
      : [{ t: money(f.totalCostUsd) }, { t: ` as of ${f.asOfMs ? new Date(f.asOfMs).toTimeString().slice(0, 5) : 'unknown'} · ${f.notRecorded} agent${f.notRecorded === 1 ? '' : 's'} unrecorded · moves when a turn ends`, dim: true }])
    : [{ t: 'cost not read', dim: true }]
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Line E={E} w={cols - 6} k="ph" segs={runLine(snap, now)} />
        <Box>
          <Button key="legend" label="?" plain dimColor onPress={act.legend} />
          <Button key="close" label=" ✕" plain dimColor onPress={act.close} />
        </Box>
      </Box>
      <MemoryNotice {...c} />
      {ui.legend && <Legend {...c} />}
      {tasksLine.length > 0 && <Line E={E} w={cols} k="pt" segs={tasksLine} />}
      <Line E={E} w={cols} k="pc" segs={costLine} />
      <Line E={E} w={cols} k="pa" segs={[{ t: `agents ${snap.agents.filter(isLive).length}`, dim: true, bold: true }]} />
      {snap.agents.length ? <Table {...c} /> : <Line E={E} w={cols} k="pn" segs={[{ t: 'no agents read', dim: true }]} />}
      <Notices {...c} />
      {snap.held && <Held {...c} />}
      <Orchestrator {...c} />
      {snap.errors.map((e, i) => <Line E={E} w={cols} k={`pe${i}`} segs={[{ t: e, dim: true }]} />)}
      <Line E={E} w={cols} k="pf" segs={[{ t: snap.held && snap.held.count > 0 ? 'read-only except the review button · /orch toggles' : 'read-only · /orch toggles', dim: true }]} />
    </Box>
  )
}

// ---- other surfaces: the same facts as plain lines ---------------------------------------------

export function Fallback(c: Ctx) {
  const { E, snap, ui, now, cols } = c
  const { Box } = E
  const lines: Seg[][] = [runLine(snap, now)]
  for (const a of snap.agents) {
    lines.push([markSeg(a.state, snap.settings.marks), { t: ` ${a.id} ${shortModel(a.model)} · ` }, ...ctxSegs(a, snap.settings), { t: ' · ' },
      ...cacheSegs(a, snap.settings, snap.fetchedAt, now), { t: ` · ${money(a.costUsd)}` }, { t: a.task ? ` · ${a.task.id}` : '', dim: true }])
  }
  if (snap.memoryNotice) lines.push(memoryFallbackSegs(snap.memoryNotice))
  if (snap.held) { // plain text: the review button is the terminal pane's alone
    for (const r of snap.held.reviews) lines.push([{ t: `◇ ${reviewLine(r)}`, c: 'warning' }])
    if (snap.held.count > 0) lines.push([{ t: `◇ ${heldLine(snap.held, now)}`, c: 'warning' }])
  }
  for (const n of snap.notices) lines.push([{ t: `${TONE[n.tone].glyph} ${n.text}`, c: TONE[n.tone].color, dim: ui.seen.includes(n.key) }])
  if (snap.mode === 'headless') for (const e of (snap.transcript ?? []).slice(-5)) lines.push([{ t: e.text, dim: e.kind !== 'text' }])
  for (const e of snap.errors) lines.push([{ t: e, dim: true }])
  return <Box flexDirection="column">{lines.map((s, i) => <Line E={E} w={cols} segs={s} k={`f${i}`} />)}</Box>
}

