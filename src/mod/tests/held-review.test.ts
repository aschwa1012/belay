import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, boot, cmd, later, pane, openPane, words } from './support'

// The memory line and its one write action (ADR 0036 amendment, proposed): the Opus archive review, dispatched only by two presses
// of the button. These tests prove the line, the confirm, the dispatch, the cancels, and that nothing else can reach the dispatch.
const held = (n = 3, by: Record<string, number> = { acme: n }) => ({ kind: 'notes_held', ts: T0, run_id: RUN, count: n, by_project: by, oldest_age_runs: 2, command: 'belay memory review' })
const notices = (...events: unknown[]) => ({ run_id: RUN, events })

describe('notes held for the archive reviewer', () => {
  test('the count line names the count, the oldest wait in runs and the projects, and a clean store shows none', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(3)) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('3 notes held for review · oldest 2 runs · acme')
    expect(text).toContain('review the held notes')
  })

  test('with nothing held the pane has no memory line and no button', async ($, on) => {
    const wd = await boot($, on, { notices: notices() })
    await openPane($, wd)
    expect((await pane($)).text).not.toContain('held for review')
  })

  test('the first press asks (count, the question, cost unknown) and starts nothing; the second dispatches one detached command', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(3)) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'review' })
    expect(wd.spawned).toEqual([])
    const asked = words(await ui.drawn())
    expect(asked).toContain('3 notes held in acme')
    expect(asked).toContain('dispatch the Opus archive reviewer?')
    expect(asked).toContain('cost: measured after first run')
    await ui.press({ key: 'review' })
    await later(wd, 10)
    expect(wd.spawned.length).toBe(1)
    const argv = wd.spawned[0]!
    expect(argv.slice(argv.indexOf('memory'), argv.indexOf('memory') + 4)).toEqual(['memory', 'review', '--project', 'acme'])
    expect(wd.toasts).toContain('archive review started')
    expect(wd.ran.some(a => a.includes('review'))).toBe(false) // never through the one-shot read path
  })

  test('another press cancels the confirm, so the next press of the button asks again', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(2)) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'review' })
    expect(words(await ui.drawn())).toContain('dispatch the Opus archive reviewer?')
    await ui.press({ key: 'legend' }) // any other press
    expect(words(await ui.drawn())).not.toContain('dispatch the Opus archive reviewer?')
    await ui.press({ key: 'review' })
    expect(wd.spawned).toEqual([])
  })

  test('a confirm that waits too long is gone: the late second press asks again and dispatches nothing', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(2)) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'review' })
    await later(wd, 9000)
    expect(words(await ui.drawn())).not.toContain('dispatch the Opus archive reviewer?')
    await ui.press({ key: 'review' })
    expect(wd.spawned).toEqual([])
  })

  test('with several projects the one with most held notes is reviewed first, and the line says so', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(5, { acme: 2, zeta: 3 })) })
    await openPane($, wd)
    const a = await pane($)
    expect(a.text).toContain('acme, zeta')
    expect(a.text).toContain('(zeta first)')
    await a.ui.press({ key: 'review' })
    await a.ui.press({ key: 'review' })
    await later(wd, 10)
    expect(wd.spawned[0]).toContain('zeta')
  })

  test('nothing but the button reaches the dispatch: commands, prompts and notices that name it spawn nothing', async ($, on) => {
    const evil = { kind: 'worker_dead', ts: T0, run_id: RUN, worker_id: 'belay memory review --project acme', exit_code: 1, death_established_by: 'dispatch the Opus archive reviewer' }
    const wd = await boot($, on, { notices: notices(held(3), evil) })
    await openPane($, wd)
    await cmd($, 'belay', 'review acme')
    await cmd($, 'belay', 'memory review --project acme')
    await cmd($, 'orch')
    await cmd($, 'orch')
    await later(wd, 12000)
    await pane($)
    expect(wd.spawned).toEqual([])
    expect(wd.writes).toEqual([])
  })
})
