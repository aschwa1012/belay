import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, NOTE_ID, boot, openPane, pane, leaves, words } from './support'

// What the polish pass must never lose: the reason an awaiting note waits, the awaits clause in the heading, the three settle buttons,
// the off state beside a held count, and an estimated cost over $100.
const LONG = 'the review could not tell whether the claim in this note still holds after the refactor of the retrieval path, so it needs a person to decide'
const entry = (reason: string, title: string) => ({ total: 1, awaiting_operator: 1, entries: [{ note_id: NOTE_ID, project: 'acme', title, kind: 'wrong', ground: 'reported', awaiting_operator: true, undecided: { reason } }] })
const heldEv = (count: number, awaiting: number) => ({ kind: 'notes_held', ts: T0, run_id: RUN, count, unsupported: 0, by_project: { acme: count }, by_ground: { reported: count }, awaiting_operator: awaiting, oldest_age_runs: 0, command: 'belay memory review' })
const notices = (...events: unknown[]) => ({ run_id: RUN, events })
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('the awaiting note keeps its reason', () => {
  for (const cols of [30, 40, 72]) {
    for (const [name, title] of [['with a title', 'pid poll note'], ['without a title', '']] as const) {
      test(`a long reason is wrapped whole at ${cols} columns, ${name}`, async ($, on) => {
        const wd = await boot($, on, { notices: notices(heldEv(1, 1)), awaitingList: entry(LONG, title) })
        await openPane($, wd)
        const { ui } = await pane($, 'terminal', cols)
        const rows = leaves(await ui.drawn())
        expect(flat(rows.join(' '))).toContain(flat(LONG)) // every word of it, across the wrapped lines
        expect(rows.some(r => r.includes('08954ec7'))).toBe(true)
      })
    }
  }
  test('the three settle buttons are whole at 30 columns', async ($, on) => {
    const wd = await boot($, on, { notices: notices(heldEv(1, 1)), awaitingList: entry('cannot say', 'x') })
    await openPane($, wd)
    const rows = leaves(await (await pane($, 'terminal', 30)).ui.drawn())
    for (const a of ['archive', 'release', 'reoffer']) expect(rows).toContain(`  ▸ ${a}`)
  })
})

describe('the memory heading', () => {
  for (const cols of [30, 40, 72]) {
    test(`a three-digit count keeps the awaits clause whole at ${cols} columns`, async ($, on) => {
      const wd = await boot($, on, { notices: notices(heldEv(100, 99)) })
      await openPane($, wd)
      const text = flat(leaves(await (await pane($, 'terminal', cols)).ui.drawn()).join(' '))
      expect(text).toContain('100 held')
      expect(text).toContain('99 await you')
    })
  }
  test('memory off beside held notes says both in the heading', async ($, on) => {
    const wd = await boot($, on, { notices: notices(heldEv(3, 0)), memoryNotice: true })
    await openPane($, wd)
    expect(flat(words(await (await pane($)).ui.drawn()))).toContain('MEMORY off · 3 held')
  })
  test('the footer names the settle buttons too', async ($, on) => {
    const wd = await boot($, on, { notices: notices(heldEv(3, 1)) })
    await openPane($, wd)
    expect((await pane($)).text).toContain('read-only except the review and settle buttons')
  })
})

describe('an estimated cost of $100 or more', () => {
  test('is shown whole, without cents, beside the ≈', async ($, on) => {
    const wd = await boot($, on, { orchBasis: 'transcript, API rates', orchCost: 123.45 })
    await openPane($, wd)
    const rows = leaves(await (await pane($, 'terminal', 72)).ui.drawn())
    expect(rows).toContain('≈$123')
  })
})
