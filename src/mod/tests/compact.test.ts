import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, boot, later, openPane, pane, leaves } from './support'

// The compact awaiting list: one line per note (up to 5), a press opens one note at a time, and only the open note has the settle buttons.
const idOf = (i: number) => `${String(i).padStart(2, '0')}aaaaaa-0000-0000-0000-000000000000`
const short = (i: number) => `${String(i).padStart(2, '0')}aaaaaa`
const entries = (n: number, reason = (i: number) => `reason ${i}`, title = (i: number) => `title ${i}`) =>
  Array.from({ length: n }, (_, i) => ({ note_id: idOf(i + 1), project: 'acme', title: title(i + 1), kind: 'wrong', ground: 'reported', awaiting_operator: true, undecided: { reason: reason(i + 1) } }))
const heldEv = (n: number) => ({ kind: 'notes_held', ts: T0, run_id: RUN, count: n, unsupported: 0, by_project: { acme: n }, by_ground: { reported: n }, awaiting_operator: n, oldest_age_runs: 0, command: 'belay memory review' })
const world = (n: number, reason?: (i: number) => string, title?: (i: number) => string) =>
  ({ notices: { run_id: RUN, events: [heldEv(n)] }, awaitingList: { total: n, awaiting_operator: n, entries: entries(n, reason, title) } })
const flat = (s: string) => s.replace(/\s+/g, ' ')
const noteRows = (rows: string[]) => rows.filter(r => r === '▲ ').length

const seen: Record<string, string[]> = {}
describe('the compact awaiting list is bounded', () => {
  for (const cols of [30, 40, 72]) {
    for (const n of [1, 5, 30]) {
      test(`${n} awaiting at ${cols} columns: one line each up to 5`, async ($, on) => {
        const wd = await boot($, on, world(n))
        await openPane($, wd)
        const rows = leaves(await (await pane($, 'terminal', cols)).ui.drawn())
        seen[`${n}-${cols}`] = rows
        expect(noteRows(rows)).toBe(Math.min(n, 5))
        expect(rows.some(r => r.includes('▸ archive'))).toBe(false) // none open: no buttons
        expect(flat(rows.join(' ')).includes('more · belay memory held --awaiting')).toBe(n > 5)
        if (n === 30) {
          expect(flat(rows.join(' '))).toContain('+25 more · belay memory held --awaiting')
          // the same lines as 5 awaiting plus the "+N more" line (which wraps to at most 3 lines on a narrow pane)
          expect(rows.length - seen[`5-${cols}`]!.length).toBeLessThanOrEqual(3)
        }
        for (const r of rows) expect([...r].length, r).toBeLessThanOrEqual(cols + 12) // a leaf is never wider than a pane (the orchestrator words wrap by the host)
      })
    }
  }
})

const key = (i: number) => `note:${idOf(i)}`
const drawnButtons = async (ui: any) => leaves(await ui.drawn()).filter(r => r.includes('▸ archive')).length

describe('a press opens one note, and only the open note has buttons', () => {
  test('open, switch, close; opening runs nothing', async ($, on) => {
    const wd = await boot($, on, world(3))
    await openPane($, wd)
    const { ui } = await pane($)
    const before = wd.ran.length
    expect(await drawnButtons(ui)).toBe(0)
    await ui.press({ key: key(1) })
    expect(await drawnButtons(ui)).toBe(1)
    expect(leaves(await ui.drawn())).toContain('  ▸ archive')
    await ui.press({ key: key(2) }) // only one is open at a time
    expect(await drawnButtons(ui)).toBe(1)
    await expect(ui.press({ key: `archive-${idOf(1)}` })).rejects.toThrow() // the first note's buttons are gone
    await ui.press({ key: key(2) }) // pressing it again closes it
    expect(await drawnButtons(ui)).toBe(0)
    await later(wd, 50)
    expect(wd.settled).toEqual([])
    expect(wd.asked).toEqual([])
    expect(wd.spawned).toEqual([])
    expect(wd.writes).toEqual([])
    expect(wd.ran.slice(before).every(a => !a.includes('settle'))).toBe(true)
  })

  test('a settle press on a closed note is impossible, and nothing is settled', async ($, on) => {
    const wd = await boot($, on, { ...world(3), answers: ['because', 'Archive'] })
    await openPane($, wd)
    const { ui } = await pane($)
    await expect(ui.press({ key: `archive-${idOf(1)}` })).rejects.toThrow()
    await later(wd, 50)
    expect(wd.settled).toEqual([])
    expect(wd.asked).toEqual([])
  })

  test('a note that leaves the list closes, and does not reopen when it returns', async ($, on) => {
    const wd = await boot($, on, world(2))
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: key(1) })
    expect(await drawnButtons(ui)).toBe(1)
    const full = wd.w.notices
    wd.w.notices = { run_id: RUN, events: [heldEv(0)] }
    await later(wd, 6000)
    wd.w.notices = full
    await later(wd, 6000)
    expect(await drawnButtons(ui)).toBe(0)
  })
})

describe('the open note shows everything the core returned', () => {
  const REASON = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') // 600+ characters of words
  const PATH = 'C:/work/demo-x/Projects/belay/docs/archives/memory-archives/deeply/nested/folder/file-name-that-is-long.md'
  for (const cols of [30, 40, 72]) {
    test(`a long reason is shown in full when open at ${cols} columns, cut only at the core's 500`, async ($, on) => {
      const wd = await boot($, on, world(1, () => REASON))
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      await ui.press({ key: key(1) })
      const text = flat(leaves(await ui.drawn()).join(' '))
      const want = REASON.slice(0, 499).trim() // 499 characters and an ellipsis make the core's 500
      expect(text).toContain(want.slice(0, want.lastIndexOf(' ')))
    })
    test(`a path wider than the pane is hard-wrapped, not cut, at ${cols} columns`, async ($, on) => {
      const wd = await boot($, on, world(1, () => `see ${PATH} for the details`))
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      await ui.press({ key: key(1) })
      const rows = leaves(await ui.drawn())
      expect(rows.join('').replace(/\s/g, '')).toContain(PATH)
      for (const r of rows.filter(r => PATH.includes(r.trim()) && r.trim().length > 8)) expect([...r].length, r).toBeLessThanOrEqual(cols)
    })
  }
  test('the title is wrapped whole in the open note and clipped in the one-line list', async ($, on) => {
    const TITLE = 'a title that is far too long to fit on one line of a narrow pane at all'
    const wd = await boot($, on, world(1, undefined, () => TITLE))
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 30)
    expect(flat(leaves(await ui.drawn()).join(' '))).not.toContain(TITLE)
    await ui.press({ key: key(1) })
    expect(flat(leaves(await ui.drawn()).join(' '))).toContain(TITLE.slice(0, 20))
    expect(flat(leaves(await ui.drawn()).join(' '))).toContain('narrow pane at all')
  })
})
