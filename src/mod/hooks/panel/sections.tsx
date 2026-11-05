// The pane's blocks other than the agents table, the notes and the memory row: the header card (run, state, elapsed, task progress, cost), the
// notices, the legend and the footer. Drawing only: a press calls one of the `Act` handlers the caller passes.

import type { BelayNotice, BelayPanelSnap } from '../../types/index'
import { bar, money, runBrief, staleLine, TONE, unseenNotices, type Seg } from './model'
import { cells, cmdLines, wordWrap, wrapHard } from './wrap'
import { clip, INDENT, Line, Section, type Ctx, type Els } from './base'
import { ACCENT, ATTN, BRAND, cardInner, CARD_MIN_COLS, ERR, MUTED, OK, WARN } from './theme'

export const hhmm = (ts: number | null): string => (ts === null ? '--:--' : new Date(ts).toTimeString().slice(0, 5))
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

// ---- the header card -----------------------------------------------------------------------------

// Task progress: a bar and done/total, or how many tasks agents hold when belay gave no total.
export function taskSegs(snap: BelayPanelSnap, cols: number): Seg[] {
  const t = snap.tasks
  if (!t) return []
  if (t.total === null) return [{ t: 'tasks ', dim: true }, { t: `${t.held} held by agents` }]
  const b = bar(t.total ? (t.done ?? 0) / t.total : 0, cols >= 50 ? 10 : 6)
  return [{ t: 'tasks ', dim: true }, { t: b.on, c: OK }, { t: b.off, dim: true }, { t: ` ${t.done ?? 0}/${t.total}` }]
}

// The run's cost: the figure, then dim parts that drop whole from the end (when it is as of, how many agents have none recorded).
export function costSegs(snap: BelayPanelSnap): Seg[] {
  const f = snap.footer
  if (!f) return [{ t: 'cost not read', dim: true }]
  const unrec = f.notRecorded ? plural(f.notRecorded, 'agent') + ' unrecorded' : ''
  if (f.totalCostUsd === null && !f.asOfMs) return [{ t: `no cost recorded yet${unrec ? ` · ${unrec}` : ''}`, dim: true }]
  return [
    { t: money(f.totalCostUsd) },
    ...(f.asOfMs ? [{ t: ` @${hhmm(f.asOfMs)}`, dim: true, brk: true } as Seg] : []),
    ...(f.notRecorded ? [{ t: ` · ${f.notRecorded} unrecorded`, dim: true, brk: true } as Seg] : []),
  ]
}

export const widthOf = (xs: Seg[]): number => xs.reduce((n, s) => n + cells(s.t), 0)

// The fix-round levers the run row records: the notice threshold and the hard cap, on one line when both fit, else one each. Never a used count
// (the rounds used are not recorded).
function fixLines(snap: BelayPanelSnap, w: number): Seg[][] {
  const rounds: Seg[] = snap.maxFixRounds !== null ? [{ t: 'fix rounds ', dim: true }, { t: `notice at ${snap.maxFixRounds}` }] : []
  const cap: Seg[] = snap.fixHardCap !== null ? [{ t: 'hard cap ', dim: true }, { t: `${snap.fixHardCap}${snap.fixHardCapSource ? ` (${snap.fixHardCapSource})` : ''}` }] : []
  if (!rounds.length || !cap.length) return [rounds, cap].filter(l => l.length)
  return widthOf(rounds) + 3 + widthOf(cap) <= w ? [[...rounds, { t: ' · ', dim: true }, ...cap]] : [rounds, cap]
}

