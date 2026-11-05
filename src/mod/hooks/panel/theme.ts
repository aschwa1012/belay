// The panel's colours by role, all theme keys, so a light and a dark theme both read. Colour goes on state glyphs, severity and the one number
// that matters; labels stay default, secondary text dim, headings the accent. Pure: no `$`, no drawing.

export const ACCENT = 'suggestion' // section headings, the context bar
export const OK = 'success' // running, holds, healthy cache, task progress
export const WARN = 'warning' // stalled, paused, low cache, held notes, the memory badge
export const ERR = 'error' // dead, refuted, failed
export const MUTED = 'inactive' // idle, ended, finished
export const ATTN = 'permission' // waits on the person's approval: the one colour that must stand out
export const BRAND = 'claude' // the word belay

// Context pressure: under 70% the accent, from 70% amber, from 90% red. A proposal, not a measured threshold.
export const CTX_WARN_PCT = 70
export const CTX_ERR_PCT = 90
export const ctxColor = (pct: number): string => (pct >= CTX_ERR_PCT ? ERR : pct >= CTX_WARN_PCT ? WARN : ACCENT)

// The header card's border: drawn only when the pane has room for it and its padding.
export const CARD_MIN_COLS = 30
export const cardInner = (cols: number): number => (cols >= CARD_MIN_COLS ? cols - 4 : cols)
