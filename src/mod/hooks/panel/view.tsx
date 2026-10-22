// The panel's drawing: the band, the pane and a plain fallback. Colours are theme keys only. Nothing
// here fetches, writes or submits: a press only calls one of the `Act` handlers the caller passes.

import type { Elements } from 'claude-code'
import type { BelayAgent, BelayEntry, BelayNotice, BelayPanelSnap, BelayPanelUi } from '../../types/index'
import {
  bandLines, cacheSegs, CONFIRM_MS, confirmLine, heldLine, reviewLine, reviewProject, runningReview, ctxSegs, dur, fitSegs, isLive, markSeg, markWidth, money, runLine, STATE_NAME, TONE, unseenNotices, bar,
  memoryTitleSegs, memoryFallbackSegs, interactiveOrch, interactiveMark, type Seg,
} from './model'
import { cells, clipCells, cmdLines, wordWrap, wrapParts } from './wrap'

export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
export type Act = {
  select: (id: string) => void
  legend: () => void
  fold: () => void
  group: (key: string) => void
  seen: (key: string) => void
  close: () => void
  toggle: () => void
  /** The memory line's one write action: the first press asks, the second dispatches (index.tsx). */
  review: () => void
}
type Ctx = { E: Els; snap: BelayPanelSnap; ui: BelayPanelUi; now: number; cols: number; act: Act }

const tp = (s: Seg): Record<string, unknown> => ({
  ...(s.c ? { color: s.c } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}), wrap: 'truncate-end',
})

// A line of segments. With a width, whole parts drop from the end and nothing inside is shrunk, so the
// sum of the kept texts never exceeds the room and the flex row has nothing to squeeze.
function Line({ E, segs, k, w }: { E: Els; segs: Seg[]; k: string; w?: number }) {
  const { Box, Text } = E
  const out = w === undefined ? segs : fitSegs(segs, Math.max(1, w))
  return <Box key={k} flexShrink={0}>{out.map(s => <Text {...tp(s)}>{s.t}</Text>)}</Box>
}

// Cut a string to n cells (display width, not codepoints) with an ellipsis.
const clip = clipCells

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))

// An agent name that does not fit is cut with an ellipsis, so the cut shows.
const padName = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.ceil((n - 1) / 2)) + '…' + s.slice(s.length - Math.floor((n - 1) / 2)) : pad(s, n)) // a cut keeps the end, which tells archreview-… workers apart

// 'claude-sonnet-5-5' -> 'sonnet'; anything else (codex) is shown as belay gave it.
export function shortModel(m: string | null): string {
  if (!m) return '—'
  const f = /(?:claude-)?(opus|sonnet|haiku|fable)/i.exec(m)
  return f ? f[1]!.toLowerCase() : m
}

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

type Cols = { mark: number; agent: number; id: number; model: boolean; task: number; ctx: number; cache: number; cost: number }

// Every cell is followed by one column of space. When the pane is narrow whole columns drop, the
// least needed first: task, cache, context, the model name, then the id is cut. Nothing is squeezed.
function columns({ snap, cols }: Ctx): Cols {
  const s = snap.settings
  const longest = snap.agents.reduce((m, a) => Math.max(m, a.id.length), 0)
  const c: Cols = {
    mark: markWidth(s.marks), agent: 0, id: Math.max(6, Math.min(16, longest)), model: true, task: 0,
    ctx: s.context === 'figure' ? 4 : s.context === 'bar' ? 6 : 11, cache: s.cache === 'both' ? 11 : 5, cost: 7,
  }
  const kind = s.task === 'kind'
  // `kind` is the cheapest column to keep: its label (`work`, `rev`, `research`) is reserved before the cache and the
  // context are dropped, and grows to take the review verdict and the ▲ id when there is room. Only the label is kept last.
  const labelW = kind ? Math.max(4, ...snap.agents.map(a => cells(taskSegs(a, snap, 99)[0]?.t ?? ''))) : 0
  const fullW = kind ? Math.max(labelW, ...snap.agents.map(a => cells(taskSegs(a, snap, 99).map(x => x.t).join('')))) : 0
  if (kind) c.task = fullW
  const total = (): number => (c.mark + 1) + (c.id + (c.model ? 8 : 0) + 1) + (c.ctx ? c.ctx + 1 : 0) + (c.cache ? c.cache + 1 : 0) + (c.task ? c.task + 1 : 0) + (c.cost + 1)
  const cacheW = c.cache
  if (total() > cols) c.cache = 0
  if (kind && total() > cols) { // the verdict and the ▲ drop before the context does, and give the cache back if it then fits
    c.task = labelW
    c.cache = cacheW
    if (total() > cols) c.cache = 0
  }
  if (total() > cols) c.ctx = 0
  if (total() > cols) c.model = false
  if (total() > cols) c.task = 0
  if (total() > cols) c.id = Math.max(3, c.id - (total() - cols))
  c.agent = c.id + (c.model ? 8 : 0)
  const t = cols - total() - 1
  if (kind) { if (c.task) c.task = Math.min(fullW, c.task + Math.max(0, t + 1)) }
  else c.task = s.task === 'off' || t < 8 ? 0 : t
  return c
}

