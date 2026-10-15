import { describe, expect, test } from 'claude-code/testing'
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
