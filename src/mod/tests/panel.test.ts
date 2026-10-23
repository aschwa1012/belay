import { describe, expect, test } from 'claude-code/testing'
import { TASK4, T0, RUN, iso, AGENTS, FOOTER, EVENTS, NOTICES, TRANSCRIPT, DEFAULTS, SETTINGS, FULL_RUNFILE, world, START, BAND_PROPS, PANE_PROPS, PRES, cmd, colours, words, boot, later, band, pane, openPane, READ_VERBS, type World } from './support'

describe('activation and reading', () => {
  test('belay-run.json binds the run: [node, belay_cli] exactly, and only read commands run', async ($, on) => {
    const wd = await boot($, on, { file: true })
    const verbs = wd.ran.map(a => a.find(x => READ_VERBS.includes(x)))
    expect(verbs).toContain('agents')
    expect(verbs).toContain('notices')
    const first = wd.ran[0]!
    expect(first.slice(0, 2)).toEqual(['C:/n/node.exe', 'C:/x/belay.cjs'])
    expect(first).toContain('--json')
    expect(first).toContain(RUN)
    expect(first).toContain('C:/d/.belay')
    expect(wd.commands).toContain('orch')
    expect(wd.commands).not.toContain('belay')
    expect(wd.writes).toEqual([])
  })
  test('belay-run.json naming orchestrator_dir passes it to the agents read as --dir, and only to agents', async ($, on) => {
    const wd = await boot($, on, { file: true, runFile: { ...FULL_RUNFILE, orchestrator_dir: 'C:/o/orch-dir/ops' } })
    const agents = wd.ran.filter(a => a.includes('agents'))
    expect(agents.length).toBeGreaterThan(0)
    for (const a of agents) {
      const i = a.indexOf('--dir')
      expect(i).toBeGreaterThan(-1)
      expect(a[i + 1]).toBe('C:/o/orch-dir/ops')
      expect(a.indexOf(RUN)).toBeLessThan(i)
    }
    expect(wd.ran.filter(a => !a.includes('agents')).every(a => !a.includes('--dir'))).toBe(true)
  })
  test('without orchestrator_dir in belay-run.json the agents read carries no --dir', async ($, on) => {
    const wd = await boot($, on, { file: true })
    expect(wd.ran.filter(a => a.includes('agents')).every(a => !a.includes('--dir'))).toBe(true)
  })
  for (const [name, runFile, message] of [
    ['lacks node', { ...FULL_RUNFILE, node: undefined }, 'belay-run.json lacks node'],
    ['lacks belay_cli', { ...FULL_RUNFILE, belay_cli: undefined }, 'belay-run.json lacks belay_cli'],
    ['lacks data_dir', { ...FULL_RUNFILE, data_dir: undefined }, 'belay-run.json lacks data_dir'],
    ['lacks run_id and role', { ...FULL_RUNFILE, run_id: undefined, role: undefined }, 'belay-run.json lacks role/run_id'],
    ['is not JSON', '{nope', 'belay-run.json is not valid JSON'],
    ['has a role other than orchestrator', { ...FULL_RUNFILE, role: 'coder' }, 'belay-run.json role must be "orchestrator"'],
  ] as const) {
    test(`a belay-run.json that ${name} is an error state: shown in the band, nothing runs, no fallback, no /belay`, async ($, on) => {
      const wd = await boot($, on, { file: true, runFile, repoCli: true })
      await later(wd, 6000)
      expect(wd.ran).toEqual([])
      expect(wd.commands).toEqual([])
      expect((await band($)).text).toContain(message)
    })
  }
  test('without the file, the repo-relative CLI is used when the plugin can find it', async ($, on) => {
    const wd = await boot($, on, { repoCli: true })
    expect(wd.ran[0]![0]).toBe('node')
    expect((wd.ran[0]![1] ?? '').endsWith('src/cli/belay.cjs')).toBe(true)
    expect(wd.ran[0]).not.toContain('C:/n/node.exe')
  })
  test('without the file and without the repo CLI: PATH belay, or on a Windows path an error naming the fix', async ($, on) => {
    const wd = await boot($, on, { repoCli: false })
    const t = (await band($)).text
    if (wd.ran.length === 0) expect(t).toContain('belay CLI not found: on Windows set belay_cli and node in belay-run.json')
    else expect(wd.ran[0]!.slice(0, 2)).toEqual(['belay', 'agents'])
  })
  test('/belay watch binds a run, /belay watch -f is refused, /belay unwatch ends it, and no command answers with text', async ($, on) => {
    const wd = world(on, {})
    await $.session.start(START)
    expect(wd.commands).toContain('belay')
    const refused = await cmd($, 'belay', 'watch -f')
    expect(refused.text ?? '').toBe('')
    expect(wd.toasts.at(-1)).toMatch(/usage/)
    await later(wd, 6000)
    expect(wd.ran).toEqual([])
    const ok = await cmd($, 'belay', 'watch r-9')
    expect(ok.text ?? '').toBe('')
    expect(wd.toasts.at(-1)).toMatch(/watching r-9/)
    await later(wd, 1000)
    expect(wd.ran[0]).toContain('r-9')
    expect(((await cmd($, 'orch')).text ?? '')).toBe('')
    await cmd($, 'belay', 'unwatch')
    expect(wd.toasts.at(-1)).toMatch(/no longer watching/)
    expect(wd.writes).toEqual([])
  })
  test('/belay watch with no id reads the newest run once, then pins that id', async ($, on) => {
    const wd = await boot($, on, { watchId: '' })
    expect(wd.ran[0]).not.toContain(RUN)
    expect((await band($)).text).toContain(`belay ${RUN}`)
    await later(wd, 5000)
    const second = wd.ran.filter(a => a.includes('agents'))[1]!
    expect(second).toContain(RUN)
  })
  test('with no store or no runs, the band says so plainly', async ($, on) => {
    await boot($, on, { watchId: '', noRun: true })
    expect((await band($)).text).toContain('no belay run found')
  })
  test('a failing command shows one dim line with its exit code and is not retried in the same round', async ($, on) => {
    const wd = await boot($, on, { failAgents: true })
    expect((await band($)).text).toContain(`belay agents ${RUN} exit 3`)
    expect(wd.ran.filter(a => a.includes('agents')).length).toBe(1)
  })
  test('a repeated session.start with an unchanged watch keeps the snapshot and the seen notices', async ($, on) => {
    const wd = await boot($, on, { file: true })
    await openPane($, wd)
    await $.session.start(START)
    const t = (await band($)).text
    expect(t).toContain('4 agents')
    expect(t).not.toContain('p-19')
  })
})
describe('the band', () => {
  test('the newest unseen notice wins even with a fetched transcript (mutant M2)', async ($, on) => {
    const wd = await boot($, on)
    expect(wd.ran.some(a => a.includes('transcript'))).toBe(true)
    const { text } = await band($)
    expect(text).toContain('belay r-7f3a')
    expect(text).toContain('4 agents · 4 busy')
    expect(text).toContain('$3.88')
    expect(text).toContain('▲ p-19 · coder-2 wants Bash')
    expect(text).not.toContain('orch ')
  })
  test('the collapsed band shows the orchestrator line, with its age, without the pane ever opening', async ($, on) => {
    const wd = await boot($, on, { notices: { run_id: RUN, events: [] } })
    expect(wd.opened).toEqual([])
    expect(wd.ran.some(a => a.includes('transcript'))).toBe(true)
    const { text } = await band($)
    expect(text).toMatch(/orch \d+s ago: Spawned rev-1 on t-5/)
    expect(text).not.toContain('(stale)')
  })
  test('the orchestrator line is marked stale after a failed transcript read', async ($, on) => {
    const wd = await boot($, on, { notices: { run_id: RUN, events: [] } })
    wd.w.transcriptFail = true
    await later(wd, 5000)
    const { text } = await band($)
    expect(text).toContain('(stale): Spawned rev-1')
    expect(text).toContain('belay transcript r-7f3a --tail 10 exit 4')
  })
  test('opening the pane marks the current notices seen, and notices that arrive while it is open', async ($, on) => {
    const wd = await boot($, on)
    expect((await band($)).text).toContain('p-19')
    await cmd($, 'orch') // opening is the person seeing them: seen at once, before any fetch
    expect((await band($)).text).not.toContain('p-19')
    await later(wd, 2000)
    let t = (await band($)).text
    expect(t).not.toContain('p-19')
    expect(t).toMatch(/orch \d+s ago/)
    wd.w.notices = { run_id: RUN, events: [...EVENTS, { kind: 'worker_dead', ts: T0 + 500, run_id: RUN, worker_id: 'test-1', exit_code: 1, death_established_by: 'process exit' }] }
    await later(wd, 4000)
    t = (await band($)).text
    expect(t).not.toContain('test-1 dead')
    const p = await pane($)
    const key = `notice:permission_pending|p-19|${T0 - 60000}`
    expect((await p.ui.find({ key }))?.props.dimColor).toBe(true)
  })
  test('a stopped worker is not a band notice and not in the unseen count; the pane lists it with a check mark', async ($, on) => {
    const wd = await boot($, on, { notices: { run_id: RUN, events: [EVENTS[1]] } })
    const t = (await band($)).text
    expect(t).not.toContain('stopped')
    expect(t).toMatch(/orch \d+s ago/)
    await openPane($, wd)
    expect((await pane($)).text).toMatch(/✓\s*\d\d:\d\d\s*coder-0 stopped/)
  })
  test('run state comes only from the current read: ended, dead, and stale after a failed read', async ($, on) => {
    const wd = await boot($, on)
    expect((await band($)).text).toContain('● running')
    wd.w.orchDisplay = 'done'
    await later(wd, 5000)
    expect((await band($)).text).toContain('● ended')
    wd.w.orchDisplay = 'dead'
    await later(wd, 5000)
    expect((await band($)).text).toContain('● dead')
    wd.w.failAgents = true
    await later(wd, 5000)
    const t = (await band($)).text
    expect(t).not.toContain('● dead')
    expect(t).not.toContain('● running')
    expect(t).toContain('stale: last read failed')
    expect(t).toContain('4 agents') // the old data is kept, marked stale
  })
  test('belay-run.json means the orchestrator has its own window: its words are never read', async ($, on) => {
    const wd = await boot($, on, { file: true, notices: { run_id: RUN, events: [] } })
    expect(wd.ran.some(a => a.includes('transcript'))).toBe(false)
    expect((await band($)).text).toContain('orchestrator is in its own window')
  })
  test('an unknown run mode shows one dim line and reads no transcript', async ($, on) => {
    const wd = await boot($, on, { mode: null, notices: { run_id: RUN, events: [] } })
    expect(wd.ran.some(a => a.includes('transcript'))).toBe(false)
    expect((await band($)).text).toContain('run mode unknown')
    await openPane($, wd)
    expect((await pane($)).text).toContain('run mode unknown')
  })
  test('a run whose mode belay reports as interactive hides the words as well', async ($, on) => {
    const wd = await boot($, on, { mode: 'interactive', notices: { run_id: RUN, events: [] } })
    expect(wd.ran.some(a => a.includes('transcript'))).toBe(false)
    expect((await band($)).text).toContain('orchestrator is in its own window')
  })
  test('mod.band one-line', async ($, on) => {
    await boot($, on, { mod: { band: 'one-line' } })
    expect((await band($)).text).toContain('│  ▲ p-19')
  })
  test('mod.band minimal keeps the run and a notice count only (a stopped worker is not counted)', async ($, on) => {
    await boot($, on, { mod: { band: 'minimal' } })
    const { text } = await band($)
    expect(text).toContain('belay r-7f3a')
    expect(text).toContain('▲3')
    expect(text).not.toContain('agents')
  })
})
describe('between fetches and across settings', () => {
  test('the cache countdown ticks locally between fetches', async ($, on) => {
    const wd = await boot($, on, { coder2Left: 60000 })
    await cmd($, 'orch')
    await later(wd, 1000) // the pane's first fetch lands on this tick
    const first = await pane($)
    expect(first.text).toMatch(/coder-2[^]*?1m/)
    await first.ui.unmount()
    const reads = wd.ran.length
    await later(wd, 900)
    expect(wd.ran.length).toBe(reads) // no new fetch yet
    expect((await pane($)).text).toMatch(/coder-2[^]*?59s/)
  })
  test('a settings change in the config file applies live, within one settings read', async ($, on) => {
    const wd = await boot($, on)
    expect((await band($)).text).toContain('4 agents · 4 busy  │  $3.88')
    wd.w.mod = { band: 'one-line' }
    await later(wd, 11000)
    expect((await band($)).text).toContain('$3.88 @')
    expect(wd.writes).toEqual([])
  })
  test('every colour is a theme key, never a fixed value', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const used = colours(await (await pane($)).ui.drawn())
    expect(used.length).toBeGreaterThan(5)
    for (const c of used) expect(c.startsWith('#')).toBe(false)
    for (const k of ['claude', 'warning', 'permission']) expect(used).toContain(k)
  })
})
describe('the pane', () => {
  test('the table: marks, tasks, bars, folded finished agents, no write', async ($, on) => {
    const wd = await boot($, on, { mod: { task: 'title' } })
    await openPane($, wd)
    const { ui, text } = await pane($)
    for (const s of ['orchestrator', 'coder-1', '◌', '▲', '◐', '●', '7c9e6679', '▰', '61%', '$0.92', '$ —', 'cold', '▸ 1 finished']) expect(text).toContain(s)
    expect(text.slice(0, text.indexOf('NOTICES'))).not.toContain('coder-0')
    await ui.press({ key: 'fold' })
    const open = words(await ui.drawn())
    expect(open.slice(0, open.indexOf('NOTICES'))).toContain('coder-0')
    expect(wd.writes).toEqual([])
    expect(wd.ran.every(a => a.some(x => READ_VERBS.includes(x)))).toBe(true)
  })
  test('a finished worker is marked ✓, never ○ (idle only)', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'fold' })
    expect(words(await ui.drawn())).toMatch(/✓\s*coder-0/)
  })
  test('without display_state the mark is unknown (?), never a running dot', async ($, on) => {
    const wd = await boot($, on, { noDisplay: true })
    await openPane($, wd)
    const t = (await pane($)).text
    const table = t.slice(t.indexOf('agent'), t.indexOf('NOTICES'))
    expect(table).toContain('?')
    expect(table).not.toContain('●')
    expect(table).not.toContain('◐')
  })
  test('selecting a row opens its details', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'agent:coder-1' })
    const t = words(await ui.drawn())
    expect(t).toContain('established by row state running, mid_turn, last event 340000 ms ago')
    expect(t).toContain('claude-sonnet-5-5 · effort medium')
    expect(t).toContain('TTL 1h00m, read from line uuid u2')
    expect(t).toContain('belay logs coder-1')
  })
  test('the ? button toggles the legend', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui, text } = await pane($)
    expect(text).not.toContain('LEGEND')
    await ui.press({ key: 'legend' })
    expect(words(await ui.drawn())).toContain('LEGEND  ? closes')
    await ui.press({ key: 'legend' })
    expect(words(await ui.drawn())).not.toContain('LEGEND  ? closes')
  })
  test('a headless run shows the orchestrator words and the real tool line', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const t = (await pane($)).text
    expect(t).toContain('Spawned rev-1 on t-5 against head 3e1de17.')
    expect(t).toContain('· 1 tool call')
    expect(t).not.toContain('worker_wait worker_id=rev-1')
  })
  test('interactive: no orchestrator words in the pane', async ($, on) => {
    const wd = await boot($, on, { file: true })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('Interactive: its words are already in its own window.')
    expect(text).not.toContain('Spawned rev-1')
  })
  test('mod.marks: words', async ($, on) => {
    const wd = await boot($, on, { mod: { marks: 'words' } })
    await openPane($, wd)
    const t = (await pane($)).text
    expect(t).toContain('[stal]')
    expect(t).toContain('[perm]')
    expect(t.slice(0, t.indexOf('NOTICES'))).not.toContain('◌')
  })
  test('mod.cache and mod.context change the drawing', async ($, on) => {
    const wd = await boot($, on, { mod: { cache: 'countdown', context: 'figure' } })
    await openPane($, wd)
    const t = (await pane($)).text
    expect(t).toContain('61%')
    expect(t.slice(t.indexOf('agent '), t.indexOf('NOTICES'))).not.toContain('▰')
    expect(t).toContain('9m') // coder-1: 599999 ms left
  })
  test('docked: /orch opens the pane, a person closing it ends the panel', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    expect(wd.opened).toEqual(['belay'])
    expect(wd.writes).toEqual([])
  })
  test('mod.pane above-prompt draws the panel in the band and opens no Pane', async ($, on) => {
    const wd = await boot($, on, { mod: { pane: 'above-prompt' } })
    await openPane($, wd)
    const { text } = await band($)
    expect(text).toContain('coder-1')
    expect(text).toContain('read-only · /orch toggles')
    expect(wd.opened).toEqual([])
  })
  test('a switch to docked never opens a pane from a timer: the panel stays inline until the person reopens it', async ($, on) => {
    const wd = await boot($, on, { mod: { pane: 'above-prompt' } })
    await openPane($, wd)
    wd.w.mod = { pane: 'docked' }
    await later(wd, 12000)
    expect(wd.opened).toEqual([])
    expect((await band($)).text).toContain('coder-1') // still drawn inline
    await cmd($, 'orch') // closes
    await cmd($, 'orch') // reopens: now it is the person's action
    expect(wd.opened).toEqual(['belay'])
  })
  test('a pane the surface cannot place leaves the panel drawn inline', async ($, on) => {
    const wd = await boot($, on, { noPlace: true })
    await openPane($, wd)
    expect(wd.opened).toEqual(['belay'])
    expect((await band($)).text).toContain('coder-1')
  })
  test('another surface gets the same facts as plain lines', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { text } = await pane($, 'desktop')
    expect(text).toContain('coder-1')
    expect(text).toContain('p-19')
    expect(wd.writes).toEqual([])
  })
})

