// Drawing primitives shared by the panel's views: the element and handler types, a line of segments, and the cell helpers.

import type { Elements } from 'claude-code'
import type { BelayPanelSnap, BelayPanelUi } from '../../types/index'
import { fitSegs, type Seg } from './model'
import { clipCells } from './wrap'
import type { SettleAction } from './held'

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
  /** A held note that waits on the operator: ask for a reason, confirm, then settle it (index.tsx). */
  settle: (action: SettleAction, id: string) => void
}
export type Ctx = { E: Els; snap: BelayPanelSnap; ui: BelayPanelUi; now: number; cols: number; act: Act }

export const tp = (s: Seg): Record<string, unknown> => ({
  ...(s.c ? { color: s.c } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}), wrap: 'truncate-end',
})

// A line of segments. With a width, whole parts drop from the end and nothing inside is shrunk, so the
// sum of the kept texts never exceeds the room and the flex row has nothing to squeeze.
export function Line({ E, segs, k, w }: { E: Els; segs: Seg[]; k: string; w?: number }) {
  const { Box, Text } = E
  const out = w === undefined ? segs : fitSegs(segs, Math.max(1, w))
  return <Box key={k} flexShrink={0}>{out.map(s => <Text {...tp(s)}>{s.t}</Text>)}</Box>
}

// Cut a string to n cells (display width, not codepoints) with an ellipsis.
export const clip = clipCells

export const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))

// An agent name that does not fit is cut with an ellipsis, so the cut shows.
export const padName = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.ceil((n - 1) / 2)) + '…' + s.slice(s.length - Math.floor((n - 1) / 2)) : pad(s, n)) // a cut keeps the end, which tells archreview-… workers apart

// 'claude-sonnet-5-5' -> 'sonnet'; anything else (codex) is shown as belay gave it.
export function shortModel(m: string | null): string {
  if (!m) return '—'
  const f = /(?:claude-)?(opus|sonnet|haiku|fable)/i.exec(m)
  return f ? f[1]!.toLowerCase() : m
}

// ---- sections ----------------------------------------------------------------------------------

// Every block of the pane is a Section: one bold heading in caps, an optional dim summary beside it, one blank line above,
// and its rows indented by one space. A caller draws the rows at `cols - 1`.
export const INDENT = 1
export function Section({ E, k, title, summary, cols, children }: { E: Els; k: string; title: string; summary?: Seg[]; cols: number; children?: unknown }) {
  const { Box } = E
  const head: Seg[] = [{ t: title, bold: true }, ...(summary && summary.length ? [{ t: '  ', brk: true } as Seg, ...summary] : [])]
  return (
    <Box key={k} flexDirection="column" marginTop={1}>
      <Line E={E} w={cols} k={`${k}-h`} segs={head} />
      {children ? <Box paddingLeft={INDENT} flexDirection="column">{children as never}</Box> : null}
    </Box>
  )
}