// The kind of work an agent is on, from its role: a reviewer is `rev`, a researcher `research`, a worker with no
// role `work`. Any other role names itself.
function kindOf(a: BelayAgent): string {
  const r = (a.role ?? '').toLowerCase()
  if (!r || r === 'coder' || r === 'worker') return 'work'
  if (r.startsWith('review')) return 'rev'
  if (r.startsWith('research')) return 'research'
  return r
}

// One readable label, never two cut fragments: the id and title when both fit, else the title alone (the id is in the
// detail), else the id. The verdict and the permission mark are parts that drop whole from the end.
function taskSegs(a: BelayAgent, snap: BelayPanelSnap, room: number): Seg[] {
  if (interactiveOrch(a, snap)) return [{ t: 'interactive', dim: true }]
  if (a.role === 'orchestrator') return [{ t: snap.settings.task === 'kind' ? 'orch' : 'orchestrator', dim: true }]
  const perm = snap.notices.find(n => n.tone === 'permission' && n.agentId === a.id)
  const v = a.task && snap.notices.find(n => n.taskId === a.task!.id && (n.tone === 'holds' || n.tone === 'refuted'))
  const tail: Seg[] = []
  if (v) tail.push({ t: ' → ', brk: true }, { t: v.tone === 'holds' ? 'holds' : 'refuted', c: v.tone === 'holds' ? 'merged' : 'error' })
  if (perm) tail.push({ t: ` ▲ ${perm.ids}`, c: 'permission', brk: true })
  if (snap.settings.task === 'kind') {
    // The kind label is kept last: the permission mark drops first, then the verdict. A request id is about 30 cells, so
    // the mark stands alone here; the id and the commands are in the permission notice.
    const kt: Seg[] = tail.map(x => (x.c === 'permission' ? { ...x, t: ' ▲' } : x))
    return fitSegs([a.task ? { t: clip(kindOf(a), room) } : { t: '—', dim: true }, ...kt], room)
  }
  const kept = fitSegs([{ t: '' }, ...tail], Math.max(1, room - 6)).slice(1)
  const label = Math.max(1, room - cells(kept.map(x => x.t).join('')))
  if (!a.task) return fitSegs([{ t: 'no task', dim: true }, ...kept], room)
  const id = a.task.id.slice(0, 8)
  const title = (a.task.title ?? '').trim()
  const both = title ? `${id} ${title}` : id
  if (cells(both) <= label) return [...(title ? [{ t: id, dim: true }, { t: ` ${title}` }] : [{ t: id, dim: true }]), ...kept]
  return [title ? { t: clip(title, label) } : { t: clip(id, label), dim: true }, ...kept]
}

const LABEL = 8

// A detail row is a label and parts. The parts join with `sep` and wrap under the label instead of being cut.
type DRow = { k: string; parts: string[]; sep: string; note?: Seg }

function Detail({ E, a, snap, now, cols }: { E: Els; a: BelayAgent; snap: BelayPanelSnap; now: number; cols: number }) {
  const { Box } = E
  const rows: DRow[] = []
  rows.push({ k: 'status', sep: ' · ', parts: [interactiveOrch(a, snap) ? 'interactive — its words are in its own window' : `${STATE_NAME[a.state]} — established by ${a.stateBy ?? 'not recorded'}`, a.pid !== null ? `pid ${a.pid}` : ''] })
  const launch = [a.model, a.effort ? `effort ${a.effort}` : null, a.launchMode ? `mode ${a.launchMode}` : null, a.version ? `Claude Code ${a.version}` : null]
  rows.push({ k: 'launch', sep: ' · ', parts: launch.filter(Boolean).length ? launch.filter(Boolean) as string[] : ['not recorded'] })
  if (a.task) {
    const src = a.task.title && a.task.titleSource ? (/spec/.test(a.task.titleSource) ? ' (from spec)' : ` (${a.task.titleSource})`) : ''
    rows.push({ k: 'task', sep: ' ', parts: [`${a.task.id} ${a.task.title ?? ''}`.trim()], ...(src ? { note: { t: src, dim: true } } : {}) })
  }
  if (a.ctxTokens !== null) rows.push({ k: 'context', sep: ' ', parts: [`${a.ctxTokens.toLocaleString('en-US')} tokens${a.ctxWindow ? ` of ${a.ctxWindow.toLocaleString('en-US')}` : ' (window unknown)'}`] })
  if (a.cache) {
    const age = a.cache.ageMs !== null ? a.cache.ageMs + Math.max(0, now - snap.fetchedAt) : null
    rows.push({ k: 'cache', sep: ' · ', parts: [`TTL ${a.cache.ttlS !== null ? dur(a.cache.ttlS * 1000) : 'unknown'}${a.cache.ttlBy ? `, read from ${a.cache.ttlBy}` : ''}`, age !== null ? `age ${dur(age, true)}` : ''] })
  }
  rows.push({ k: 'cost', sep: ' ', parts: [a.costUsd === null ? 'not yet recorded' : `${money(a.costUsd)}${a.costSource ? ` (${a.costSource})` : ''}`] })
  rows.push({ k: 'logs', sep: ' ', parts: [`belay logs ${a.id}`] })
  const room = Math.max(8, cols - 2 - LABEL)
  const flush = cols - 2 // an id wider than the value room goes on its own line with the label's indent removed
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {rows.flatMap(r => {
        const note = r.note ? cells(r.note.t) : 0
        const lines = wrapParts(r.parts, r.sep, room).filter(t => t !== '')
        // The note is counted: it shares the last line when it fits there, else it takes a line of its own.
        const noteOwn = !!r.note && (lines.length === 0 || cells(lines[lines.length - 1]!) + note > (cells(lines[lines.length - 1]!) > room ? flush : room))
        const out: { t: string; flush: boolean; note?: Seg }[] = lines.map((t, i) => ({ t, flush: cells(t) > room && cells(t) <= flush, ...(i === lines.length - 1 && r.note && !noteOwn ? { note: r.note } : {}) }))
        if (!out.length) out.push({ t: '', flush: false })
        if (out[0]!.flush) out.unshift({ t: '', flush: false }) // the label alone, its flush id on the next line
        if (noteOwn) out.push({ t: '', flush: false, note: { ...r.note!, t: r.note!.t.trimStart() } })
        return out.map((l, i) => {
          const first = i === 0
          const segs: Seg[] = l.flush ? [{ t: l.t }] : [{ t: pad(first ? r.k : '', LABEL), dim: true }, { t: l.t }]
          if (l.note) segs.push(l.note)
          return <Line E={E} k={`d-${a.id}-${r.k}-${i}`} segs={segs} w={cols - 2} />
        })
      })}
    </Box>
  )
}

