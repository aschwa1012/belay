import { describe, expect, test } from 'claude-code/testing'
import { T0, RUN, NOTE_ID, FULL_RUNFILE, START, boot, cmd, later, pane, openPane, words, leaves, band } from './support'

// The settle flow inside the pane (the interactive orchestrator has no AskUserQuestion, so there is no dialog): a settle button of the open
// note shows a reason Input, Enter shows the exact reason with a confirm button, and only that button runs `belay memory held settle`.
// The reason is one argv element.
const held = { kind: 'notes_held', ts: T0, run_id: RUN, count: 1, unsupported: 0, by_project: { acme: 1 }, by_ground: { reported: 1 }, awaiting_operator: 1, oldest_age_runs: 0, command: 'belay memory review' }
const notices = (...events: unknown[]) => ({ run_id: RUN, events })
const waiting = notices(held)
const KEY = (a: string) => `${a}-${NOTE_ID}`
const OPEN = `note:${NOTE_ID}`
const INPUT = `reason:${NOTE_ID}`
const COMMIT = `commit:${NOTE_ID}`
const CANCEL = `cancel:${NOTE_ID}`
const flat = (s: string) => s.replace(/\s+/g, ' ')
// The outcome words belay prints (archived, released, still_unsupported, reoffered), not the verb with a d.
const OUT: Record<string, string> = { archive: 'archived', release: 'released', reoffer: 'reoffered' }
const ok = (action: string, outcome = OUT[action]!) => ({ exitCode: 0, stdout: JSON.stringify({ id: NOTE_ID, action, outcome, receipt: 'held-settle:abc@1' }), stderr: '' })

// open the note, press the action, type the reason in the Input and press Enter: the confirm stage
async function toConfirm(ui: any, action: string, reason: string) {
  await ui.press({ key: OPEN })
  await ui.press({ key: KEY(action) })
  await ui.input({ key: INPUT, text: reason })
}
const drawnWords = async (ui: any) => flat(leaves(await ui.drawn()).join(' '))

describe('the settle buttons', () => {
  test('a note that awaits the operator gets archive, release and reoffer once open; a held note that does not gets none', async ($, on) => {
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
      const wd = await boot($, on, { notices: waiting, settleOut: ok(action) })
      await openPane($, wd)
      const { ui } = await pane($)
      await toConfirm(ui, action, reason)
      expect(await drawnWords(ui)).toContain(flat(`${action[0]!.toUpperCase()}${action.slice(1)} "pid poll note" (08954ec7)? reason: ${reason}`))
      expect(wd.settled).toEqual([]) // nothing has run yet
      await ui.press({ key: COMMIT })
      await later(wd, 100)
      expect(wd.settled.length).toBe(1)
      const argv = wd.settled[0]!
      const tail = argv.slice(argv.indexOf('memory'))
      expect(tail.slice(0, 9)).toEqual(['memory', 'held', 'settle', NOTE_ID, `--${action}`, '--reason', reason, '--if-awaiting', '--json'])
      expect(wd.toasts.at(-1)).toBe(`belay: ${action} 08954ec7: ${OUT[action]} · receipt held-settle:abc@1`)
      expect(wd.asked).toEqual([]) // the session has no AskUserQuestion: nothing asks
      await expect(ui.press({ key: COMMIT })).rejects.toThrow() // consumed: a second press finds nothing
      expect(wd.settled.length).toBe(1)
    })
  }

  test('typing and Enter in the reason Input, and every button before the confirm, run no process at all', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    const ran = wd.ran.length
    await ui.press({ key: KEY('archive') })
    await ui.input({ key: INPUT, text: 'because', kind: 'change' })
    await ui.input({ key: INPUT, text: 'because' })
    await wd.clock.settle()
    expect(wd.ran.length).toBe(ran)
    expect(wd.settled).toEqual([])
    expect(wd.spawned).toEqual([])
    expect(wd.writes).toEqual([])
  })

  test('cancel at the reason stage runs nothing and takes the Input away', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    await ui.press({ key: KEY('archive') })
    await ui.press({ key: CANCEL })
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    expect(words(await ui.drawn())).toContain('▸ archive') // the three buttons are back
    await expect(ui.input({ key: INPUT, text: 'x' })).rejects.toThrow()
  })

  test('cancel at the confirm stage runs nothing and a later confirm press is impossible', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: CANCEL })
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    await expect(ui.press({ key: COMMIT })).rejects.toThrow()
  })

  test('the confirm button is not there at the reason stage, and the Input is not there at the confirm stage', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    await ui.press({ key: KEY('archive') })
    await expect(ui.press({ key: COMMIT })).rejects.toThrow()
    await ui.input({ key: INPUT, text: 'because' })
    await expect(ui.input({ key: INPUT, text: 'again' })).rejects.toThrow()
  })

  test('a settle button cancels a pending review confirm', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    await ui.press({ key: 'review' }) // asks
    await ui.press({ key: KEY('archive') }) // any other press cancels
    await ui.press({ key: 'review' }) // so this asks again, it does not dispatch
    await later(wd, 100)
    expect(wd.spawned).toEqual([])
  })

  test('a failure toasts the error text', async ($, on) => {
    const err = { error: { code: 'E_NOT_FOUND', message: 'note x has no active hold', detail: { id: 'x' } } }
    const wd = await boot($, on, { notices: waiting, settleOut: { exitCode: 1, stdout: '', stderr: JSON.stringify(err, null, 2) } })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'release', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
    expect(wd.toasts.at(-1)).toBe('belay: the note was not settled (exit 1): E_NOT_FOUND: note x has no active hold')
  })

  test('nothing but the confirm button runs the write: opening, ticking and the review button do not', async ($, on) => {
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
      const wd = await boot($, on, { notices: waiting, settleOut: { exitCode: 1, stdout: '', stderr: JSON.stringify(body, null, 2) } })
      await openPane($, wd)
      const { ui } = await pane($)
      await toConfirm(ui, 'archive', 'because')
      await ui.press({ key: COMMIT })
      await later(wd, 100)
      expect(wd.toasts.at(-1)).toBe(`belay: outcome unknown: re-read with belay memory held (${code})`)
    })
  }
  test('a rejection of the process call (the 40 s timeout) toasts that the outcome is unknown', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
    expect(wd.toasts.at(-1)).toBe('belay: outcome unknown: re-read with belay memory held')
  })
})

