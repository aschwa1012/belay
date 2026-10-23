// The agent table: its columns, the task label, an opened agent's detail and the rows. Drawing only.

import type { BelayAgent, BelayPanelSnap } from '../../types/index'
import { cacheSegs, ctxSegs, dur, fitSegs, interactiveMark, interactiveOrch, isLive, markSeg, markWidth, money, STATE_NAME, type Seg } from './model'
import { cells, clipCells, wrapParts } from './wrap'
import { clip, Line, pad, padName, shortModel, tp, type Act, type Ctx, type Els } from './base'

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

function Detail({ E, a, snap, now, cols, last }: { E: Els; a: BelayAgent; snap: BelayPanelSnap; now: number; cols: number; last: boolean }) {
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
    <Box flexDirection="column" paddingLeft={2} marginBottom={last ? 0 : 1}>
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

function AgentRow(c: Ctx & { a: BelayAgent; c: Cols; last: boolean }) {
  const { E, a, snap, ui, now, act } = c
  const { Box, Text, Button } = E
  const w = c.c
  const cell = (key: string, width: number, segs: Seg[], end = false) => (
    <Box key={key} width={width} flexShrink={0} marginRight={1} {...(end ? { justifyContent: 'flex-end' } : {})}>{segs.map(s => <Text {...tp(s)}>{s.t}</Text>)}</Box>
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
        {cell('$', w.cost, [{ t: a.costUsd === null && io ? 'n/a' : money(a.costUsd), dim: a.costUsd === null }], true)}
      </Box>
      {ui.selected === a.id && <Detail E={E} a={a} snap={snap} now={now} cols={c.cols} last={c.last} />}
    </Box>
  )
}

export function Table(c: Ctx) {
  const { E, snap, ui, act, cols } = c
  const { Box, Button } = E
  const w = columns(c)
  const live = snap.agents.filter(isLive)
  const fin = snap.agents.filter(a => !isLive(a))
  // The last row on show has no blank line under its opened detail: the next section brings its own.
  const lastRow = fin.length > 0 && !ui.foldOpen ? null : [...live, ...(ui.foldOpen ? fin : [])].at(-1)
  return (
    <Box flexDirection="column">
      <Box key="th">
        <Box width={w.mark} marginRight={1}>{null}</Box>
        <Line E={E} w={cols - w.mark - 1} k="th1" segs={[{ t: pad('agent', w.agent + 1), dim: true }, ...(w.task > 0 ? [{ t: pad('task', w.task + 1), dim: true }] : []),
          ...(w.ctx > 0 ? [{ t: pad('ctx', w.ctx + 1), dim: true }] : []), ...(w.cache > 0 ? [{ t: pad('cache', w.cache + 1), dim: true }] : []), { t: ' '.repeat(Math.max(0, w.cost - 4)) + 'cost', dim: true }]} />
      </Box>
      {live.map(a => <AgentRow {...c} a={a} c={w} last={a === lastRow} />)}
      {fin.length > 0 && (
        <Button key="fold" plain dimColor label={`${ui.foldOpen ? '▾' : '▸'} ${fin.length} finished`} onPress={act.fold} />
      )}
      {ui.foldOpen && fin.map(a => <AgentRow {...c} a={a} c={w} last={a === lastRow} />)}
    </Box>
  )
}
