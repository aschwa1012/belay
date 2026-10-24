// The panel's drawing: the band, the pane and a plain fallback. Colours are theme keys only. Nothing
// here fetches, writes or submits: a press only calls one of the `Act` handlers the caller passes.

import type { BelayAwaitingNote, BelayEntry, BelayMemoryNotice, BelayNotice, BelayPanelSettle, BelayPanelSnap } from '../../types/index'
import {
  bandLines, cacheSegs, ctxSegs, isLive, markSeg, money, runLine, TONE, unseenNotices, bar,
  memoryTitleSegs, memoryFallbackSegs, staleLine, type Seg,
} from './model'
import { CONFIRM_MS, confirmLine, heldDetail, heldLine, reviewLine, reviewProject, REASON_MAX, runningReview, SETTLE_ACTIONS, settleConfirm, settleEntryView, settledActive, shortId } from './held'
import { cells, cmdLines, wordWrap, wrapHard } from './wrap'
import { clip, INDENT, Line, Section, shortModel, tp, type Act, type Ctx, type Els } from './base'
import { Table } from './table'

export type { Act, Els }

// ---- the band ----------------------------------------------------------------------------------

export function Band({ E, snap, ui, now, cols, act }: Ctx) {
  const { Box, Button } = E
  if (snap.fatal) return <Line E={E} w={cols} k="fatal" segs={[{ t: 'belay ', c: 'claude', bold: true }, { t: snap.fatal, c: 'error' }]} />
  const lines = bandLines(snap, ui, now, cols)
  const err = snap.errors[0]
  const stale = staleLine(snap)
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
      {stale && wrapHard(stale, cols).map((t, i) => <Line E={E} w={cols} segs={[{ t, dim: true }]} k={`stale${i}`} />)}
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
const ATTN = 'warning' // the one accent for what waits on the operator; a failure keeps `error`

// The line under a notice. An id wider than the room beside the time moves out to the notice's own indent, whole.
function IdLines({ E, ids, cols }: { E: Els; ids: string; cols: number }) {
  const { Box, Text } = E
  const pl = cells(ids) > cols - 8 ? 2 : 8
  return <Box paddingLeft={pl} flexShrink={0} flexDirection="column">{wordWrap(ids, cols - pl).map((t, i) => <Text key={`i${i}`} dimColor wrap="truncate-end">{clip(t, cols - pl)}</Text>)}</Box>
}

// Rows are drawn at the section's inner width. One line each: the id goes beside the text when both fit, and is left out when the
// text already names it; only an id that does not fit beside the text takes the line under it.
function Notices({ E, snap, ui, act, cols }: Ctx) {
  const { Box, Text, Button } = E
  const ordered = [...snap.notices].sort((a: BelayNotice, b: BelayNotice) => (b.ts ?? 0) - (a.ts ?? 0))
  const fresh = unseenNotices(ordered, ui).length
  const inner = cols - INDENT
  if (!ordered.length) return <Section E={E} k="sn" title="NOTICES" cols={cols} summary={[{ t: 'none', dim: true }]} />
  return (
    <Section E={E} k="sn" title="NOTICES" cols={cols} summary={fresh ? [{ t: `${fresh} new`, c: ATTN }] : []}>
      {ordered.slice(0, 8).map(n => {
        const t = TONE[n.tone]
        const seen = ui.seen.includes(n.key)
        const room = inner - 8
        const fits = cells(n.text) <= room
        const named = !n.ids || n.text.includes(n.ids)
        const inline = fits && !named && cells(n.text) + 2 + cells(n.ids) <= room
        return (
          <Box key={`n-${n.key}`} flexDirection="column">
            <Box>
              <Box width={2} flexShrink={0}><Text color={t.color}>{t.glyph}</Text></Box>
              <Box width={6} flexShrink={0}><Text dimColor>{hhmm(n.ts)}</Text></Box>
              <Button key={`notice:${n.key}`} label={clip(n.text, room)} plain dimColor={seen} onPress={() => act.seen(n.key)} />
              {inline ? <Text dimColor>{`  ${n.ids}`}</Text> : null}
            </Box>
            {n.ids && !inline && !(fits && named) ? <IdLines E={E} ids={n.ids} cols={inner} /> : null}
            {n.cmd ? <Box paddingLeft={2} flexShrink={0} flexDirection="column">{cmdLines(n.cmd, inner - 2).map((t, i) => <Text key={`c${i}`} dimColor wrap="truncate-end">{clip(t, inner - 2)}</Text>)}</Box> : null}
          </Box>
        )
      })}
      {ordered.length > 8 && <Line E={E} w={inner} k="nm" segs={[{ t: `and ${ordered.length - 8} older`, dim: true }]} />}
    </Section>
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

// A note waiting on the operator, one line: a mark, its short id, the title and why the review could not decide. A press opens it (state
// only, nothing runs): the whole title and the whole reason on their own lines, then archive / release / reoffer. Only an open note has buttons.
function SettleRow({ E, cols, n, act, open, pend, focused, done }: { E: Els; cols: number; n: BelayAwaitingNote; act: Act; open: boolean; pend: BelayPanelSettle | null; focused: boolean; done: { label: string; unknown: boolean; pending: boolean } | null }) {
  const { Box, Text, Button, Input } = E
  const mine = open && pend && pend.id === n.id ? pend : null // this note's settle in progress: the reason Input, then the confirm
  const room = Math.max(0, cols - 4 - 8) // the attention mark, the open mark and the id
  const whole = (n.title ? ` "${n.title}"` : '') + (n.reason ? ` · ${n.reason}` : '')
  const fits = cells(whole) <= room
  // Whole when it fits; otherwise the title takes at most 40% of the room (none under 9 cells) and the reason the rest, clipped with an ellipsis.
  const title = fits ? (n.title ? ` "${n.title}"` : '') : n.title && room >= 9 ? ` "${clip(n.title, Math.max(6, Math.floor(room * 0.4)))}"` : ''
  const left = room - cells(title)
  const reason = n.reason && (fits || left >= 8) ? ` · ${fits ? n.reason : clip(n.reason, left - 3)}` : ''
  const press = () => act.note(n.id)
  // The buttons wrap onto more lines when three do not fit.
  const rows: string[][] = [[]]
  let w = 0
  for (const a of SETTLE_ACTIONS) {
    const lw = cells(`  ▸ ${a}`)
    if (w > 0 && w + lw > cols) { rows.push([]); w = 0 }
    rows[rows.length - 1]!.push(a)
    w += lw
  }
  return (
    <Box flexDirection="column" key={`aw-${n.id}`}>
      <Box>
        <Text color={ATTN}>▲ </Text>
        <Button key={`note:${n.id}`} plain dimColor label={`${open ? '▾' : '▸'} ${shortId(n.id)}`} onPress={press} />
        {title ? <Button key={`note-t:${n.id}`} plain label={title} onPress={press} /> : null}
        {reason ? <Button key={`note-r:${n.id}`} plain dimColor label={reason} onPress={press} /> : null}
      </Box>
      {open && n.title ? wrapHard(`"${n.title}"`, Math.max(8, cols - 2)).map((t, i) => <Line E={E} w={cols} k={`awt-${n.id}-${i}`} segs={[{ t: `  ${t}` }]} />) : null}
      {open && n.reason ? wrapHard(n.reason, Math.max(8, cols - 2)).map((t, i) => <Line E={E} w={cols} k={`awr-${n.id}-${i}`} segs={[{ t: `  ${t}`, dim: true }]} />) : null}
      {mine && mine.stage === 'reason' ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Input key={`reason:${n.id}`} label="reason: " placeholder={`why ${mine.action}? at most ${REASON_MAX} characters`} submitLabel="next" autoFocus onSubmit={v => act.reason(v)} />
          {focused ? null : wrapHard('press ctrl+x tab to type the reason (Esc gives the keys back)', Math.max(8, cols - 2)).map((t, i) => <Line E={E} w={cols} k={`awh-${n.id}-${i}`} segs={[{ t, dim: true }]} />)}
          <Button key={`cancel:${n.id}`} plain label="▸ cancel" onPress={act.cancel} />
        </Box>
      ) : null}
      {mine && mine.stage === 'confirm' ? (
        <Box flexDirection="column">
          {wrapHard(settleConfirm(mine.action, n.id, mine.reason, n.title), Math.max(8, cols - 2)).map((t, i) => <Line E={E} w={cols} k={`awq-${n.id}-${i}`} segs={[{ t: `  ${t}`, c: ATTN }]} />)}
          <Box>
            <Button key={`cancel:${n.id}`} plain label="  ▸ cancel" onPress={act.cancel} />
            <Button key={`commit:${n.id}`} plain label={`  ▸ ${mine.action} it`} onPress={() => act.commit(n.id)} />
          </Box>
        </Box>
      ) : null}
      {open && done ? <Line E={E} w={cols} k={`awd-${n.id}`} segs={[{ t: `  ${done.label}`, dim: true }]} /> : null}
      {open && done && done.unknown ? <Button key={`recheck:${n.id}`} plain label="  ▸ re-check (after belay memory held)" onPress={() => act.recheck(n.id)} /> : null}
      {open && !mine && !done && rows.map((r, i) => <Box key={`awb-${n.id}-${i}`}>{r.map(a => <Button key={`${a}-${n.id}`} plain label={`  ▸ ${a}`} onPress={() => act.settle(a, n.id)} />)}</Box>)}
    </Box>
  )
}

// The memory section. Its heading carries the summary (how many are held, how many await the operator); under it the review lines,
// the detail line, the awaiting notes with their buttons and the one review button. The first press of the review button turns the
// line into a confirm; the second press (inside CONFIRM_MS) dispatches; the timeout or any other press cancels. This Button is the ONLY
// caller of act.review, and act.review is the only way to the dispatch (index.tsx).
function Held({ E, snap, ui, now, act, cols, pend, focused, settled }: Ctx) {
  const { Button } = E
  const hd = snap.held
  const off = snap.memoryNotice
  if (!hd && !off) return null
  const inner = cols - INDENT
  const project = reviewProject(hd)
  const busy = hd !== null && project !== null && runningReview(hd, project) !== null // a review of that project holds its claim: no second dispatch
  const asking = !busy && !!ui.confirm && project !== null && ui.confirm.project === project && now - ui.confirm.at <= CONFIRM_MS
  const awaiting = hd?.awaiting ?? 0
  const notes = hd?.awaitingNotes ?? []
  const openId = ui.openNote ?? null // one at a time; a note that leaves the list is closed by the fetch that drops it
  const list = hd?.awaitingList
  // The "+N more" count is the list's own: its total less the rows shown, from the one read. A list kept from an earlier round says when it was read instead.
  const more = list && !list.carried ? Math.max(0, list.total - notes.length) : 0
  const carriedAt = list?.carried && notes.length ? list.at : null
  const summary: Seg[] = [
    ...(off ? [{ t: 'off', c: ATTN } as Seg, ...(hd ? [{ t: ' · ', dim: true } as Seg] : [])] : []),
    ...(hd ? [{ t: hd.count > 0 ? `${hd.count} held` : 'none held', dim: true } as Seg] : []),
    ...(awaiting > 0 ? [{ t: ' · ', dim: true } as Seg, { t: `${awaiting} await${awaiting === 1 ? 's' : ''} you`, c: ATTN } as Seg] : []),
  ]
  return (
    <Section E={E} k="sm" title="MEMORY" cols={cols} summary={summary}>
      {off && <MemoryOff E={E} n={off} cols={inner} />}
      {hd && hd.reviews.flatMap((r, i) => {
        const bad = r.state === 'failed' // a review cut off (its claimant gone) is finished, so dim; only a failed one with a reason is red
        return wrapHard(reviewLine(r, now), Math.max(8, inner - 2)).map((t, j) => <Line E={E} w={inner} k={`hr${i}-${j}`} segs={[{ t: j === 0 ? '◇ ' : '  ', c: bad ? 'error' : undefined, dim: !bad }, { t, c: bad ? 'error' : undefined }]} />)
      })}
      {hd && hd.count > 0 && wrapHard(asking && project ? confirmLine(hd, project) : heldDetail(hd, now), Math.max(8, inner)).map((t, i) => <Line E={E} w={inner} k={`hl${i}`} segs={[{ t, c: asking ? ATTN : undefined, dim: !asking }]} />)}
      {notes.map(n => <SettleRow E={E} cols={inner} n={n} act={act} open={n.id === openId} pend={pend} focused={focused} done={settledActive(settled[n.id], snap, n.id) ? settleEntryView(settled[n.id]!, now) : null} />)}
      {carriedAt !== null && <Line E={E} w={inner} k="awc" segs={[{ t: `list from ${hhmm(carriedAt)}`, dim: true }]} />}
      {more > 0 && wrapHard(`+${more} more · belay memory held --awaiting`, inner).map((t, i) => <Line E={E} w={inner} k={`awm${i}`} segs={[{ t, dim: true }]} />)}
      {hd && project !== null && !busy && <Button key="review" plain label={asking ? '  ▸ press again to dispatch · any other press cancels' : `  ▸ review the held notes${Object.keys(hd.byProject).length > 1 ? ` (${project} first)` : ''}`} onPress={act.review} />}
    </Section>
  )
}

function Orchestrator({ E, snap, ui, act, cols }: Ctx) {
  const { Box, Text, Button } = E
  const inner = cols - INDENT
  const note = (t: string, k: string) => <Section E={E} k="so" title="ORCHESTRATOR" cols={cols}>{wrapHard(t, inner).map((l, i) => <Line E={E} w={inner} k={`${k}${i}`} segs={[{ t: l, dim: true }]} />)}</Section>
  if (snap.mode === 'interactive') return note('Interactive: its words are already in its own window.', 'oi')
  if (snap.mode !== 'headless') return note('run mode unknown', 'ou')
  const entries = snap.transcript ?? []
  if (!entries.length) return note(snap.transcript === null ? 'no transcript read yet' : 'no lines yet', 'oe')
  return (
    <Section E={E} k="so" title="ORCHESTRATOR" cols={cols}>
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
    </Section>
  )
}

function Legend({ E, cols }: Ctx) {
  const inner = cols - INDENT
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
    [{ t: '18.2k · 2%', dim: false }, { t: ' context: tokens, and the share of the window when known', dim: true }],
    [{ t: 'amber', c: 'warning' }, { t: ' look soon', dim: true }], [{ t: 'red', c: 'error' }, { t: ' failed', dim: true }],
    [{ t: 'purple', c: 'merged' }, { t: ' review holds', dim: true }],
  ]
  return (
    <Section E={E} k="sl" title="LEGEND" cols={cols} summary={[{ t: '? closes', dim: true }]}>
      {m.map(([col, g, t]) => <Line E={E} w={inner} k={`lg${g}${t}`} segs={[{ t: g, c: col }, { t: ` ${t}`, dim: true }]} />)}
      {c.map((s, i) => <Line E={E} w={inner} k={`lc${i}`} segs={s} />)}
      <Line E={E} w={inner} k="lz" segs={[{ t: '@hh:mm cost is as of the last turn end · → command to act', dim: true }]} />
    </Section>
  )
}

// The compact notice in the band, while no memory.project is set: a title and one short line with the fix (the full text is in the CLI).
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

// The same notice in the pane's memory section: dim, the title and the fix command, nothing more.
function MemoryOff({ E, n, cols }: { E: Els; n: BelayMemoryNotice; cols: number }) {
  return (
    <>
      {wrapHard(n.title, Math.max(8, cols - 2)).map((l, i) => <Line E={E} w={cols} k={`mot${i}`} segs={[{ t: i === 0 ? '▲ ' : '  ', c: ATTN }, { t: l, c: ATTN, bold: true }]} />)}
      {wrapHard(n.short, cols).map((l, i) => <Line E={E} w={cols} k={`mos${i}`} segs={[{ t: l, dim: true }]} />)}
    </>
  )
}

// ---- the pane ----------------------------------------------------------------------------------

export function Pane(c: Ctx) {
  const { E, snap, ui, now, act, cols } = c
  const { Box, Button } = E
  const t = snap.tasks
  const stale = staleLine(snap)
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
  const inner = { ...c, cols: cols - INDENT }
  const live = snap.agents.filter(isLive).length
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Line E={E} w={cols - 6} k="ph" segs={runLine(snap, now)} />
        <Box>
          <Button key="legend" label="?" plain dimColor onPress={act.legend} />
          <Button key="close" label=" ✕" plain dimColor onPress={act.close} />
        </Box>
      </Box>
      <Line E={E} w={cols} k="pr" segs={[{ t: '─'.repeat(cols), dim: true }]} />
      {stale && wrapHard(stale, cols).map((t, i) => <Line E={E} w={cols} k={`pstale${i}`} segs={[{ t, dim: true }]} />)}
      {tasksLine.length > 0 && <Line E={E} w={cols} k="pt" segs={tasksLine} />}
      <Line E={E} w={cols} k="pc" segs={costLine} />
      {ui.legend && <Legend {...c} />}
      <Section E={E} k="sa" title="AGENTS" cols={cols} summary={snap.agents.length ? [{ t: `${live} live`, dim: true }] : []}>
        {snap.agents.length ? <Table {...inner} /> : <Line E={E} w={cols - INDENT} k="pn" segs={[{ t: 'no agents read', dim: true }]} />}
      </Section>
      {(snap.held || snap.memoryNotice) && <Held {...c} />}
      <Notices {...c} />
      <Orchestrator {...c} />
      <Box flexDirection="column" marginTop={1}>
        {snap.errors.map((e, i) => <Line E={E} w={cols} k={`pe${i}`} segs={[{ t: e, dim: true }]} />)}
        {wrapHard(snap.held && snap.held.count > 0 ? 'read-only except the review and settle buttons · /orch toggles' : 'read-only · /orch toggles', cols).map((t, i) => <Line E={E} w={cols} k={`pf${i}`} segs={[{ t, dim: true }]} />)}
      </Box>
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
  const stale = staleLine(snap)
  if (stale) lines.push([{ t: stale, dim: true }])
  for (const e of snap.errors) lines.push([{ t: e, dim: true }])
  return <Box flexDirection="column">{lines.map((s, i) => <Line E={E} w={cols} segs={s} k={`f${i}`} />)}</Box>
}

