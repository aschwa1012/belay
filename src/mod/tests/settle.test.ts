import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, NOTE_ID, boot, later, pane, openPane } from './support'

// The settle buttons: a held note that waits on the operator can be archived, released or reoffered from the panel. Each press asks for a
// reason, asks to confirm, and only then runs `belay memory held settle`; the reason is one argv element.
const held = { kind: 'notes_held', ts: T0, run_id: RUN, count: 1, unsupported: 0, by_project: { acme: 1 }, by_ground: { reported: 1 }, awaiting_operator: 1, oldest_age_runs: 0, command: 'belay memory review' }
const notices = (...events: unknown[]) => ({ run_id: RUN, events })
const waiting = notices(held)
const KEY = (a: string) => `${a}-${NOTE_ID}`

describe('the settle buttons', () => {
  test('a note that awaits the operator gets archive, release and reoffer; a held note that does not gets none', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('08954ec7')
    for (const a of ['archive', 'release', 'reoffer']) expect(text).toContain(`▸ ${a}`)
    expect(wd.ran.some(a => a.includes('--awaiting'))).toBe(true)
  })

  test('with nothing awaiting there are no buttons and the list is not read', async ($, on) => {
    const wd = await boot($, on, { notices: notices({ ...held, awaiting_operator: 0 }) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).not.toContain('▸ archive')
    expect(wd.ran.some(a => a.includes('--awaiting'))).toBe(false)
  })

  for (const action of ['archive', 'release', 'reoffer'] as const) {
    test(`${action}: reason, confirm, then one command with the reason as a single argv element, and the proof is toasted`, async ($, on) => {
      const reason = `it's "wrong"  -x --archive  two  spaces`
      const verb = action[0]!.toUpperCase() + action.slice(1)
      const wd = await boot($, on, { notices: waiting, answers: [reason, verb], settleOut: { exitCode: 0, stdout: JSON.stringify({ id: NOTE_ID, action, outcome: `${action}d`, receipt: 'held-settle:abc@1' }), stderr: '' } })
      await openPane($, wd)
      const { ui } = await pane($)
      await ui.press({ key: KEY(action) })
      await later(wd, 100)
      expect(wd.asked[1]).toBe(`${verb} note 08954ec7? reason: ${reason.replace(/\s{2,}/g, ' ')}`)
      expect(wd.settled.length).toBe(1)
      const argv = wd.settled[0]!
      const tail = argv.slice(argv.indexOf('memory'))
      expect(tail.slice(0, 8)).toEqual(['memory', 'held', 'settle', NOTE_ID, `--${action}`, '--reason', reason, '--json'])
      expect(wd.toasts.at(-1)).toBe(`belay: ${action} 08954ec7: ${action}d · receipt held-settle:abc@1`)
    })
  }

  const cancels: [string, string[]][] = [['cancel at the reason', ['Cancel', 'Archive']], ['a dismissed reason', []], ['a blank reason', ['  ', 'Archive']], ['the hint chosen as the reason', ['Type the reason under Other', 'Archive']], ['cancel at the confirm', ['because', 'Cancel']], ['text typed at the confirm', ['because', 'something typed under Other']]]
  for (const [name, answers] of cancels) {
    test(`${name} runs nothing`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting, answers })
      await openPane($, wd)
      const { ui } = await pane($)
      await ui.press({ key: KEY('archive') })
      await later(wd, 100)
      expect(wd.settled).toEqual([])
    })
  }

  test('a failure toasts the error text', async ($, on) => {
    const err = { error: { code: 'E_STALE', message: 'the note moved on' } }
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Release'], settleOut: { exitCode: 1, stdout: JSON.stringify(err), stderr: '' } })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: KEY('release') })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
    expect(wd.toasts.at(-1)).toBe('belay: the note was not settled (exit 1): E_STALE: the note moved on')
  })

  test('nothing but a settle button runs the write: opening, ticking and the review button do not', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    await pane($)
    await later(wd, 12000)
    expect(wd.settled).toEqual([])
    expect(wd.asked).toEqual([])
  })
})

describe('the held line keeps what the operator must act on', () => {
  for (const cols of [30, 40, 50, 72]) {
    test(`the awaits count survives a ${cols}-column pane (the line wraps, it is not cut)`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { text } = await pane($, 'terminal', cols)
      expect(text).toContain('awaits')
      expect(text).toContain('you')
    })
  }
})
