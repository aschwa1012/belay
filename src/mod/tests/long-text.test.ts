import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { MENU, boot, later, openPane, pane, squeezed, words } from './support'

const flat = (s: string): string => s.replace(/\s+/g, '')

// Long free text is wrapped to the pane, never cut off at the side: a notice's explanation under its clipped headline, and the Memory menu's answers.
for (const cols of [30, 40, 71]) {
  describe(`long text at ${cols} columns`, () => {
    test('a notice whose text is longer than the row keeps a clipped headline and wraps the whole text under it', async ($, on) => {
      const wd = await boot($, on, { runId: 'render-20261008061234-abcdef', longNotices: true })
      await openPane($, wd)
      const wide = flat((await pane($, 'terminal', 200)).text)
      expect(wide).toContain(flat('pid not alive (process exit observed by the adapter)'))
      const { ui, text } = await pane($, 'terminal', cols)
      expect(squeezed(await ui.drawn(), cols)).toEqual([])
      expect(flat(text)).toContain(flat('pid not alive (process exit observed by the adapter)'))
    })

    test('the Memory menu wraps its warning and a long profile line instead of cutting them off', async ($, on) => {
      const wd = await boot($, on, { heavy: true, menu: MENU({ levers: { ...MENU().levers, routing: { reviewer: 'gpu-rerank-fast' } } }) })
      await openPane($, wd)
      const p = await pane($, 'terminal', cols)
      await p.ui.press({ key: 'mem' })
      await later(wd, 10500)
      const tree = await p.ui.drawn() // the tab bar and the GPU line are fixed-width and not text to wrap: only the free text is checked
      const t = flat(words(tree))
      expect(t).toContain(flat('the saved routing and this profile together need 6.9 GB and 6.8 GB is free: a run would fall back or refuse (see Routing)'))
      expect(t).toContain(flat('gpu-balanced Qwen3-Embedding-4B Q4_K_M + Qwen3-Reranker-4B Q4_K_M'))
    })
  })
}
