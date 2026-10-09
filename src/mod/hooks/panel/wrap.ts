// Display width and wrapping for the pane's long parts. Pure code, no Node and no Intl: the mod host has neither
// guaranteed. Width is counted in terminal cells per grapheme cluster (a wide character or an emoji sequence is
// two), not in codepoints.
//
// Wrapping breaks only at a space or at a part separator, so a word is never split; a word wider than the room
// stays whole on its own line. What happens to such a line is the caller's: ids that an operator types are put
// on a flush line with more room (see Detail, Notices and cmdLines in view.tsx); a long descriptive field that
// still does not fit is cut at its end with an ellipsis by clipCells, and that is the only place text is cut.

const inR = (c: number, r: [number, number][]): boolean => r.some(([a, b]) => c >= a && c <= b)
const ZERO: [number, number][] = [[0x300, 0x36f], [0x200b, 0x200f], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff], [0xe0020, 0xe007f], [0x20d0, 0x20ff]]
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x231a, 0x231b], [0x23e9, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]
const RI = (c: number): boolean => c >= 0x1f1e6 && c <= 0x1f1ff

// Grapheme clusters, close enough for terminal widths: marks, joiners, variation selectors and skin tones join
// the previous cluster, a character after a joiner joins it, and two regional indicators make one flag.
export function clusters(s: string): string[] {
  const out: string[] = []
  let prevJoin = false
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const last = out.length - 1
    const riPair = RI(c) && last >= 0 && [...out[last]!].length === 1 && RI(out[last]!.codePointAt(0)!)
    if (last >= 0 && (inR(c, ZERO) || prevJoin || riPair)) out[last] += ch
    else out.push(ch)
    prevJoin = c === 0x200d
  }
  return out
}

function clusterCells(g: string): number {
  const cps = [...g].map(x => x.codePointAt(0)!)
  if (cps.every(c => inR(c, ZERO))) return 0
  if (cps.some(c => inR(c, WIDE) || RI(c)) || cps.includes(0xfe0f)) return 2
  return 1
}

export const cells = (s: string): number => clusters(s).reduce((n, g) => n + clusterCells(g), 0)

// Cut to n cells, ending in an ellipsis when something was cut. Never splits a cluster.
export function clipCells(s: string, n: number): string {
  if (cells(s) <= n) return s
  let out = ''
  let used = 0
  for (const g of clusters(s)) {
    const w = clusterCells(g)
    if (used + w > n - 1) break
    out += g
    used += w
  }
  return n > 0 ? out + '…' : ''
}

// Break prose at spaces. A lone '·' token at a break is dropped rather than left to start or end a line.
export function wordWrap(text: string, room: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur === '') { cur = w; continue }
    if (cells(cur) + 1 + cells(w) <= room) { cur += ` ${w}`; continue }
    out.push(cur)
    cur = w === '·' ? '' : w
  }
  if (cur !== '') out.push(cur)
  return out.length ? out : ['']
}

// Pack parts onto lines, joined by `sep`. A part that fits a line is never split; one that does not is
// word-wrapped on its own lines. A part goes to the next line whole when it would overflow this one.
export function wrapParts(parts: string[], sep: string, room: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const p of parts.filter(x => x !== '')) {
    if (cur !== '' && cells(cur) + cells(sep) + cells(p) <= room) { cur += sep + p; continue }
    if (cur !== '') { out.push(cur); cur = '' }
    if (cells(p) <= room) cur = p
    else { const w = wordWrap(p, room); out.push(...w.slice(0, -1)); cur = w[w.length - 1]! }
  }
  if (cur !== '') out.push(cur)
  return out.length ? out : ['']
}

// The lines of a notice's command row: "→ cmd   ·   cmd". Commands that fit are packed whole. If any command does
// not fit its own line, splitting it would leave "belay approve" and an id on separate lines that read as two
// commands, so instead the id they share is shown once, whole, on a line labelled `id`, and each command is
// written with `<id>` in its place: the operator copies the id and types the command. Commands that share no
// id are one per line and cut at their end if still too wide.
export function cmdLines(cmd: string, room: number): string[] {
  const cmds = cmd.split(/\s+·\s+/).filter(Boolean)
  const inner = Math.max(8, room - 2)
  const mark = (ls: string[]): string[] => ls.map((t, i) => (i === 0 ? `→ ${t}` : `  ${t}`))
  if (cmds.every(c => cells(c) <= inner)) return mark(wrapParts(cmds, '   ·   ', inner))
  const last = cmds.map(c => c.split(' ').pop()!)
  if (cmds.every(c => c.includes(' ')) && last.every(l => l === last[0])) {
    return mark([`id ${last[0]}`, ...cmds.map(c => `${c.slice(0, c.length - last[0]!.length)}<id>`)])
  }
  return mark(cmds.map(c => clipCells(c, inner)))
}
