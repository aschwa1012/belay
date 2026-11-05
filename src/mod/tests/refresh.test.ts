import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { boot, colours, EVENTS, later, leaves, openPane, pane, RUN, squeezed, T0, words } from './support'

// The refreshed pane: a header card (run, state, elapsed, task progress and cost), bold headings that carry no colour, colour on state and
// severity only, a NOTICES heading that reads "N (M new)" and folds without marking anything seen, a one-line MEMORY row, the
// context-pressure colour and when a worker row was first started.
const flat = (s: string) => s.replace(/\s+/g, ' ')
const hh = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

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
    // the turn-end hint does not fit beside the tasks at 70 columns, so it is the part that drops
    expect((await ui.find({ key: 'pt' }))?.text).toMatch(/^tasks ▰+▱+ 1\/3 {3}\$3\.88 as of \d\d:\d\d · 1 agent unrecorded$/)
    expect(await ui.find({ key: 'pc' })).toBeUndefined() // the cost shares the line
    expect(squeezed(await ui.drawn(), 70)).toEqual([])
  })
  test('the cost keeps its as-of at every width, and says how many agents are unrecorded', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    for (const cols of [100, 34, 26]) {
      const p = await pane($, 'terminal', cols)
      const line = (await p.ui.find({ key: 'pc' }))?.text ?? (await p.ui.find({ key: 'pt' }))?.text ?? ''
      expect(line, String(cols)).toMatch(/\$3\.88 as of \d\d:\d\d/) // never a bare figure
      if (cols >= 100) expect(line).toContain('· 1 agent unrecorded · moves at turn end')
    }
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
    // The orchestrator's words are one Text the host wraps (wrap="wrap"), so that leaf is longer than the pane by design.
    for (const r of leaves(await narrow.ui.drawn())) if (!r.startsWith('Spawned rev-1')) expect([...r].length, r).toBeLessThanOrEqual(26)
  })
  test('a run with no tasks says so instead of an empty bar', async ($, on) => {
    const wd = await boot($, on, { tasks: { done: 0, total: 0 } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    expect((await ui.find({ key: 'pt' }))?.text).toMatch(/^tasks none yet /)
  })
})

describe('colour', () => {
  test('section headings are bold with no colour, so the approval colour stays on approvals', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui, text } = await pane($, 'terminal', 70)
    for (const h of ['AGENTS', 'NOTICES', 'MEMORY', 'ORCHESTRATOR']) {
      const t = await ui.find({ type: 'Text', text: h })
      expect(t?.props.color, h).toBeUndefined()
      expect(t?.props.bold, h).toBe(true)
    }
    expect(flat(text)).toContain('AGENTS 4 live · 4 busy')
    const texts = await ui.findAll({ type: 'Text' })
    for (const t of texts.filter((x: any) => x.props.color === 'permission' || x.props.color === 'suggestion')) expect(t.text.trim().startsWith('▲'), t.text).toBe(true)
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
  const between = (t: string) => t.slice(t.indexOf('NOTICES'), t.indexOf('ORCHESTRATOR'))
  test('the heading reads "N (M new)" before the pane has marked them seen', async ($, on) => {
    await boot($, on)
    const { text } = await pane($, 'terminal', 70) // drawn without /orch: nothing is marked seen yet
    expect(flat(text)).toContain('NOTICES 4 (3 new)') // the stopped worker is listed but never new
  })
  test('the ▾ folds the list to its heading, led by the worst tone, and opens it again', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
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
  test('a notice that arrives while the list is folded stays new until the list is opened', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const first = await pane($, 'terminal', 70)
    await first.ui.press({ key: 'fold:sn' })
    wd.w.notices = { run_id: RUN, events: [...EVENTS, { kind: 'worker_stalled', ts: T0 + 4000, run_id: RUN, worker_id: 'rev-1', state: 'running', last_event_age_ms: 320000, pid: 4, pid_alive: true }] }
    await later(wd, 6000) // a round with the pane open: the new notice is read but not drawn
    await later(wd, 6000) // and another, so a mark-seen in the round would have landed
    expect(flat((await pane($, 'terminal', 70)).text)).toContain('NOTICES ◌ 5 (1 new)') // led by the new one's mark, not the older ▲
    const p = await pane($, 'terminal', 70)
    await p.ui.press({ key: 'fold:sn' })
    expect(flat(words(await p.ui.drawn()))).toContain('NOTICES 5 (1 new)') // drawn now, marked seen by the next round
    await later(wd, 6000)
    const opened = flat((await pane($, 'terminal', 70)).text)
    expect(opened).toContain('NOTICES 5')
    expect(opened).not.toContain('(1 new)')
  })
})

describe('the memory row', () => {
  test('MEMORY is one line: the menu button and the run\'s embedder, beside the notes', async ($, on) => {
    const wd = await boot($, on, { embedder: 'ok' })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    expect(flat((await ui.find({ key: 'smem-h' }))?.text ?? '')).toBe('MEMORY ◇ memory menu embedder ok')
    expect((await ui.find({ type: 'Text', text: /^ok$/ }))?.props.color).toBe('success')
    const t = words(await ui.drawn())
    expect(t.indexOf('MEMORY')).toBeGreaterThan(t.indexOf('AGENTS'))
    expect(t.indexOf('MEMORY')).toBeLessThan(t.indexOf('NOTICES'))
    expect((await ui.find({ key: 'pt' }))?.text).not.toContain('embedder') // the embedder left the tasks line
  })
  test('on a narrow pane the embedder goes under the row, whole, and on a very narrow one the button too', async ($, on) => {
    const wd = await boot($, on, { embedder: 'warming' })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 32)
    expect(flat((await ui.find({ key: 'smem-h' }))?.text ?? '')).toBe('MEMORY ◇ memory menu')
    expect((await ui.find({ key: 'smem-e2' }))?.text).toBe('embedder warming')
    const tiny = await pane($, 'terminal', 18)
    expect(flat((await tiny.ui.find({ key: 'smem-h' }))?.text ?? '').trim()).toBe('MEMORY')
    expect(await tiny.ui.find({ key: 'mem' })).toBeDefined()
  })
})

describe('when a worker row was first started', () => {
  test('shows the time and how long ago, and the exit once one is recorded; it is the row\'s age, not an uptime', async ($, on) => {
    const wd = await boot($, on, { agentOver: { 'coder-1': { started_at_ms: T0 - 12 * 60000 }, 'coder-2': { started_at_ms: T0 - 20 * 60000, exited_at_ms: T0 - 5 * 60000 } } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    await ui.press({ key: 'agent:coder-1' })
    const one = words(await ui.drawn())
    expect(one).toContain(`started ${hh(T0 - 12 * 60000)} (12m ago)`)
    expect(one).not.toContain('uptime')
    await ui.press({ key: 'agent:coder-2' })
    expect(words(await ui.drawn())).toContain(`started ${hh(T0 - 20 * 60000)} (20m ago) · exited ${hh(T0 - 5 * 60000)}`)
  })
  test('is not shown when belay recorded no start', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 70)
    await ui.press({ key: 'agent:coder-1' })
    expect(words(await ui.drawn())).not.toMatch(/started \d\d:\d\d/)
  })
})

describe('other surfaces', () => {
  test('the plain lines carry task progress, and the cost once', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { text } = await pane($, 'desktop')
    expect(text).toMatch(/tasks ▰+▱+ 1\/3/)
    expect(text.split('$3.88').length - 1).toBe(1)
  })
})
