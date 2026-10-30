import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { MENU, boot, later, leaves, openPane, pane, squeezed, words } from './support'

const flat = (s: string): string => s.replace(/\s+/g, '')

// Long free text is wrapped to the pane, never cut off at the side: a notice's explanation under its clipped headline, and the Memory menu's answers.
for (const cols of [30, 40, 71]) {
  describe(`long text at ${cols} columns`, () => {
    test('a notice whose text is longer than the row shows its text once: the first line beside the time, the rest wrapped under it', async ($, on) => {
      const wd = await boot($, on, { runId: 'render-20261008061234-abcdef', longNotices: true })
      await openPane($, wd)
      const wide = flat((await pane($, 'terminal', 200)).text)
      expect(wide).toContain(flat('pid not alive (process exit observed by the adapter)'))
      const { ui, text } = await pane($, 'terminal', cols)
      expect(squeezed(await ui.drawn(), cols)).toEqual([])
      expect(flat(text)).toContain(flat('pid not alive (process exit observed by the adapter)'))
      expect(flat(text).split(flat('coder-0 dead')).length - 1).toBe(1) // the text once: no clipped headline followed by the same sentence in full
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

    test('the Memory menu keeps a number with its unit and each profile cost whole, and its footer is one row at the standard width', async ($, on) => {
      const wd = await boot($, on, { heavy: true })
      await openPane($, wd)
      const p = await pane($, 'terminal', cols)
      await p.ui.press({ key: 'mem' })
      await later(wd, 10500)
      const rows = leaves(await p.ui.drawn()).map(l => l.trim())
      expect(rows.filter(r => /^s(\s|$)/.test(r) || /^(GB|MB|ms)/.test(r) || /~[0-9.]+$/.test(r))).toEqual([]) // no unit starts a row, no number ends one
      expect(rows.some(r => r.includes('~3.6 s  no VRAM'))).toBe(true) // the cost of cpu-rerank, whole on one row
      expect(rows.filter(r => /VRAM$|GB$/.test(r) && /~/.test(r)).length).toBeGreaterThan(0)
      if (cols >= 71) expect(rows).toContain('writes config via belay settings · two presses · /orch toggles')
    })
  })
}