// The card at the top: the run line with the ? and ✕ buttons, then task progress and cost on one line when both fit (else one line each),
// then the fix-round levers and a stale line, all inside a round dim border when the pane has the room for one.
export function Header(c: Ctx) {
  const { E, snap, now, act, cols } = c
  const { Box, Button } = E
  const w = cardInner(cols)
  const tasks = taskSegs(snap, w)
  const cost = costSegs(snap)
  const gap = '   '
  const together = tasks.length > 0 && widthOf(tasks) + gap.length + widthOf(cost) <= w
  const fix = fixLines(snap, w)
  const stale = staleLine(snap)
  const body = (
    <Box key="cardbody" flexDirection="column">
      <Box key="hd" justifyContent="space-between">
        <Line E={E} w={w - 4} k="ph" segs={runBrief(snap, now)} />
        <Box>
          <Button key="legend" label="?" plain dimColor onPress={act.legend} />
          <Button key="close" label=" ✕" plain dimColor onPress={act.close} />
        </Box>
      </Box>
      {together
        ? <Line E={E} w={w} k="pt" segs={[...tasks, { t: gap }, ...cost]} />
        : <Box key="ptc" flexDirection="column">{tasks.length > 0 && <Line E={E} w={w} k="pt" segs={tasks} />}<Line E={E} w={w} k="pc" segs={cost} /></Box>}
      {fix.map((l, i) => <Line E={E} w={w} k={`pf${i}`} segs={l} />)}
      {stale && wrapHard(stale, w).map((t, i) => <Line E={E} w={w} k={`pstale${i}`} segs={[{ t, dim: true }]} />)}
    </Box>
  )
  return cols >= CARD_MIN_COLS
    ? <Box key="card" flexDirection="column" borderStyle="round" borderColor={MUTED} borderDimColor paddingX={1}>{body}</Box>
    : <Box key="card" flexDirection="column">{body}</Box>
}

// The fatal state (belay-run.json or the CLI cannot be used): the brand and the reason, nothing else.
export function Fatal({ E, text, cols }: { E: Els; text: string; cols: number }) {
  return <Line E={E} w={cols} k="fatal" segs={[{ t: 'belay ', c: BRAND, bold: true }, { t: text, c: ERR }]} />
}

// ---- notices ----------------------------------------------------------------------------------------

// The line under a notice. An id wider than the room beside the time moves out to the notice's own indent, whole.
function IdLines({ E, ids, cols }: { E: Els; ids: string; cols: number }) {
  const { Box, Text } = E
  const pl = cells(ids) > cols - 8 ? 2 : 8
  return <Box paddingLeft={pl} flexShrink={0} flexDirection="column">{wordWrap(ids, cols - pl).map((t, i) => <Text key={`i${i}`} dimColor wrap="truncate-end">{clip(t, cols - pl)}</Text>)}</Box>
}

// The command row sits under the text (indent 8) when every command fits there whole; a command with a long id keeps the wider indent 2 so it stays whole.
const cpl = (cmd: string, inner: number): number => (cmd.split(/\s+·\s+/).every(c => cells(c) <= inner - 8 - 2) ? 8 : 2)

// The heading reads "N (M new)" and folds the list to itself on a press of its ▾. Folded, the worst tone among the new ones (or all) leads it.
// Rows are drawn at the section's inner width. One line each: the id goes beside the text when both fit, and is left out when the
// text already names it; only an id that does not fit beside the text takes the line under it.
export function Notices({ E, snap, ui, act, cols }: Ctx) {
  const { Box, Text, Button } = E
  const ordered = [...snap.notices].sort((a: BelayNotice, b: BelayNotice) => (b.ts ?? 0) - (a.ts ?? 0))
  const fresh = unseenNotices(ordered, ui)
  const inner = cols - INDENT
  if (!ordered.length) return <Section E={E} k="sn" title="NOTICES" cols={cols} summary={[{ t: 'none', dim: true }]} />
  const open = !ui.noticesFold
  const worst = [...(fresh.length ? fresh : ordered)].sort((a, b) => TONE[a.tone].rank - TONE[b.tone].rank)[0]!
  const summary: Seg[] = [
    ...(open ? [] : [{ t: `${TONE[worst.tone].glyph} `, c: TONE[worst.tone].color } as Seg]),
    { t: String(ordered.length) },
    ...(fresh.length ? [{ t: ` (${fresh.length} new)`, c: WARN } as Seg] : []),
  ]
  return (
    <Section E={E} k="sn" title="NOTICES" cols={cols} summary={summary} fold={{ open, press: act.notices }}>
      {open && ordered.slice(0, 8).map(n => {
        const t = TONE[n.tone]
        const seen = ui.seen.includes(n.key)
        const room = inner - 8
        const fits = cells(n.text) <= room
        const lines = fits ? [n.text] : wrapHard(n.text, Math.max(8, room)) // the text once: its first line beside the time, the rest under it
        const named = !n.ids || n.text.includes(n.ids)
        const inline = fits && !named && cells(n.text) + 2 + cells(n.ids ?? '') <= room
        const cp = n.cmd ? cpl(n.cmd, inner) : 0
        return (
          <Box key={`n-${n.key}`} flexDirection="column">
            <Box>
              <Box width={2} flexShrink={0}><Text color={t.color}>{t.glyph}</Text></Box>
              <Box width={6} flexShrink={0}><Text dimColor>{hhmm(n.ts)}</Text></Box>
              <Button key={`notice:${n.key}`} label={clip(lines[0] ?? '', room)} plain dimColor={seen} onPress={() => act.seen(n.key)} />
              {inline ? <Text dimColor>{`  ${n.ids}`}</Text> : null}
            </Box>
            {lines.slice(1).map((l, i) => <Line E={E} w={inner} k={`ne-${n.key}-${i}`} segs={[{ t: `${' '.repeat(8)}${l}`, dim: seen }]} />)}
            {n.ids && !inline && !(fits && named) ? <IdLines E={E} ids={n.ids} cols={inner} /> : null}
            {n.cmd ? <Box paddingLeft={cp} flexShrink={0} flexDirection="column">{cmdLines(n.cmd, inner - cp).map((t, i) => <Text key={`c${i}`} dimColor wrap="truncate-end">{clip(t, inner - cp)}</Text>)}</Box> : null}
          </Box>
        )
      })}
      {open && ordered.length > 8 && <Line E={E} w={inner} k="nm" segs={[{ t: `and ${ordered.length - 8} older`, dim: true }]} />}
    </Section>
  )
}