describe('the agents shape of a8c466d', () => {
  test('elapsed time comes from started_at_ms, frozen at the end and at a pause', async ($, on) => {
    const wd = await boot($, on)
    expect((await band($)).text).toContain('● running 42m')
    wd.w.ended = T0 - 12 * 60000
    wd.w.orchDisplay = 'done'
    await later(wd, 5000)
    expect((await band($)).text).toContain('● ended 30m')
    wd.w.ended = undefined
    wd.w.orchDisplay = undefined
    wd.w.paused = T0 - 2 * 60000
    await later(wd, 5000)
    expect((await band($)).text).toMatch(/● (running|paused|dead) 40m/)
  })

  test('the tasks line has a bar and done/total; fix rounds show the limit only, never a used count', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const first = await pane($)
    let t = first.text
    await first.ui.unmount()
    expect(t).toMatch(/tasks ▰+▱+ 1\/3/)
    expect(t).toContain('fix rounds max 2')
    expect(t).not.toContain('used')
    wd.w.maxFix = null
    await later(wd, 4000)
    t = (await pane($)).text
    expect(t).not.toContain('fix rounds')
  })

  test('starting, stopping and unknown get the confirmed marks, all inactive, and the legend lists them', async ($, on) => {
    const wd = await boot($, on, { extra: ['starting', 'stopping', 'unknown'] })
    await openPane($, wd)
    const { ui, text } = await pane($)
    expect(text).toMatch(/●\s*w-starting/)
    expect(text).toMatch(/●\s*w-stopping/)
    expect(text).toMatch(/\?\s*w-unknown/)
    expect((await ui.find({ type: 'Text', text: '?' }))?.props.color).toBe('inactive')
    const dots = await ui.findAll({ type: 'Text', text: '●' })
    expect(dots.filter((d: any) => d.props.color === 'inactive').length).toBe(2) // starting and stopping
    await ui.press({ key: 'legend' })
    const lg = words(await ui.drawn())
    expect(lg).toContain('starting or stopping')
    expect(lg).toContain('state unknown')
  })

  test('details show the title with a dim (from spec), pid, permission mode and version; nulls are hidden', async ($, on) => {
    const wd = await boot($, on)
    await openPane($, wd)
    const { ui } = await pane($)
    await ui.press({ key: 'agent:coder-1' })
    const t = words(await ui.drawn())
    expect(t).toContain(`${TASK4} Fix the pid-poll null exit code (from spec)`)
    expect(t).toContain('pid 22016')
    expect(t).toContain('mode auto')
    expect(t).toContain('Claude Code 2.1.293')
    await ui.press({ key: 'agent:coder-1' })
    await ui.press({ key: 'agent:coder-2' })
    const full = words(await ui.drawn())
    const u = full.slice(full.indexOf('coder-2'), full.indexOf('NOTICES'))
    expect(u).toContain('launch')
    expect(u).not.toContain('Claude Code')
    expect(u).not.toContain('pid ')
    expect(u).not.toContain('mode auto')
  })

  test('an orchestrator whose display_state is unknown shows no run state; the transcript carries --tail 10 for the band', async ($, on) => {
    const wd = await boot($, on, { orchDisplay: 'unknown' })
    expect((await band($)).text).not.toContain('● running')
    const tr = wd.attempts.find(a => a.verb === 'transcript')!
    expect(tr.argv.slice(tr.argv.indexOf('--tail'), tr.argv.indexOf('--tail') + 2)).toEqual(['--tail', '10'])
  })
})

