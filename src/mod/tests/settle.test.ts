import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, NOTE_ID, FULL_RUNFILE, START, boot, cmd, later, pane, openPane, words } from './support'

// The settle buttons: a held note that waits on the operator can be archived, released or reoffered from the panel. Each press asks for a
// reason, asks to confirm, and only then runs `belay memory held settle`; the reason is one argv element.
const held = { kind: 'notes_held', ts: T0, run_id: RUN, count: 1, unsupported: 0, by_project: { acme: 1 }, by_ground: { reported: 1 }, awaiting_operator: 1, oldest_age_runs: 0, command: 'belay memory review' }
const notices = (...events: unknown[]) => ({ run_id: RUN, events })
const waiting = notices(held)
const KEY = (a: string) => `${a}-${NOTE_ID}`
const OPEN = `note:${NOTE_ID}`

describe('the settle buttons', () => {
  test('a note that awaits the operator gets archive, release and reoffer; a held note that does not gets none', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui, text } = await pane($)
    expect(text).toContain('08954ec7')
    expect(text).not.toContain('▸ archive') // closed: one line, no buttons
    await ui.press({ key: OPEN })
    for (const a of ['archive', 'release', 'reoffer']) expect(words(await ui.drawn())).toContain(`▸ ${a}`)
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
      await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
      await ui.press({ key: KEY(action) })
      await later(wd, 100)
      expect(wd.asked[1]).toBe(`${verb} note 08954ec7 "pid poll note"? reason: ${reason}`)
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
      await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
      await ui.press({ key: KEY('archive') })
      await later(wd, 100)
      expect(wd.settled).toEqual([])
    })
  }

  test('a failure toasts the error text', async ($, on) => {
    const err = { error: { code: 'E_NOT_FOUND', message: 'note x has no active hold', detail: { id: 'x' } } }
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Release'], settleOut: { exitCode: 1, stdout: '', stderr: JSON.stringify(err, null, 2) } })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    await ui.press({ key: KEY('release') })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
    expect(wd.toasts.at(-1)).toBe('belay: the note was not settled (exit 1): E_NOT_FOUND: note x has no active hold')
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

describe('the outcome of a write that may have committed is unknown, never "not settled"', () => {
  const lost = [
    ['E_TIMEOUT', { error: { code: 'E_TIMEOUT', message: 'no answer' } }],
    ['E_OWNER_LOST', { error: { code: 'E_OWNER_LOST', message: 'owner went away', detail: { sent: true } } }],
  ] as const
  for (const [code, body] of lost) {
    test(`${code} toasts that the outcome is unknown`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive'], settleOut: { exitCode: 1, stdout: '', stderr: JSON.stringify(body, null, 2) } })
      await openPane($, wd)
      const { ui } = await pane($)
      await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
      await ui.press({ key: KEY('archive') })
      await later(wd, 100)
      expect(wd.toasts.at(-1)).toBe(`belay: outcome unknown: re-read with belay memory held (${code})`)
    })
  }
  test('a rejection of the process call (the 40 s timeout) toasts that the outcome is unknown', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive'], settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    await ui.press({ key: KEY('archive') })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
    expect(wd.toasts.at(-1)).toBe('belay: outcome unknown: re-read with belay memory held')
  })
})

