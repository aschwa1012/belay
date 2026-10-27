import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, boot, later, pane, openPane, band } from './support'

// A read that times out or fails is never silent: the panel keeps the last data and says so in a dim line, with the time the data was last
// all fresh, until a later round succeeds. The band and the pane both carry it, at any width.
const held = { kind: 'notes_held', ts: T0, run_id: RUN, count: 1, unsupported: 0, by_project: { acme: 1 }, by_ground: { reported: 1 }, awaiting_operator: 1, oldest_age_runs: 0, command: 'belay memory review' }
const lastRound = (wd: any): number => wd.attempts.filter((a: any) => a.verb === 'agents').at(-1).t // the last round's time before a read is made to fail: when the data was last all fresh
const asOf = (ms: number) => `as of ${new Date(ms).toTimeString().slice(0, 8)}`
const flat = (s: string) => s.replace(/\s+/g, '')

const paneText = async ($: any, cols: number) => { const p = await pane($, 'terminal', cols); const t = flat(p.text); await p.ui.unmount(); return t }

for (const cols of [30, 40, 72]) {
  describe(`a read that does not land, at ${cols} columns`, () => {
    test('notices: the stale line appears in the band and the pane, the data stays, and the next success clears it', async ($, on) => {
      const wd = await boot($, on)
      await openPane($, wd)
      expect(flat((await band($, 'terminal', cols)).text)).not.toContain('readsslow')
      const good = lastRound(wd)
      wd.w.hang = 'notices'
      await later(wd, 6000)
      const b = flat((await band($, 'terminal', cols)).text)
      expect(b).toContain(flat(`${asOf(good)} · reads slow (notices timed out)`))
      const pn = await pane($, 'terminal', cols)
      const p = flat(pn.text)
      await pn.ui.unmount()
      expect(p).toContain(flat(`${asOf(good)} · reads slow (notices timed out)`))
      expect(p).toContain('coder-0stopped') // the last notices stay
      expect(p).toContain('coder-1') // so do the agents of the same round
      wd.w.hang = null
      await later(wd, 11000) // past the 10 s back-off
      expect(flat((await band($, 'terminal', cols)).text)).not.toContain('readsslow')
      const again = await pane($, 'terminal', cols)
      expect(flat(again.text)).not.toContain('readsslow')
      await again.ui.unmount()
    })

    test('agents: the stale line names agents, and a later success clears it', async ($, on) => {
      const wd = await boot($, on)
      const good = lastRound(wd)
      wd.w.hang = 'agents'
      await later(wd, 6000)
      const b = flat((await band($, 'terminal', cols)).text)
      expect(b).toContain(flat(`${asOf(good)} · reads slow (agents timed out)`))
      if (cols >= 72) expect(b).toContain('4agents') // a narrow band drops parts from the end
      expect(b).toContain('belayr-7f3a')
      wd.w.hang = null
      await later(wd, 11000)
      expect(flat((await band($, 'terminal', cols)).text)).not.toContain('readsslow')
    })

    test('the awaiting list: a timeout names the awaiting list; a failure that is not a timeout says failed', async ($, on) => {
      const wd = await boot($, on, { notices: { run_id: RUN, events: [held] }, awaitingHang: true })
      await openPane($, wd)
      expect(await paneText($, cols)).toContain('readsslow(awaitinglisttimedout)')
      wd.w.awaitingHang = false
      wd.w.awaitingFail = true
      await later(wd, 11000)
      const p = await paneText($, cols)
      expect(p).toContain('awaitinglistfailed')
      expect(p).not.toContain('readsslow')
      wd.w.awaitingFail = false
      await later(wd, 6000)
      expect(await paneText($, cols)).not.toContain('awaitinglistfailed')
    })
  })
}

describe('a failed read says why; a timed-out one has no reason to give', () => {
  test('the error text rides the stale line whole when the read failed, and is absent for a timeout', async ($, on) => {
    const wd = await boot($, on)
    wd.w.failAgents = true
    await later(wd, 6000)
    const f = flat((await band($, 'terminal', 30)).text)
    expect(f).toContain(flat('agents failed: belay agents r-7f3a exit 3')) // wrapped at 30 columns, never cut
    wd.w.failAgents = false
    await later(wd, 6000)
    wd.w.hang = 'agents'
    await later(wd, 6000)
    const t = flat((await band($, 'terminal', 30)).text)
    expect(t).toContain('readsslow(agentstimedout)')
    expect(t).not.toContain('failed:')
    expect(t).not.toContain('exit')
  })
})

describe('a slow read does not stack rounds', () => {
  test('rounds stay one at a time through a run of timeouts', async ($, on) => {
    const wd = await boot($, on, { slow: 2500, hang: 'notices' })
    await openPane($, wd)
    await later(wd, 120000)
    expect(wd.stat.maxActive).toBe(1)
    expect(wd.attempts.filter(a => a.verb === 'notices').length).toBeGreaterThan(1)
  })
})