describe('the last review round', () => {
  test('a table task id is its first 8 characters; the full id is in the details', async ($, on) => {
    const wd = await boot($, on, { mod: { task: 'title' } })
    await openPane($, wd)
    const { ui, text } = await pane($)
    const table = text.slice(text.indexOf('agent '), text.indexOf('NOTICES'))
    expect(table).toContain('7c9e6679 Fix the pid-poll')
    expect(table).not.toContain(TASK4)
    await ui.press({ key: 'agent:coder-1' })
    expect(words(await ui.drawn())).toContain(TASK4)
  })

  test('with belay-run.json, settings run in the project root that holds data_dir; a watching session keeps its cwd', async ($, on) => {
    const wd = await boot($, on, { file: true })
    const own = (verb: string) => wd.attempts.filter(a => a.verb === verb).map(a => a.cwd)
    expect(own('settings')[0]).toBe('C:/d')
    expect(own('agents')[0]).toBeUndefined()
  })
  test('a data_dir that is not a .belay dir is itself the project root', async ($, on) => {
    const wd = await boot($, on, { file: true, runFile: { ...FULL_RUNFILE, data_dir: 'C:/proj/store' } })
    expect(wd.attempts.find(a => a.verb === 'settings')!.cwd).toBe('C:/proj/store')
  })
  test('a watching session runs settings in its own cwd', async ($, on) => {
    const wd = await boot($, on)
    expect(wd.attempts.find(a => a.verb === 'settings')!.cwd).toBeUndefined()
  })

  test('the elapsed time stops where the orchestrator was first read dead', async ($, on) => {
    const wd = await boot($, on, { startedAgo: 20000, orchDisplay: 'dead' })
    const first = (await band($)).text
    expect(first).toContain('● dead 21s')
    await later(wd, 30000)
    expect((await band($)).text).toContain('● dead 21s')
  })

  test('the pane reads with --tail 50, and a band tail with no words keeps the last words seen', async ($, on) => {
    const wd = await boot($, on, { toolsOnly: true, notices: { run_id: RUN, events: [] } })
    expect((await band($)).text).toContain('no orchestrator line yet') // the band tail holds tool calls only
    wd.w.toolsOnly = false
    await openPane($, wd)
    const pt = wd.attempts.filter(a => a.verb === 'transcript').at(-1)!
    expect(pt.argv.slice(pt.argv.indexOf('--tail'), pt.argv.indexOf('--tail') + 2)).toEqual(['--tail', '50'])
    expect((await pane($)).text).toContain('Spawned rev-1')
    await cmd($, 'orch') // closes; the band tail holds tool calls only again
    wd.w.toolsOnly = true
    await later(wd, 6000)
    expect((await band($)).text).toMatch(/orch \d+s ago.*Spawned rev-1/)
  })

  test('the band shows the newest words among its last 10 entries, even when the last five are tool calls (fails with a tail of 1)', async ($, on) => {
    const wd = await boot($, on, { longTranscript: true, honorTail: true, notices: { run_id: RUN, events: [] } })
    const tr = wd.attempts.find(a => a.verb === 'transcript')!
    expect(tr.argv).toContain('10')
    expect((await band($)).text).toContain("s ago: Reviewer 1 is done; creating the fix task.")
  })

  test('a kept line with no timestamp is labelled (kept, age unknown), never read as current', async ($, on) => {
    await boot($, on, { nullTs: true, notices: { run_id: RUN, events: [] } })
    const t = (await band($)).text
    expect(t).toContain('orch (kept, age unknown): Spawned rev-1')
    expect(t).not.toMatch(/orch \d+s ago/)
  })

  test('the pane shows the last 8 texts in full, with one collapsed "· N tool calls" line between them that opens on a press', async ($, on) => {
    const wd = await boot($, on, { manyTexts: true })
    await openPane($, wd)
    const { ui, text } = await pane($)
    const section = text.slice(text.indexOf('ORCHESTRATOR'))
    for (const i of [5, 6, 7, 8, 9, 10, 11, 12]) expect(section).toContain(`Step ${i} is under way.`)
    expect(section).not.toContain('Step 4 is under way.')
    expect(section).toContain('LAST WORD') // a long text is shown in full
    expect(section).toContain('· 3 tool calls')
    expect(section).toContain('· 1 tool call')
    expect(section).not.toContain('worker_wait')
    const groups = await ui.findAll({ type: 'Button', text: /tool call/ })
    await ui.press({ key: groups[0]!.key! })
    const open = words(await ui.drawn())
    expect(open).toContain('worker_wait worker_id=w-')
  })
})
