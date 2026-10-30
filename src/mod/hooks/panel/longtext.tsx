// Long free text in the pane: wrapped to the room over as many lines as it needs, never cut off at the side (a notice's explanation, the Memory menu's
// warnings and answers). A headline stays one clipped line where it is drawn; this draws what the headline cannot hold. Drawing only.

import type { Seg } from './model'
import type { Els } from './base'
import { Line } from './base'
import { cells, wrapHard } from './wrap'

/** The text wrapped to `room` cells, each line drawn through Line (which clips a line that still cannot fit), indented `indent` cells. */
export function WrapText({ E, text, k, w, indent = 0, c, dim, bold }: { E: Els; text: string; k: string; w: number; indent?: number; c?: string; dim?: boolean; bold?: boolean }) {
  const pad = ' '.repeat(indent)
  return <>{wrapHard(text, Math.max(8, w - indent)).map((l, i) => <Line E={E} w={w} k={`${k}${i}`} segs={[{ t: `${pad}${l}`, ...(c ? { c } : {}), ...(dim ? { dim: true } : {}), ...(bold ? { bold: true } : {}) }]} />)}</>
}

/** A one-segment row of free text: on one line when it fits, wrapped when it does not. A row of several segments stays a Line. */
export function FreeRow({ E, segs, k, w }: { E: Els; segs: Seg[]; k: string; w: number }) {
  const s = segs[0]
  if (segs.length !== 1 || !s || cells(s.t) <= w) return <Line E={E} w={w} k={k} segs={segs} />
  return <WrapText E={E} text={s.t} k={k} w={w} c={s.c} dim={s.dim} bold={s.bold} />
}
