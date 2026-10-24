import { describe, expect, test } from 'claude-code/testing'
import { TASK4, T0, RUN, iso, AGENTS, FOOTER, EVENTS, NOTICES, TRANSCRIPT, DEFAULTS, SETTINGS, FULL_RUNFILE, world, START, BAND_PROPS, PANE_PROPS, PRES, cmd, colours, words, boot, later, band, pane, openPane, READ_VERBS, type World } from './support'

describe('a wedged belay', () => {
  const agentsAt = (wd: any) => wd.attempts.filter((a: any) => a.verb === 'agents').map((a: any) => a.t - T0)
  const gaps = (xs: number[]) => xs.slice(1).map((t, i) => t - xs[i]!)

  test('every command has a hard 8 s timeout; on a timeout the round stops, the old data stays stale, one dim line says so', async ($, on) => {
    const wd = await boot($, on)
    expect(wd.attempts.every(a => a.timeoutMs === 8000)).toBe(true)
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
    await later(wd, 6000) // the next attempt, 5 s later, times out
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
    const wd = await boot($, on, { rejectAfter: { verb: 'agents', ms: 8000, msg: 'spawn failed' } })
    await later(wd, 10000)
    expect((await band($)).text).toContain('reads slow (agents timed out)')
  })

  test('the next round starts 4 s after the last one ENDS with the pane open, 5 s with the band alone', async ($, on) => {
    const gapsAfterEnd = (wd: any) => {
      const xs = wd.attempts as { verb: string; t: number }[]
      const out: number[] = []
      for (let i = 1; i < xs.length; i += 1) if (xs[i]!.verb === 'agents') out.push(xs[i]!.t - (xs[i - 1]!.t + 1000)) // each command takes 1 s
      return out
    }
    const band = await boot($, on, { slow: 1000 })
    await later(band, 60000)
    const b = gapsAfterEnd(band)
    expect(b.length).toBeGreaterThan(3)
    for (const g of b) { expect(g).toBeGreaterThanOrEqual(5000); expect(g).toBeLessThan(6500) }
  })
  test('the same with the pane open: 4 s after the end', async ($, on) => {
    const wd = await boot($, on, { slow: 1000 })
    await cmd($, 'orch')
    await later(wd, 60000)
    const xs = wd.attempts as { verb: string; t: number }[]
    const gaps: number[] = []
    for (let i = 1; i < xs.length; i += 1) if (xs[i]!.verb === 'agents') gaps.push(xs[i]!.t - (xs[i - 1]!.t + 1000))
    const open = gaps.slice(-6)
    for (const g of open) { expect(g).toBeGreaterThanOrEqual(4000); expect(g).toBeLessThan(5500) }
  })
})
