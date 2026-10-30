import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { boot, band, openPane, pane } from './support'

// The no-project notice (notes are on by default, memory.project unset): a title, one sentence why and the exact fix at the top of the
// pane, a one-line warning in the band, and nothing at all once belay stops reporting it.
describe('memory is off notice', () => {
  test('shown at the top of the pane with the title, the reason and the exact config line', async ($, on) => {
    const wd = await boot($, on, { memoryNotice: true })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('Notes are on, but no project is set, so this run keeps no notes')
    expect(text).toContain('set one: belay settings memory.project <name>')
    expect(text).toContain('belay settings memory.notes false')
    expect(text).not.toContain('nothing is saved or recalled') // the full explanation is the CLI's
    expect(text.indexOf('Notes are on, but no project is set, so this run keeps no notes')).toBeGreaterThan(text.indexOf('AGENTS')) // the notice sits in the memory section, under the agents
  })

  test('shown in the band as the title and the one short fix line', async ($, on) => {
    await boot($, on, { memoryNotice: true })
    const { text } = await band($)
    expect(text).toContain('Notes are on, but no project is set, so this run keeps no notes')
    expect(text).toContain('set one: belay settings memory.project <name>')
    expect(text).not.toContain('nothing is saved or recalled')
  })

  test('with no run the notice comes from the settings read and shows in the pane', async ($, on) => {
    const wd = await boot($, on, { memoryNotice: true, watchId: '', noRun: true })
    await openPane($, wd)
    expect((await pane($)).text).toContain('Notes are on, but no project is set, so this run keeps no notes')
  })

  test('once a project is set belay reports none and the panel shows nothing', async ($, on) => {
    const wd = await boot($, on, {})
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).not.toContain('Notes are on, but no project is set')
    expect(text).not.toContain('"project"')
  })
})