describe('what is checked around the flow', () => {
  test('a note that stopped awaiting while the confirm was up is cleared with a toast and not settled', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000) // the panel reads belay again meanwhile
    expect(wd.settled).toEqual([])
    expect(wd.toasts.at(-1)).toBe('belay: note 08954ec7 no longer awaits you, so the settle was cleared.')
    await expect(ui.press({ key: COMMIT })).rejects.toThrow()
  })

  test('a watch changed mid-flow clears the pending settle with a toast and settles nothing', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await cmd($, 'belay', 'watch r-other')
    await later(wd, 6000)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.some(t => t === 'belay: the watched run changed, so the settle was cleared.')).toBe(true)
    await expect(ui.press({ key: COMMIT })).rejects.toThrow()
  })

  for (const [field, value] of [['data_dir', 'C:/e/.belay'], ['belay_cli', 'C:/y/belay.cjs'], ['node', 'C:/m/node.exe']] as const) {
    test(`a bound run whose ${field} changed mid-flow settles nothing`, async ($, on) => {
      const wd = await boot($, on, { file: true, notices: waiting })
      await openPane($, wd)
      const { ui } = await pane($)
      await toConfirm(ui, 'archive', 'because')
      wd.w.runFile = { ...FULL_RUNFILE, [field]: value } // the same run, bound to another store, CLI or node
      await $.session.start(START)
      await later(wd, 6000)
      expect(wd.settled).toEqual([])
      expect(wd.toasts.some(t => t === 'belay: the watched run changed, so the settle was cleared.')).toBe(true)
    })
  }

  test('a press on a note the snapshot no longer lists settles nothing', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000)
    await ui.press({ key: KEY('archive') }).catch(() => undefined)
    await later(wd, 100)
    expect(wd.settled).toEqual([])
  })

  test('a reason over 160 characters is refused with a toast and the Input stays', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'x'.repeat(161))
    expect(wd.settled).toEqual([])
    expect(wd.toasts.at(-1)).toContain('161 characters; at most 160')
    await ui.input({ key: INPUT, text: 'a good reason' }) // still there
    await ui.press({ key: COMMIT })
    await later(wd, 100)
    expect(wd.settled.length).toBe(1)
  })

  test('a reason of exactly 160 characters is sent whole and shown whole in the confirm', async ($, on) => {
    const reason = `a  b "c" ${'z'.repeat(160)}`.slice(0, 160)
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 200)
    await toConfirm(ui, 'archive', reason)
    expect(await drawnWords(ui)).toContain(flat(`Archive "pid poll note" (08954ec7)? reason: ${reason}`))
    await ui.press({ key: COMMIT })
    await later(wd, 100)
    expect(wd.settled[0]!.includes(reason)).toBe(true)
  })

  for (const [name, text] of [['blank', '   '], ['empty', '']] as const) {
    test(`a ${name} reason is refused with a toast and the Input stays`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { ui } = await pane($)
      await toConfirm(ui, 'archive', text)
      expect(wd.toasts.at(-1)).toBe('belay: type a reason first, or press cancel.')
      await ui.input({ key: INPUT, text: 'ok now' })
    })
  }

  for (const flag of ['--json', '--fix', '--data', '--help', '-h']) {
    test(`a reason that is exactly ${flag} is refused with a toast and the Input stays`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { ui } = await pane($)
      await toConfirm(ui, 'archive', flag)
      expect(wd.settled).toEqual([])
      expect(wd.toasts.at(-1)).toContain(`a reason cannot be exactly ${flag}`)
      await ui.input({ key: INPUT, text: `${flag} and a word` }) // still asking
    })
  }

  test('a reason with leading dashes, quotes and spaces is one argv element', async ($, on) => {
    const reason = `--archive "it's" -x  and  more`
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'release', reason)
    await ui.press({ key: COMMIT })
    await later(wd, 100)
    const argv = wd.settled[0]!
    expect(argv[argv.indexOf('--reason') + 1]).toBe(reason)
    expect(argv.filter(a => a === '--archive').length).toBe(0)
  })
})

