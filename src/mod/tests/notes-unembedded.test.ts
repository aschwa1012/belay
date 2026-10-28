import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { T0, RUN, boot, band, pane, openPane } from './support'

describe('notes stored without a vector', () => {
  test('are a notice that names the command that embeds them', async ($, on) => {
    const unembedded = { kind: 'notes_unembedded', ts: T0, run_id: RUN, count: 3, by_project: { acme: 3 }, command: 'belay memory embed' }
    const wd = await boot($, on, { notices: { run_id: RUN, events: [unembedded] } })
    expect((await band($)).text).toContain('3 notes unembedded')
    await openPane($, wd)
    expect((await pane($)).text).toContain('belay memory embed')
  })
})

describe('held rows the read filter cannot read', () => {
  test('are a notice that names the project they close and the command that lists them', async ($, on) => {
    const unreadable = { kind: 'holds_unreadable', ts: T0, run_id: RUN, count: 1, closed_projects: ['acme'], command: 'belay memory held' }
    const wd = await boot($, on, { notices: { run_id: RUN, events: [unreadable] } })
    expect((await band($)).text).toContain('1 held row unreadable')
    await openPane($, wd)
    const text = (await pane($)).text
    expect(text).toContain('every note of acme withheld')
    expect(text).toContain('belay memory held')
  })
})