function AgentRow(c: Ctx & { a: BelayAgent; c: Cols }) {
  const { E, a, snap, ui, now, act } = c
  const { Box, Text, Button } = E
  const w = c.c
  const cell = (key: string, width: number, segs: Seg[]) => (
    <Box key={key} width={width} flexShrink={0} marginRight={1}>{segs.map(s => <Text {...tp(s)}>{s.t}</Text>)}</Box>
  )
  const io = interactiveOrch(a, snap)
  const mk = io ? interactiveMark(snap.settings.marks) : markSeg(a.state, snap.settings.marks)
  return (
    <Box key={`row-${a.id}`} flexDirection="column">
      <Box>
        {cell('m', w.mark, [mk])}
        <Box key="a" width={w.agent} flexShrink={0} marginRight={1}>
          <Button key={`agent:${a.id}`} label={padName(a.id, w.id)} plain onPress={() => act.select(a.id)} />
          {w.model ? <Text dimColor> {pad(shortModel(a.model), 7)}</Text> : null}
        </Box>
        {w.task > 0 && cell('t', w.task, taskSegs(a, snap, w.task))}
        {w.ctx > 0 && cell('x', w.ctx, ctxSegs(a, snap.settings))}
        {w.cache > 0 && cell('k', w.cache, cacheSegs(a, snap.settings, snap.fetchedAt, now))}
        {cell('$', w.cost, [{ t: a.costUsd === null && io ? 'n/a' : money(a.costUsd), dim: a.costUsd === null }])}
      </Box>
      {ui.selected === a.id && <Detail E={E} a={a} snap={snap} now={now} cols={c.cols} />}
    </Box>
  )
}

function Table(c: Ctx) {
  const { E, snap, ui, act, cols } = c
  const { Box, Button } = E
  const w = columns(c)
  const live = snap.agents.filter(isLive)
  const fin = snap.agents.filter(a => !isLive(a))
  return (
    <Box flexDirection="column">
      <Box key="th">
        <Box width={w.mark} marginRight={1}>{null}</Box>
        <Line E={E} w={cols - w.mark - 1} k="th1" segs={[{ t: pad('agent', w.agent + 1), dim: true }, ...(w.task > 0 ? [{ t: pad('task', w.task + 1), dim: true }] : []),
          ...(w.ctx > 0 ? [{ t: pad('ctx', w.ctx + 1), dim: true }] : []), ...(w.cache > 0 ? [{ t: pad('cache', w.cache + 1), dim: true }] : []), { t: 'cost', dim: true }]} />
      </Box>
      {live.map(a => <AgentRow {...c} a={a} c={w} />)}
      {fin.length > 0 && (
        <Button key="fold" plain dimColor label={`${ui.foldOpen ? '▾' : '▸'} ${fin.length} finished`} onPress={act.fold} />
      )}
      {ui.foldOpen && fin.map(a => <AgentRow {...c} a={a} c={w} />)}
    </Box>
  )
}

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
      {hd.count > 0 && <Line E={E} w={cols} k="hl" segs={[{ t: '◇ ', c: 'warning' }, { t: asking && project ? confirmLine(hd, project) : heldLine(hd, now), c: asking ? 'warning' : undefined }]} />}
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