// ---- legend and footer ------------------------------------------------------------------------------

export function Legend({ E, cols }: Ctx) {
  const inner = cols - INDENT
  const m: [string, string, string][] = [
    [OK, '●', 'running'], [OK, '◐', 'waiting inside a call'], [MUTED, '○', 'idle, no turn running'], [WARN, '◌', 'stalled, no event for 5 min'],
    [ATTN, '▲', 'needs your approval'],
    // Marks for these three confirmed by the operator, 2026-10-08.
    [MUTED, '●', 'starting or stopping'], [MUTED, '?', 'state unknown'], [MUTED, '‖', 'parked, session kept'], [ERR, '✕', 'dead'], [MUTED, '✓', 'finished'],
  ]
  const b = bar(0.6, 4)
  const c: Seg[][] = [
    [{ t: b.on, c: OK }, { t: b.off, dim: true }, { t: ' cache time left; tasks done', dim: true }],
    [{ t: b.on, c: ACCENT }, { t: b.off, dim: true }, { t: ' context used: amber from 70%, red from 90%', dim: true }],
    [{ t: '18.2k · 2%', dim: false }, { t: ' context: tokens, and the share of the window when known', dim: true }],
    [{ t: '■', c: OK }, { t: ' ok, review holds  ', dim: true }, { t: '■', c: WARN, brk: true }, { t: ' look soon, paused', dim: true }],
    [{ t: '■', c: ERR }, { t: ' failed  ', dim: true }, { t: '■', c: ATTN, brk: true }, { t: ' waits on you', dim: true }],
  ]
  return (
    <Section E={E} k="sl" title="LEGEND" cols={cols} summary={[{ t: '? closes', dim: true }]}>
      {m.map(([col, g, t]) => <Line E={E} w={inner} k={`lg${g}${t}`} segs={[{ t: g, c: col }, { t: ` ${t}`, dim: true }]} />)}
      {c.map((s, i) => <Line E={E} w={inner} k={`lc${i}`} segs={s} />)}
      <Line E={E} w={inner} k="lz" segs={[{ t: '@hh:mm cost is as of the last turn end · → command to act', dim: true }]} />
    </Section>
  )
}

// The errors of the last round and the one dim line that says what the panel may do.
export function Footer({ E, snap, cols }: Ctx) {
  const { Box } = E
  const what = snap.held && snap.held.count > 0 ? 'read-only except the review and settle buttons · /orch toggles' : 'read-only · /orch toggles'
  return (
    <Box flexDirection="column" marginTop={1}>
      {snap.errors.map((e, i) => <Line E={E} w={cols} k={`pe${i}`} segs={[{ t: e, dim: true }]} />)}
      {wrapHard(what, cols).map((t, i) => <Line E={E} w={cols} k={`pf${i}`} segs={[{ t, dim: true }]} />)}
    </Box>
  )
}