describe('the held line keeps what the operator must act on', () => {
  for (const cols of [30, 40, 50, 72]) {
    test(`the awaits count survives a ${cols}-column pane (the line wraps, it is not cut)`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { text } = await pane($, 'terminal', cols)
      expect(text).toMatch(/NOTES {2}1 held · 1 awaits you(?!\.|…)/) // the whole clause, in the heading, whole at every width
    })
  }
})

describe('the pending stages wrap on a narrow pane', () => {
  const LONG = 'a reason that is long enough to need more than one line on a narrow pane'
  for (const cols of [30, 40, 72]) {
    test(`the Input stage and the confirm stage are whole at ${cols} columns`, async ($, on) => {
      const wd = await boot($, on, { notices: waiting })
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      await ui.press({ key: OPEN })
      await ui.press({ key: KEY('archive') })
      expect(leaves(await ui.drawn())).toContain('▸ cancel')
      await ui.input({ key: INPUT, text: LONG })
      const text = await drawnWords(ui)
      expect(text).toContain(flat(LONG)) // every word of the reason
      expect(text).toContain('(08954ec7)?')
      const rows = leaves(await ui.drawn())
      expect(rows).toContain('  ▸ archive it')
      expect(rows).toContain('  ▸ cancel')
    })
  }
})

describe('the keyboard goes to the reason Input', () => {
  // The docked pane is asked for the keys once (ui.open with focus puts the ring on the autoFocus Input). A second $.ui.focus on it is denied as
  // redundant, so none is made, and no refusal ever toasts: the dim hint line is the signal.
  test('starting a settle asks the docked pane for the keys once and toasts nothing about focus', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    const before = wd.openArgs.length
    await ui.press({ key: KEY('archive') })
    await later(wd, 50)
    expect(wd.openArgs.slice(before).filter(a => a.id === 'belay' && a.focus === true).length).toBe(1)
    expect(wd.toasts.some(t => t.includes('ctrl+x') || t.includes('keys'))).toBe(false)
  })

  test('the hint is drawn while the pane is not focused, and gone once it is', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 200, false)
    await ui.press({ key: OPEN })
    await ui.press({ key: KEY('archive') })
    expect(await drawnWords(ui)).toContain('press ctrl+x tab to type the reason (Esc gives the keys back)')
  })
  test('no hint when the pane has the keys', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', 200, true)
    await ui.press({ key: OPEN })
    await ui.press({ key: KEY('archive') })
    expect(await drawnWords(ui)).not.toContain('ctrl+x tab')
  })

  test('the commit button never takes the focus on its own, and the Input is not re-seeded by a redraw', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: OPEN })
    await ui.press({ key: KEY('archive') })
    await later(wd, 6000) // several redraws and reads
    const tree = JSON.stringify(await ui.drawn())
    await ui.input({ key: INPUT, text: 'because' })
    expect(JSON.stringify(await ui.drawn())).not.toContain('autoFocus') // at the confirm stage nothing asks for the focus: two Enters never commit
    expect(tree).not.toContain('autoFocus":true,"label":"  ▸')
    const input = tree.slice(tree.indexOf(INPUT) - 80, tree.indexOf(INPUT) + 400)
    expect(input).not.toContain('"value"') // no value prop: the person's typing stands between redraws
  })
})

