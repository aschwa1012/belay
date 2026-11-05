// The panel's colours by role, all theme keys, so a light and a dark theme both read. Colour goes on state glyphs, severity and the one number
// that matters; labels stay default, secondary text dim, headings bold. Pure: no `$`, no drawing.

// Section headings: bold in the default colour. `suggestion` is the same colour as `permission` in both of Claude Code's themes, so a heading in
// it reads as an approval waiting; `claude` (the brand orange) is the drawn alternative in the previews; plain bold keeps every colour for state.
export const HEADING: string | null = null
export const OK = 'success' // running, holds, healthy cache, task progress
export const WARN = 'warning' // stalled, paused, low cache, held notes, the memory badge
export const ERR = 'error' // dead, refuted, failed
export const MUTED = 'inactive' // idle, ended, finished
export const ATTN = 'permission' // waits on the person's approval: the one colour that must stand out, used for nothing else
export const BRAND = 'claude' // the word belay

// Context pressure: the default colour under 70%, amber from 70%, red from 90%. A proposal, not a measured threshold.
export const CTX_WARN_PCT = 70
export const CTX_ERR_PCT = 90
export const ctxColor = (pct: number): string | undefined => (pct >= CTX_ERR_PCT ? ERR : pct >= CTX_WARN_PCT ? WARN : undefined)

// The header card's border: drawn only when the pane has room for it and its padding.
export const CARD_MIN_COLS = 30
export const cardInner = (cols: number): number => (cols >= CARD_MIN_COLS ? cols - 4 : cols)

// A heading segment: bold, and the heading colour when one is set.
export const headSeg = (t: string): { t: string; bold: true; c?: string } => (HEADING ? { t, bold: true, c: HEADING } : { t, bold: true })
