import { describe, expect, test } from 'claude-code/testing'
import { boot, openPane, pane } from './support'

// The no-project notice (notes are on by default, memory.project unset): a title, one sentence why and the exact fix at the top of the
// pane, a one-line warning in the band, and nothing at all once belay stops reporting it.
describe('memory is off notice', () => {
  test('shown at the top of the pane with the title, the reason and the exact config line', async ($, on) => {
    const wd = await boot($, on, { memoryNotice: true })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('Memory is off for this project')
    expect(text).toContain('nothing is saved or recalled')
    expect(text).toContain('"memory": { "project": "<name>" }')
    expect(text.indexOf('Memory is off for this project')).toBeLessThan(text.indexOf('agents'))
  })

  test('once a project is set belay reports none and the panel shows nothing', async ($, on) => {
    const wd = await boot($, on, {})
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).not.toContain('Memory is off')
    expect(text).not.toContain('"project"')
  })
})
