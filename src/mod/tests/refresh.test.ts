import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { boot, colours, leaves, openPane, pane, RUN, squeezed, T0, words } from './support'

// The refreshed pane: a header card (run, state, elapsed, task progress and cost), accent headings, colour on state and severity only,
// a NOTICES heading that reads "N (M new)" and folds, a one-line MEMORY row, the context-pressure colour and a worker's uptime.
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('the header card', () => {
  test('a round dim border holds the run id, its state and elapsed, and task progress with the cost on one line', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui, text } = await pane($, 'terminal', 70)
    const card = await ui.find({ key: 'card' })
    expect(card?.props.borderStyle).toBe('round')
    expect(card?.props.borderColor).toBe('inactive')
    expect(text).toContain(`belay ${RUN}`)
    expect(text).toContain('● running 42m')
    expect((await ui.find({ key: 'pt' }))?.text).toMatch(/^tasks ▰+▱+ 1\/3 {3}\$3\.88 @\d\d:\d\d · 1 unrecorded$/)
    expect(await ui.find({ key: 'pc' })).toBeUndefined() // the cost shares the line
    expect(squeezed(await ui.drawn(), 70)).toEqual([])
  })
  test('on a narrow pane the cost takes its own line, and under 30 columns the border goes', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const mid = await pane($, 'terminal', 34)
    expect((await mid.ui.find({ key: 'pt' }))?.text).toMatch(/^tasks ▰+▱+ 1\/3$/)
    expect((await mid.ui.find({ key: 'pc' }))?.text).toContain('$3.88')
    expect((await mid.ui.find({ key: 'card' }))?.props.borderStyle).toBe('round')
    const narrow = await pane($, 'terminal', 26)
    expect((await narrow.ui.find({ key: 'card' }))?.props.borderStyle).toBeUndefined()
    for (const r of leaves(await narrow.ui.drawn())) if (!r.startsWith('Spawned rev-1')) expect([...r].length, r).toBeLessThanOrEqual(26)
  })
})

describe('colour', () => {
  test('section headings are the accent colour and bold; the AGENTS heading counts live and busy', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui, text } = await pane($, 'terminal', 70)
    for (const h of ['AGENTS', 'NOTICES', 'MEMORY', 'ORCHESTRATOR']) {
      const t = await ui.find({ type: 'Text', text: h })
      expect(t?.props.color, h).toBe('suggestion')
      expect(t?.props.bold, h).toBe(true)
    }
    expect(flat(text)).toContain('AGENTS 4 live · 4 busy')
  })
  test('a review that holds is green and a paused run amber: no extra hues', async ($, on) => {
    const events = [
      { kind: 'review_verdict', ts: T0 - 60000, run_id: RUN, task_id: 't-2', executable: true, passed: true, verdict: 'holds', judged_by: 'rev-0' },
      { kind: 'run_paused', ts: T0 - 30000, run_id: RUN, paused_by: 'operator' },
    ]
    const wd = await boot($, on, { notices: { run_id: RUN, events } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    expect((await ui.find({ type: 'Text', text: '‖' }))?.props.color).toBe('warning')
    expect((await ui.findAll({ type: 'Text', text: '✓' })).some((t: any) => t.props.color === 'success')).toBe(true)
    const used = colours(await ui.drawn())
    expect(used).not.toContain('planMode')
    expect(used).not.toContain('merged')
  })
  test('the context percent is plain under 70%, amber from 70% and red from 90%', async ($, on) => {
    const wd = await boot($, on, { agentOver: { 'coder-1': { context_pct: 95 } } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 100)
    expect((await ui.find({ type: 'Text', text: '95%' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: '80%' }))?.props.color).toBe('warning') // rev-1
    expect((await ui.find({ type: 'Text', text: '22%' }))?.props.color).toBeUndefined() // coder-2
  })
})

describe('notices', () => {
  test('the heading reads "N (M new)" before the pane has marked them seen', async ($, on) => {
    await boot($, on)
    const { text } = await pane($, 'terminal', 70) // drawn without /orch: nothing is marked seen yet
    expect(flat(text)).toContain('NOTICES 4 (3 new)') // the stopped worker is listed but never new
  })
  test('the ▾ folds the list to its heading, led by the worst tone, and opens it again', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    const between = (t: string) => t.slice(t.indexOf('NOTICES'), t.indexOf('MEMORY'))
    expect(between(words(await ui.drawn()))).toContain('p-19')
    await ui.press({ key: 'fold:sn' })
    const folded = words(await ui.drawn())
    expect(between(folded)).not.toContain('p-19')
    expect(flat(between(folded))).toContain('NOTICES ▲ 4')
    expect((await ui.find({ key: 'fold:sn' }))?.props.label).toBe(' ▸')
    expect(wd.writes).toEqual([])
    await ui.press({ key: 'fold:sn' })
    expect(between(words(await ui.drawn()))).toContain('p-19')
  })
})

describe('the memory row and the footer', () => {
  test('MEMORY is one line: the menu button and the run\'s embedder', async ($, on) => {
    const wd = await boot($, on, { embedder: 'ok' })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    const row = await ui.find({ key: 'smem-h' })
    expect(row?.text).toBe('MEMORY  ◇ memory menu  embedder ok')
    expect((await ui.find({ type: 'Text', text: /^ok$/ }))?.props.color).toBe('success')
    const t = words(await ui.drawn())
    expect(t.indexOf('MEMORY')).toBeGreaterThan(t.indexOf('NOTICES'))
    expect(t.indexOf('MEMORY')).toBeLessThan(t.indexOf('ORCHESTRATOR'))
    expect(t).not.toContain('embedder ok   ') // the embedder left the tasks line
  })
  test('on a narrow pane the embedder goes under the row, whole', async ($, on) => {
    const wd = await boot($, on, { embedder: 'warming' })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 32)
    expect((await ui.find({ key: 'smem-h' }))?.text).toBe('MEMORY  ◇ memory menu')
    expect((await ui.find({ key: 'smem-e2' }))?.text).toBe('embedder warming')
  })
})

describe('a worker\'s uptime', () => {
  test('comes from its row\'s started_at, to now while it runs and to its exit once it has exited', async ($, on) => {
    const wd = await boot($, on, { agentOver: { 'coder-1': { started_at_ms: T0 - 12 * 60000 }, 'coder-2': { started_at_ms: T0 - 20 * 60000, exited_at_ms: T0 - 5 * 60000 } } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    await ui.press({ key: 'agent:coder-1' })
    expect(words(await ui.drawn())).toContain('uptime  12m')
    await ui.press({ key: 'agent:coder-2' })
    expect(words(await ui.drawn())).toContain('uptime  ran 15m, exited')
  })
  test('is not shown when belay recorded no start', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    await ui.press({ key: 'agent:coder-1' })
    expect(words(await ui.drawn())).not.toContain('uptime')
  })
})

describe('other surfaces', () => {
  test('the plain lines carry task progress and the cost too', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { text } = await pane($, 'desktop')
    expect(text).toMatch(/tasks ▰+▱+ 1\/3 {3}\$3\.88/)
  })
})