describe('the rechecks inside the write are real, not just hidden by the UI', () => {
  // The confirm press is held at its consuming write; the world changes; the write goes on. Only the rechecks inside settlePress stand between
  // that and the command.
  test('a watch that changes between the confirm press and the write settles nothing', async ($, on) => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const wd = await boot($, on, { notices: waiting, settleGate: gate })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    const pressed = ui.press({ key: COMMIT })
    await later(wd, 50)
    await cmd($, 'belay', 'watch r-other')
    release()
    await pressed
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.some(t => t === 'belay: the watched run changed since you started, so the note was not settled.')).toBe(true)
  })
  test('a note that leaves the list between the confirm press and the write settles nothing', async ($, on) => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const wd = await boot($, on, { notices: waiting, settleGate: gate })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    const pressed = ui.press({ key: COMMIT })
    await later(wd, 50)
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000) // the panel reads belay again meanwhile
    release()
    await pressed
    await later(wd, 100)
    expect(wd.settled).toEqual([])
    expect(wd.toasts.some(t => t === 'belay: note 08954ec7 no longer awaits you, so it was not settled.')).toBe(true)
  })
})

describe('a pending settle is dropped when the panel closes or the run changes', () => {
  test('closing the panel drops it', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: 'close' })
    await later(wd, 100)
    await cmd($, 'orch') // reopen
    await later(wd, 2000)
    expect(leaves(await ui.drawn())).not.toContain('  ▸ archive it') // the confirm stage did not survive the close (the note is still open)
    expect(wd.settled).toEqual([])
  })
  test('toggling the panel off and on drops it', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    const b = await band($)
    await b.ui.press({ key: 'open' }) // the band's toggle button closes the panel
    await later(wd, 100)
    await cmd($, 'orch') // and the command opens it again
    await later(wd, 2000)
    expect(leaves(await ui.drawn())).not.toContain('  ▸ archive it')
  })
  test('the /orch command closing the panel drops it', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await cmd($, 'orch') // closes the panel
    await later(wd, 100)
    await cmd($, 'orch') // and opens it again
    await later(wd, 2000)
    expect(leaves(await ui.drawn())).not.toContain('  ▸ archive it')
  })
  test('a watch change drops it at once, with a toast', async ($, on) => {
    const wd = await boot($, on, { notices: waiting })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await cmd($, 'belay', 'watch r-other')
    expect(wd.toasts.some(t => t === 'belay: the watched run changed, so the settle was cleared.')).toBe(true)
    expect(wd.settled).toEqual([])
  })
})

describe('a settled note is hidden and refused until a read taken after the settle', () => {
  test('after a settle the row shows what happened, its buttons are gone, and no second settle can start', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleOut: ok('reoffer') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'reoffer', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 20) // not long enough for another read
    expect(wd.settled.length).toBe(1)
    expect(await drawnWords(ui)).toContain('settled: reoffered')
    await expect(ui.press({ key: KEY('archive') })).rejects.toThrow() // the buttons are gone
    expect(wd.settled.length).toBe(1)
  })
  test('an unknown outcome and a refusal hide the row too, with their own words', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 20)
    expect(await drawnWords(ui)).toContain('outcome unknown')
    await expect(ui.press({ key: KEY('release') })).rejects.toThrow()
  })
  test('a failed settle says "not settled" and hides the row', async ($, on) => {
    const err = { error: { code: 'E_NOT_FOUND', message: 'note x has no active hold', detail: { id: 'x' } } }
    const wd = await boot($, on, { notices: waiting, settleOut: { exitCode: 1, stdout: '', stderr: JSON.stringify(err) } })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 20)
    expect(await drawnWords(ui)).toContain('not settled')
    await expect(ui.press({ key: KEY('release') })).rejects.toThrow()
  })
  test('once a newer read still lists the note (it was reoffered) the buttons come back', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleOut: ok('reoffer') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'reoffer', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 6000) // a fresh read follows, taken after the settle, and lists it again
    expect(await drawnWords(ui)).not.toContain('settled: reoffered')
    expect(words(await ui.drawn())).toContain('▸ archive')
  })
  test('once a newer read no longer lists the note the row is gone', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleOut: ok('archive') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000)
    expect(await drawnWords(ui)).not.toContain('08954ec7')
  })
  test('a second settle on the same note within the stale window is refused even if it is started by hand', async ($, on) => {
    // The first settle is held at the write; the note's buttons are still drawn. A second action cannot start before the first has finished.
    const wd = await boot($, on, { notices: waiting, settleOut: ok('reoffer') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'reoffer', 'one')
    await ui.press({ key: COMMIT })
    await later(wd, 20)
    await ui.press({ key: OPEN }).catch(() => undefined) // closing and opening again does not bring the buttons back
    await ui.press({ key: OPEN }).catch(() => undefined)
    await expect(ui.press({ key: KEY('archive') })).rejects.toThrow()
    expect(wd.settled.length).toBe(1)
  })
})

