import { describe, expect, test } from 'claude-code/testing'
import { boot, band, pane, openPane, leaves, words, RUN, T0 } from './support'

// Cosmetic rules the operator saw in the GUI: a compact memory notice that wraps cleanly, a visible name cut, an interactive
// orchestrator with a state word, and a cost line that says so when none is known.
describe('compact memory notice', () => {
  for (const cols of [40, 50, 72]) {
    test(`pane at ${cols}: the title and the short fix, wrapped, no leaf wider than the pane`, async ($, on) => {
      const wd = await boot($, on, { memoryNotice: true })
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      const rows = leaves(await ui.drawn())
      expect(rows.join(' ')).toContain('Memory is off for this project')
      expect(rows.join(' ').replace(/[ ]+/g, ' ')).toContain('belay settings memory.notes false')
      for (const r of rows) if (!r.startsWith('Spawned rev-1')) expect([...r].length, r).toBeLessThanOrEqual(cols)
    })
  }
  test('the band shows the same short line', async ($, on) => {
    await boot($, on, { memoryNotice: true })
    const { text } = await band($, 'terminal', 40)
    expect(text.replace(/[ ]+/g, ' ')).toContain('belay settings memory.project <name>')
    expect(text).not.toContain('belay never guesses')
  })
})

describe('agent names and the interactive orchestrator', () => {
  test('a long name is cut with an ellipsis only past the cap, never mid-word silently', async ($, on) => {
    const wd = await boot($, on, { agentIds: ['note-reviewer', 'a-very-long-agent-name-indeed'] })
    await openPane($, wd)
    const text = leaves(await (await pane($, 'terminal', 120)).ui.drawn()).join('|')
    expect(text).toContain('note-reviewer')
    expect(text).toContain('a-very-l…-indeed')
    expect(text).not.toContain('note-reviewe|')
  })
  test('interactive: the orchestrator row says interactive instead of ?, and has no cost mark of a number', async ($, on) => {
    const wd = await boot($, on, { mode: 'interactive', noDisplay: true, orchNoCost: true })
    await openPane($, wd)
    const { text } = await pane($, 'terminal', 120)
    expect(text).toContain('interactive')
    expect(text).toContain('n/a')
    expect(text).toMatch(/◇\s*orchestrator/)
  })
  for (const [basis, want] of [['transcript, API rates', '≈$1.84'], ['stream', '$1.84']] as const) {
    test(`an orchestrator cost with basis "${basis}" shows ${want}; only the transcript estimate carries ≈`, async ($, on) => {
      const wd = await boot($, on, { orchBasis: basis })
      await openPane($, wd)
      const text = words(await (await pane($, 'terminal', 120)).ui.drawn())
      expect(text).toContain(want)
      if (basis !== 'transcript, API rates') expect(text).not.toContain('≈')
    })
  }
  for (const cols of [30, 40, 72]) {
    test(`an orchestrator with a token count and no window shows the tokens, never a made-up percent, at ${cols} columns`, async ($, on) => {
      const wd = await boot($, on, { orchTokensOnly: true })
      await openPane($, wd)
      const rows = leaves(await (await pane($, 'terminal', cols)).ui.drawn())
      if (cols >= 72) expect(rows).toContain('18.2k') // the ctx column has room
      expect(rows.some(r => r.includes('18247'))).toBe(false)
      const i = rows.findIndex(r => r.trim() === 'orchestrator')
      expect(rows.slice(i, i + 6).some(r => /^\d+%$/.test(r.trim()))).toBe(false) // no percent for the orchestrator row
    })
  }
  test('no cost recorded yet says so', async ($, on) => {
    const wd = await boot($, on, { footer: { agents: 1, total_cost_usd: null, cost_not_recorded: 1, as_of_ms: null, highest_context_pct: null } })
    await openPane($, wd)
    const { text } = await pane($, 'terminal', 120)
    expect(text).toContain('no cost recorded yet · 1 agent unrecorded')
    expect(text).not.toContain('as of unknown')
  })
})
void RUN; void T0

