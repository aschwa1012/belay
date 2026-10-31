import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { TASK4, T0, RUN, iso, AGENTS, FOOTER, EVENTS, NOTICES, TRANSCRIPT, DEFAULTS, SETTINGS, FULL_RUNFILE, world, START, BAND_PROPS, PANE_PROPS, PRES, cmd, colours, words, boot, later, band, pane, openPane, READ_VERBS, type World } from './support'

describe('a wedged belay', () => {
  const agentsAt = (wd: any) => wd.attempts.filter((a: any) => a.verb === 'agents').map((a: any) => a.t - T0)
  const gaps = (xs: number[]) => xs.slice(1).map((t, i) => t - xs[i]!)

  test('the round has a hard 25 s timeout; on a timed-out read the round stops, the old data stays stale, one dim line says so', async ($, on) => {
    const wd = await boot($, on)
    expect(wd.rounds.length).toBeGreaterThan(0)
    expect(wd.rounds.every(a => a.timeoutMs === 25000)).toBe(true) // one process per refresh, bounded as a whole; each read inside is bounded by the verb
    const before = wd.attempts.filter(a => a.verb === 'notices').length
    wd.w.hang = 'agents'
    await later(wd, 5000)
    const t = (await band($)).text
    expect(t).toContain('reads slow (agents timed out)')
    expect(t).toContain('stale: last read failed')
    expect(t).not.toContain('● running')
    expect(t).toContain('4 agents') // the last data is kept
    expect(wd.attempts.filter(a => a.verb === 'notices').length).toBe(before) // the rest of the round was skipped
  })

  test('it backs off 10 s, doubling to 60 s, while timeouts continue', async ($, on) => {
    const wd = await boot($, on, { hang: 'agents' })
    await later(wd, 300000)
    expect(gaps(agentsAt(wd)).slice(0, 5)).toEqual([10000, 20000, 40000, 60000, 60000])
  })

  test('one success resets the back-off to the first step', async ($, on) => {
    const wd = await boot($, on, { hang: 'agents' })
    await later(wd, 31000) // attempts at 1 s, 11 s, 31 s: the next wait would be 40 s
    wd.w.hang = null
    await later(wd, 40000) // the 40 s wait ends: a success
    expect((await band($)).text).not.toContain('timed out')
    wd.w.hang = 'agents'
    await later(wd, 10000) // the next attempt, 10 s after the last round ended, times out
    await later(wd, 10000)
    const gap = gaps(agentsAt(wd))
    expect(gap.slice(-1)[0]).toBe(10000) // a new streak starts at 10 s, not 80 s
  })

  test('a round still running when the timer fires is not joined by another', async ($, on) => {
    const wd = await boot($, on, { slow: 2500 })
    await later(wd, 40000)
    expect(wd.stat.maxActive).toBe(1)
    expect(agentsAt(wd).length).toBeGreaterThan(1)
  })

  test('a timeout is recognised by the wait, not by the words of the error (mutant: recognised only by its text)', async ($, on) => {
    const wd = await boot($, on, { rejectAfter: { verb: 'panel-read', ms: 25000, msg: 'spawn failed' } })
    await later(wd, 30000)
    expect((await band($)).text).toContain('reads slow (agents timed out)')
  })

  // Each part of a round takes 1 s here, and the parts of a round are sequential, so the gap between a round's last part started and the next round's
  // first (agents) is the wait after the round ENDED plus that last part's second.
  const gapsAfterEnd = (wd: any): number[] => {
    const xs = wd.attempts as { verb: string; t: number }[]
    const out: number[] = []
    for (let i = 1; i < xs.length; i += 1) if (xs[i]!.verb === 'agents') out.push(xs[i]!.t - (xs[i - 1]!.t + 1000))
    return out
  }

  test('the next round starts 10 s after the last one ENDS with the band alone', async ($, on) => {
    const band = await boot($, on, { slow: 1000 })
    await later(band, 120000)
    const b = gapsAfterEnd(band)
    expect(b.length).toBeGreaterThan(3)
    for (const g of b) { expect(g).toBeGreaterThanOrEqual(10000); expect(g).toBeLessThan(11500) }
  })
  test('the same with the pane open: 5 s after the end', async ($, on) => {
    const wd = await boot($, on, { slow: 1000 })
    await cmd($, 'orch')
    await later(wd, 90000)
    const open = gapsAfterEnd(wd).slice(-5)
    expect(open.length).toBe(5)
    for (const g of open) { expect(g).toBeGreaterThanOrEqual(5000); expect(g).toBeLessThan(6500) }
  })
  test('once the run has ended the panel refreshes every 60 s, pane open or not, and opening the pane still reads at once', async ($, on) => {
    const wd = await boot($, on, { slow: 1000, orchDisplay: 'done' })
    await later(wd, 300000)
    const b = gapsAfterEnd(wd)
    expect(b.length).toBeGreaterThanOrEqual(3)
    for (const g of b) { expect(g).toBeGreaterThanOrEqual(60000); expect(g).toBeLessThan(61500) }
    const before = wd.rounds.length
    await cmd($, 'orch') // a person's action resets the clock
    await later(wd, 2000)
    expect(wd.rounds.length).toBeGreaterThan(before)
    const mid = wd.rounds.length
    await later(wd, 30000) // ... and the next one is a minute away, even with the pane open
    expect(wd.rounds.length).toBe(mid)
  })
  test('each refresh is one belay process, and no other read command is started by a round', async ($, on) => {
    const wd = await boot($, on, { mode: 'headless', notices: { run_id: 'r-7f3a', events: [{ kind: 'notes_held', ts: T0, run_id: 'r-7f3a', count: 1, unsupported: 0, by_project: { acme: 1 }, by_ground: { reported: 1 }, awaiting_operator: 1, oldest_age_runs: 0, command: 'belay memory review' }] } })
    await later(wd, 60000)
    expect(wd.rounds.length).toBeGreaterThan(3)
    expect(wd.rounds.every(r => r.argv.includes('panel-read'))).toBe(true)
    expect(wd.attempts.some(a => a.verb === 'transcript')).toBe(true)
    expect(wd.ran.some(a => a.includes('--awaiting'))).toBe(true)
    expect(wd.ran.length).toBeGreaterThan(wd.rounds.length * 2) // several reads answered per process
  })
  test('a failed agents read keeps the last known run state: an ended run stays at the slow refresh and backs off while the read keeps failing', async ($, on) => {
    const wd = await boot($, on, { orchDisplay: 'done' })
    wd.w.failAgents = true
    await later(wd, 400000)
    const ts = wd.rounds.map(r => r.t)
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!)
    expect(gaps.length).toBeGreaterThan(3)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(60000) // never the 10 s band cadence, though the snapshot's own run state is now unknown
    expect(wd.rounds.every(r => r.argv.includes('--prev-run'))).toBe(false) // the first round had no earlier run
    expect(wd.rounds.slice(1).every(r => r.argv.includes('--prev-run'))).toBe(true) // the later ones name the run seen last
  })
})
