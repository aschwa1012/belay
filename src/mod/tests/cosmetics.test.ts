import { describe, expect, test } from 'claude-code/testing'
import { boot, band, pane, openPane, leaves, RUN, T0 } from './support'

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
    expect(text).toContain('a-very-long-age…')
    expect(text).not.toContain('note-reviewe|')
  })
  test('interactive: the orchestrator row says interactive instead of ?, and has no cost mark of a number', async ($, on) => {
    const wd = await boot($, on, { mode: 'interactive', noDisplay: true })
    await openPane($, wd)
    const { text } = await pane($, 'terminal', 120)
    expect(text).toContain('interactive')
    expect(text).toMatch(/◇\s*orchestrator/)
  })
  test('no cost recorded yet says so', async ($, on) => {
    const wd = await boot($, on, { footer: { agents: 1, total_cost_usd: null, cost_not_recorded: 1, as_of_ms: null, highest_context_pct: null } })
    await openPane($, wd)
    const { text } = await pane($, 'terminal', 120)
    expect(text).toContain('no cost recorded yet · 1 agent unrecorded')
    expect(text).not.toContain('as of unknown')
  })
})
void RUN; void T0