const flat = (s: string) => s.replace(/\s+/g, ' ')
// ---- the context column: tokens always, the percent when the window is known ----
describe('the context column reads the same for every row', () => {
  for (const cols of [30, 40, 50, 72]) {
    test(`tokens first, the percent only with room, and never a percent alone, at ${cols} columns`, async ($, on) => {
      const wd = await boot($, on, { orchTokensOnly: true })
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      const rows = leaves(await ui.drawn())
      const hasTok = rows.includes('610.0k') // coder-1: tokens and a window
      const hasPct = rows.includes('61%')
      if (hasPct) expect(hasTok).toBe(true) // the percent never stands without its tokens
      if (cols >= 72) { expect(hasTok && hasPct).toBe(true); expect(rows).toContain('18.2k') } // the orchestrator: tokens, no window, no made-up percent
      if (cols <= 30) expect(hasPct).toBe(false) // narrow: the percent goes first
      for (const r of rows) if (!r.startsWith('Spawned rev-1')) expect([...r].length, r).toBeLessThanOrEqual(cols)
    })
  }
  test('the legend describes the column', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 100)
    await ui.press({ key: 'legend' })
    expect(flat(words(await ui.drawn()))).toContain('18.2k · 2% context: tokens, and the share of the window when known')
  })
})

// ---- a review that was cut, failed or abandoned is finished ----
describe('a dead review worker is a finished review', () => {
  const ID = 'archreview-r-7f3a-mvln6h2p'
  const cut = { run_id: RUN, events: [{ kind: 'worker_dead', ts: T0 - 60000, run_id: RUN, worker_id: ID, exit_code: 1, exit_signal: null, death_established_by: 'exit-event' }] }
  test('it is not live: it is counted under finished, with its outcome and the command to clear it', async ($, on) => {
    const wd = await boot($, on, { deadReview: true, notices: cut })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 100)
    const t = flat(leaves(await ui.drawn()).join(' '))
    expect(t).toContain('AGENTS 4 live') // the four live agents of the fixture; the dead review is not among them
    expect(t).toContain('▸ 2 finished') // coder-0 and the review
    await ui.press({ key: 'fold' })
    const open = leaves(await ui.drawn())
    expect(open.some(r => r.startsWith('archreview-r-7f3a'))).toBe(true)
    expect(open).toContain('cut') // the outcome in the task column
    await ui.press({ key: 'agent:' + ID })
    const d = flat(leaves(await ui.drawn()).join(' '))
    expect(d).toContain('outcome cut')
    expect(d).toContain('clear belay worker rm ' + ID) // the detail's own clear row, not only the notice's command
  })
  test('without an exit code in the notice the outcome is "no answer"', async ($, on) => {
    const wd = await boot($, on, { deadReview: true })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 100)
    await ui.press({ key: 'fold' })
    expect(leaves(await ui.drawn())).toContain('no answer')
  })
  test('its death is a finished notice, not a red alert, and the band does not count it', async ($, on) => {
    const wd = await boot($, on, { deadReview: true, notices: cut })
    await openPane($, wd)
    const { ui, text } = await pane($, 'terminal', 100)
    expect(text).toContain('cut off before it answered')
    expect(flat(leaves(await ui.drawn()).join(' '))).not.toMatch(/✕\s*\d\d:\d\d/)
    const b = await band($, 'terminal', 100)
    expect(b.text).not.toContain(ID)
  })
  test('a dead coder is still live: someone should look at it', async ($, on) => {
    const wd = await boot($, on, { deadCoder: true })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 100)
    expect(flat(leaves(await ui.drawn()).join(' '))).toContain('AGENTS 5 live')
  })
  test('at 30 columns nothing is wider than the pane', async ($, on) => {
    const wd = await boot($, on, { deadReview: true, notices: cut })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 30)
    await ui.press({ key: 'fold' })
    for (const r of leaves(await ui.drawn())) if (!r.startsWith('Spawned rev-1')) expect([...r].length, r).toBeLessThanOrEqual(30)
  })
})