describe('an unknown outcome keeps the row refused', () => {
  test('a later read that still lists the note does not bring the buttons back; re-check does', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 6000) // reads follow, taken after the settle, and still list the note
    expect(await drawnWords(ui)).toContain('outcome unknown')
    await expect(ui.press({ key: KEY('release') })).rejects.toThrow()
    await ui.press({ key: 'recheck:' + NOTE_ID }) // the operator has looked (belay memory held)
    // not opened at once: stamped now, it waits for a read started after it, and an immediate settle is impossible
    expect(await drawnWords(ui)).toContain('re-checking')
    await expect(ui.press({ key: KEY('release') })).rejects.toThrow()
    expect(wd.settled.length).toBe(1)
    await later(wd, 6000) // a read taken after the re-check follows and still lists the note
    expect(words(await ui.drawn())).toContain('▸ archive')
  })
  test('it clears by itself once a fresh read no longer lists the note', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    wd.w.notices = notices({ ...held, awaiting_operator: 0 })
    await later(wd, 6000)
    expect(await drawnWords(ui)).not.toContain('08954ec7')
  })
  test('the entry exists while the process is still running (a reload mid-settle cannot start a second one)', async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>(r => { release = r })
    const wd = await boot($, on, { notices: waiting, settleHold: hold, settleOut: ok('archive') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    const pressed = ui.press({ key: COMMIT })
    await later(wd, 50) // the process is in flight
    expect(await drawnWords(ui)).toContain('settling…')
    expect(leaves(await ui.drawn()).some(l => l.includes('re-check'))).toBe(false) // no re-check while it runs
    await expect(ui.press({ key: 'recheck:' + NOTE_ID })).rejects.toThrow()
    await expect(ui.press({ key: KEY('release') })).rejects.toThrow()
    release()
    await pressed
    await later(wd, 50)
    expect(await drawnWords(ui)).toContain('settled: archived') // stamped with the real outcome after the process returns
    expect(wd.settled.length).toBe(1)
  })
})

describe('the hint on the inline band', () => {
  test('a pending reason shows the hint while focus was not confirmed moved', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, mod: { pane: 'above-prompt' } })
    await openPane($, wd)
    const b = await band($, 'terminal', 100)
    await b.ui.press({ key: OPEN })
    await b.ui.press({ key: KEY('archive') })
    await later(wd, 50) // the kit cannot move a ring: the inline focus is not confirmed
    expect(flat(words(await b.ui.drawn()))).toContain('press ctrl+x tab to type the reason')
  })
})

describe('re-check is careful', () => {
  test('a settle dropped by a reload (pending past the launcher bound) reads as unknown and can be re-checked', async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>(r => { release = r })
    const wd = await boot($, on, { notices: waiting, settleHold: hold, settleOut: ok('archive') })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    const pressed = ui.press({ key: COMMIT })
    await later(wd, 50000) // the process never answers within the bound
    expect(await drawnWords(ui)).toContain('outcome unknown')
    expect(leaves(await ui.drawn()).some(l => l.includes('re-check'))).toBe(true)
    release()
    await pressed
    await later(wd, 200)
  })
  test('pressing re-check makes the next read come at once (it resets the fetch clock)', async ($, on) => {
    const wd = await boot($, on, { notices: waiting, settleReject: 'timed out' })
    await openPane($, wd)
    const { ui } = await pane($)
    await toConfirm(ui, 'archive', 'because')
    await ui.press({ key: COMMIT })
    await later(wd, 1500) // the read the settle itself asked for has been made
    const before = wd.ran.length
    await ui.press({ key: 'recheck:' + NOTE_ID })
    await later(wd, 1100) // the pane's usual period is 4 s: only a reset brings a read this soon
    expect(wd.ran.length).toBeGreaterThan(before)
  })
})
