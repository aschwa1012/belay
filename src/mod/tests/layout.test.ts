import { describe, expect, test } from 'claude-code/testing'
import { band, boot, leaves, openPane, pane, squeezed, words } from './support'

const LONG_RUN = 'render-20261008061234-abcdef'

// At the docked pane's real body width (about 71 columns) and at a narrower 40: nothing asks for more than
// it has, no glyph or time is squeezed away, nothing wraps one character a row, and the run line's first
// part ("belay <run>") stays whole.
for (const cols of [71, 40]) {
  describe(`layout at ${cols} columns`, () => {
    test('the pane: long notices keep their glyph and time, and no row is squeezed', async ($, on) => {
      const wd = await boot($, on, { runId: LONG_RUN, longNotices: true })
      await openPane($, wd)
      const { ui, text } = await pane($, 'terminal', cols)
      const tree = await ui.drawn()
      expect(squeezed(tree, cols)).toEqual([])
      expect(text).toContain(`belay ${LONG_RUN}`)
      expect(text).toMatch(/✓\s*\d\d:\d\d/) // the review-holds notice with a UUID
      expect(text).toMatch(/✕\s*\d\d:\d\d/) // the dead worker with exit 1
      expect(text).toMatch(/▲\s*\d\d:\d\d/)
      expect(leaves(tree).filter(l => /^[A-Za-z0-9]$/.test(l))).toEqual([])
    })

    test('the pane: an opened detail row keeps its label and truncates its value at the end', async ($, on) => {
      const wd = await boot($, on, { runId: LONG_RUN })
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      await ui.press({ key: 'agent:coder-1' })
      const tree = await ui.drawn()
      expect(squeezed(tree, cols)).toEqual([])
      const t = words(tree)
      for (const label of ['status  ', 'launch  ', 'task    ']) expect(t).toContain(label)
    })

    test('the band: the run, state and elapsed come first and whole, parts drop from the end', async ($, on) => {
      await boot($, on, { runId: LONG_RUN, longNotices: true })
      const { ui, text } = await band($, 'terminal', cols)
      expect(squeezed(await ui.drawn(), cols)).toEqual([])
      expect(text).toContain(`belay ${LONG_RUN}`)
      if (cols >= 60) expect(text).toContain('● running')
    })
  })
}