describe('what is checked around the dialogs', () => {
  test('a second press on the same note while its dialog is open starts no second dialog', async ($, on) => {
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive', 'again', 'Archive'], onAsk: n => (n === 1 ? gate : undefined) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    const first = ui.press({ key: KEY('archive') })
    await later(wd, 50)
    const second = ui.press({ key: KEY('release') })
    await later(wd, 50)
    expect(wd.asked.length).toBe(1)
    open()
    await Promise.all([first, second])
    await later(wd, 100)
    expect(wd.asked.length).toBe(2)
    expect(wd.settled.length).toBe(1)
  })

  test('a note that stopped awaiting while the dialogs were open is not settled', async ($, on) => {
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive'], onAsk: n => (n === 2 ? gate : undefined) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    const pressed = ui.press({ key: KEY('archive') })
    await later(wd, 100)
    expect(wd.asked.length).toBe(2) // the confirm is up
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000) // the panel reads belay again meanwhile
    open()
    await pressed
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.at(-1)).toBe('belay: note 08954ec7 no longer awaits you, so it was not settled.')
  })

  test('a watch changed while the dialogs were open is not settled against', async ($, on) => {
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive'], onAsk: n => (n === 2 ? gate : undefined) })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    const pressed = ui.press({ key: KEY('archive') })
    await later(wd, 100)
    await cmd($, 'belay', 'watch r-other')
    open()
    await pressed
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.at(-1)).toBe('belay: the watched run changed while you were answering, so the note was not settled.')
  })

  for (const [field, value] of [['data_dir', 'C:/e/.belay'], ['belay_cli', 'C:/y/belay.cjs'], ['node', 'C:/m/node.exe']] as const) {
    test(`a bound run whose ${field} changed while the dialogs were open is not settled against`, async ($, on) => {
      let open!: () => void
      const gate = new Promise<void>(r => { open = r })
      const wd = await boot($, on, { file: true, notices: waiting, answers: ['because', 'Archive'], onAsk: n => (n === 2 ? gate : undefined) })
      await openPane($, wd)
      const { ui } = await pane($)
      await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
      const pressed = ui.press({ key: KEY('archive') })
      await later(wd, 100)
      expect(wd.asked.length).toBe(2)
      wd.w.runFile = { ...FULL_RUNFILE, [field]: value } // the same run, bound to another store, CLI or node
      await $.session.start(START)
      open()
      await pressed
      await later(wd, 100)
      expect(wd.settled).toEqual([])
      expect(wd.toasts.at(-1)).toBe('belay: the watched run changed while you were answering, so the note was not settled.')
    })
  }

  test('a press on a note the snapshot no longer lists asks nothing', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, answers: ['because', 'Archive'] })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000)
    await ui.press({ key: KEY('archive') }).catch(() => undefined)
    await later(wd, 100)
    expect(wd.asked).toEqual([])
    expect(wd.settled).toEqual([])
  })

  test('a reason over 160 characters is refused with a toast, before the confirm', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, answers: ['x'.repeat(161), 'Archive'] })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    await ui.press({ key: KEY('archive') })
    await later(wd, 100)
    expect(wd.asked.length).toBe(1)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.at(-1)).toContain('161 characters; at most 160')
  })

  test('a reason of exactly 160 characters is sent whole and shown whole in the confirm', async ($, on) => {
    const reason = `a  b "c" ${'z'.repeat(160)}`.slice(0, 160)
    const wd = await boot($, on, { notices: waiting, answers: [reason, 'Archive'] })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
    await ui.press({ key: KEY('archive') })
    await later(wd, 100)
    expect(wd.asked[1]).toBe(`Archive note 08954ec7 "pid poll note"? reason: ${reason}`)
    expect(wd.settled[0]!.includes(reason)).toBe(true)
  })

  for (const flag of ['--json', '--fix', '--data', '--help', '-h']) {
    test(`a reason that is exactly ${flag} is refused with a toast`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting, answers: [flag, 'Archive'] })
      await openPane($, wd)
      const { ui } = await pane($)
      await ui.press({ key: OPEN }) // a note's buttons are drawn once its line is open
      await ui.press({ key: KEY('archive') })
      await later(wd, 100)
      expect(wd.settled).toEqual([])
      expect(wd.asked.length).toBe(1)
      expect(wd.toasts.at(-1)).toContain(`a reason cannot be exactly ${flag}`)
    })
  }
})

describe('the held line keeps what the operator must act on', () => {
  for (const cols of [30, 40, 50, 72]) {
    test(`the awaits count survives a ${cols}-column pane (the line wraps, it is not cut)`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { text } = await pane($, 'terminal', cols)
      expect(text).toMatch(/MEMORY {2}1 held · 1 awaits you(?!\.|…)/) // the whole clause, in the heading, whole at every width
    })
  }
})
