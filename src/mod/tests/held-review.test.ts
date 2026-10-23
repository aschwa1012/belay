import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, boot, cmd, later, pane, openPane, words } from './support'

// The memory line and its one write action (ADR 0036 amendment, proposed): the Opus archive review, started only by two presses of the
// button, through a short launcher that detaches the review so a reload of the panel cannot orphan it. These tests prove the line, the
// confirm, the launch, the cancels, the review's state read back from belay (it survives a reload), and that nothing else can reach it.
const held = (n = 3, by: Record<string, number> = { acme: n }, unsupported = 0) => ({ kind: 'notes_held', ts: T0, run_id: RUN, count: n, unsupported, by_project: by, oldest_age_runs: 2, command: 'belay memory review' })
const running = (pid_alive = true) => ({ kind: 'review_running', ts: T0, run_id: RUN, project: 'acme', pid: 77, job: 'archreview-r-1', claim_id: 'me-1', pid_alive })
const ended = (ok: boolean, text: string) => ({ kind: 'review_ended', ts: T0, run_id: RUN, project: 'acme', ok, code: ok ? null : 'E_ARGS', text, job: 'archreview-r-1', claim_id: 'me-1' })
const notices = (...events: unknown[]) => ({ run_id: RUN, events })

describe('notes held for the archive reviewer', () => {
  test('the count line names the count, the oldest wait in runs and the projects, and a clean store shows none', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(3)) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('MEMORY  3 held') // the heading carries the count
    expect(text).toContain('oldest 2 runs · acme') // the detail line does not repeat it
    expect(text).toContain('review the held notes')
  })

  test('the plain line says how long the oldest held note has waited', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...held(3), oldest_at: T0 - 2 * 3600000 + 5 * 60000 }) })
    await openPane($, wd)
    expect((await pane($)).text).toMatch(/oldest 2 runs · acme · oldest waited [0-9]h[0-9][0-9]m/) // 2h05m at the first render, the clock moves a little while it boots
  })

  test('a run that tripped the circuit breaker is flagged on the held line, briefly', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...held(7, { acme: 7 }), oldest_at: T0 - 30000 }, { kind: 'run_disputed', ts: T0, run_id: RUN, disputed_run: 'r-breaker-9', project: 'acme', disputed: 7, limit: 5, command: 'belay memory review' }) })
    await openPane($, wd)
    expect((await pane($)).text).toContain(' · run r-breake disputed 7: review')
  })

  test('the by-ground line says it too', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...{ ...held(4), by_ground: { reported: 3, same_claim: 1 } }, oldest_at: T0 - 90000 }) })
    await openPane($, wd)
    expect((await pane($)).text).toMatch(/MEMORY  4 held[sS]*3 reported wrong, 1 duplicate · oldest waited [0-9]m/)
  })

  test('the unsupported line says it too', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...held(3, { acme: 3 }, 3), oldest_at: T0 - 30000 }) })
    await openPane($, wd)
    expect((await pane($)).text).toMatch(/3 unsupported · oldest 2 runs · acme · oldest waited ([0-9]+s|[0-9]m)/)
  })

  test('unsupported notes are counted apart from the holds that carry a warning, and the same button reviews both', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(8, { acme: 8 }, 3)) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('5 wrong or duplicate · 3 unsupported · oldest 2 runs · acme')
    expect(text).toContain('review the held notes')
  })

  test('only unsupported notes: the line says so alone', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(3, { acme: 3 }, 3)) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('3 unsupported · oldest 2 runs')
    expect(text).not.toContain('held as wrong')
  })

  test('with nothing held the pane has no memory line and no button', async ($, on) => {
    const wd = await boot($, on, { notices: notices() })
    await openPane($, wd)
    expect((await pane($)).text).not.toContain('held for review')
  })

  test('the first press asks (count, the question, cost unknown) and starts nothing; the second runs the one launcher', async ($, on) => {
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
    expect(argv.slice(argv.indexOf('memory'), argv.indexOf('memory') + 5)).toEqual(['memory', 'review', '--project', 'acme', '--start'])
    expect(wd.spawned[0]).toContain('--json') // the real argv path: belay prints JSON, and the toast is the parsed line
    expect(wd.toasts).toContain('belay: archive review of acme started: pid 4242, job archreview-r-1')
    expect(wd.toasts.some(t => t.includes('{'))).toBe(false)
    expect(wd.ran.some(a => a.includes('review'))).toBe(false) // never through the read rounds
  })

  test('a launcher that refuses or fails is toasted with its exit code and first line, so the press never ends in silence', async ($, on) => {
    const launcher = { exitCode: 1, stdout: JSON.stringify({ error: { code: 'E_BUSY', message: 'an archive review of acme is already running (pid 77, job archreview-r-1)', project: 'acme' } }), stderr: '' }
    const wd = await boot($, on, { notices: notices(held(3)), launcher })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'review' })
    await ui.press({ key: 'review' })
    await later(wd, 10)
    expect(wd.toasts).toContain('belay: the review was not started (exit 1): E_BUSY: an archive review of acme is already running (pid 77, job archreview-r-1)')
  })

  test('a review in flight is read back from belay: the line says running, and there is no button to press over it', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(3), running()) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('archive review of acme running · pid 77')
    expect(text).toContain('MEMORY  3 held')
    expect(text).not.toContain('review the held notes')
  })

  test('an interrupted review (its process gone) says so and the button is back', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(2), running(false)) })
    await openPane($, wd)
    const a = await pane($)
    expect(a.text).toContain('INTERRUPTED')
    expect(a.text).toContain('review the held notes')
  })

  test('a review that failed shows its code and reason, with the held notes still counted', async ($, on) => {
    const wd = await boot($, on, { notices: notices(held(2), ended(false, 'the archive review did not finish inside 600 s')) })
    await openPane($, wd)
    expect((await pane($)).text).toContain('archive review of acme FAILED · the archive review did not finish inside 600 s')
  })

  test('a finished review with nothing left held shows its outcome and no count line or button', async ($, on) => {
    const wd = await boot($, on, { notices: notices(ended(true, 'ran as archreview-r-1: {"applied":3}')) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('archive review of acme done · 3 applied · job archreview-r-1')
    expect(text).not.toContain('{"applied"')
    expect(text).not.toContain('held for review')
    expect(text).not.toContain('review the held notes')
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

describe('the held count is broken down by ground', () => {
  test('the line names the grounds and how many wait for the operator', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...held(3), by_ground: { reported: 2, same_claim: 1 }, awaiting_operator: 1 }) })
    const text = (await pane($)).text
    expect(text).toContain('MEMORY  3 held · 1 awaits you') // the heading
    expect(text).toContain('2 reported wrong, 1 duplicate') // the detail line
    void wd
  })
})
