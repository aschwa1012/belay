import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { boot, pane, openPane, leaves, squeezed, RUN, T0, TASK4 } from './support'

// The docked pane is 72 columns and may be narrower. A single part longer than a line wraps under its label and
// an id the operator types is shown whole; nothing is cut that the operator would have to copy.
const REQ = 'toolu_01A09q90qw90lq917835lq9X' // a real-length request id, 30 characters
const TITLE = '修复 pid 轮询 🚀 👨‍👩‍👧 null'
const NOTICES = { run_id: RUN, events: [{ kind: 'permission_pending', ts: T0 - 60000, run_id: RUN, worker_id: 'coder-2', request_id: REQ, tool: 'Bash', age_ms: 60000 }] }

// Terminal cells, counted here independently of the panel: a grapheme with a wide script or a pictograph is 2.
const seg: (s: string) => string[] = (s) => (typeof (Intl as any).Segmenter === 'function' ? [...new (Intl as any).Segmenter().segment(s)].map((x: any) => x.segment) : [...s])
const cellsOf = (s: string): number => seg(s).reduce((n, g) => n + (/\p{Extended_Pictographic}|\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(g) ? 2 : 1), 0)

async function render(cols: number) {
  const wd = await boot($ref.$, $ref.on, { notices: NOTICES, coder1Title: TITLE })
  await openPane($ref.$, wd)
  const { ui } = await pane($ref.$, 'terminal', cols)
  await ui.press({ key: 'agent:coder-1' })
  return leaves(await ui.drawn())
}
const $ref: { $: any; on: any } = { $: null, on: null }

// No leaf is wider than the pane, and a detail value (the leaf after its 8-cell label) fits beside the label and
// the detail's own 2-cell indent, unless it is the whole flush line of an id.
function noneWide(rows: string[], cols: number) {
  rows.forEach((r, i) => {
    if (r.startsWith('Spawned rev-1')) return // the orchestrator's words are a wrapping Text: the host wraps it
    expect(cellsOf(r), r).toBeLessThanOrEqual(cols)
    if (r.length === 8 && /^\S+\s*$/.test(r) && rows[i + 1] !== undefined) {
      const v = rows[i + 1]!
      if (/^[a-z]+ *$/.test(r)) expect(cellsOf(v) + 10, v).toBeLessThanOrEqual(cols)
    }
  })
}

for (const cols of [72, 50, 40]) {
  describe(`wrap at ${cols} columns`, () => {
    test('ids are whole, the cache age and the CJK/emoji title are intact, nothing is too wide', async ($, on) => {
      $ref.$ = $; $ref.on = on
      const rows = await render(cols)
      const t = rows.join('\n')
      expect(t).toContain(TASK4) // the 36-character task uuid, whole on one line
      expect(t).toContain(REQ)
      expect(t).toMatch(/age \d+m/)
      expect(t).toContain('👨‍👩‍👧') // a ZWJ sequence is never split
      expect(t).toContain('修复')
      expect(t).toContain('Claude Code 2.1.293')
      noneWide(rows, cols)
    })
    test('the permission commands are whole or honestly labelled, and the full id is copyable', async ($, on) => {
      $ref.$ = $; $ref.on = on
      const rows = await render(cols)
      const cmds = rows.filter(r => /approve|deny/.test(r))
      if (cols >= 50) {
        // each command fits: whole, with the whole id
        expect(cmds.some(r => r.includes(`belay approve ${REQ}`))).toBe(true)
        expect(cmds.some(r => r.includes(`belay deny ${REQ}`))).toBe(true)
      } else {
        // they do not fit: the id once on its own labelled line, the commands with a placeholder
        expect(rows.some(r => r.includes(`→ id ${REQ}`))).toBe(true)
        expect(cmds.some(r => r.includes('belay approve <id>'))).toBe(true)
        expect(cmds.some(r => r.includes('belay deny <id>'))).toBe(true)
      }
      // never "belay approve" next to a cut or absent id
      for (const r of cmds) expect(r).toMatch(/belay (approve|deny) (<id>|toolu_01A09q90qw90lq917835lq9X)/)
    })
  })
}

// The real docked pane measured from a rehearsal capture (160-column screen, divider at column 88): 71 cells.
// The table fits that width and a narrower one, and a task cell is one label, never two cut fragments.
for (const cols of [71, 50]) {
  describe(`the agents table at ${cols} columns`, () => {
    test('rows are not squeezed and each task cell is one label, not two cut fragments', async ($, on) => {
      $ref.$ = $; $ref.on = on
      const wd = await boot($, on, { coder1Title: 'Add titleCase', mod: { task: 'title' } })
      await openPane($, wd)
      const { ui } = await pane($, 'terminal', cols)
      const tree = await ui.drawn()
      expect(squeezed(tree, cols)).toEqual([])
      // A fixed-width cell holds no more text than its width: two Texts that over-fill it are each cut by the host.
      const over: string[] = []
      const walk = (n: any): void => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) return n.forEach(walk)
        const w = n.props?.width
        if (n.type === 'Box' && typeof w === 'number' && w > 0) { const t = leaves(n).join(''); if (cellsOf(t) > w) over.push(`${cellsOf(t)} > ${w}: ${t}`) }
        walk(n.children)
      }
      walk(tree)
      expect(over).toEqual([])
      const rows = leaves(tree)
      const start = rows.findIndex(r => r.startsWith('coder-1'))
      const end = rows.findIndex(r => r.startsWith('coder-2'))
      const cell = rows.slice(start, end)
      // The task cell is one title or one id: no leaf is a short fragment cut with an ellipsis ("work…").
      expect(cell.filter(r => /^\S{1,8}…$/.test(r.trim()))).toEqual([])
      expect(cell.filter(r => r.includes('…')).length).toBeLessThanOrEqual(1)
      if (cols === 71) expect(cell.join('|')).toMatch(/Add titleCase|Add t…|7c9e6679/) // at 50 the whole task column drops
    })
  })
}

// mod.task: the task column shows the kind (default), the id and title, or nothing. The detail keeps the full task.
async function rowsOf(cols: number, mod: Record<string, string>) {
  const wd = await boot($ref.$, $ref.on, { coder1Title: 'Add titleCase', extra: ['running'], ...(Object.keys(mod).length ? { mod } : {}) })
  await openPane($ref.$, wd)
  const { ui } = await pane($ref.$, 'terminal', cols)
  const rows = leaves(await ui.drawn())
  const at = (id: string) => rows.slice(rows.findIndex(r => r.startsWith(id)), rows.findIndex(r => r.startsWith(id)) + 6).join('|')
  return { rows, at, ui }
}
for (const [value, mod] of [['default', {}], ['kind', { task: 'kind' }]] as const) {
  test(`mod.task ${value} at 71 shows work, rev and no title`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const { rows, at } = await rowsOf(71, mod)
    expect(at('coder-1')).toContain('work')
    expect(at('coder-1')).not.toContain('Add titleCase')
    expect(at('rev-1')).toContain('rev')
    expect(at('rev-1')).not.toContain('Review t-4')
    expect(rows.join('\n')).not.toContain('Embedder warm-up')
  })
}
for (const cols of [50, 45]) {
  test(`mod.task kind at ${cols} keeps the kind label`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const { at } = await rowsOf(cols, { task: 'kind' })
    expect(at('coder-1').split('|').map(x => x.trim())).toContain('work')
    expect(at('coder-1')).not.toContain('Add titleCase')
  })
}
test('mod.task off at 50 drops the column', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const off = await rowsOf(50, { task: 'off' })
  expect(off.at('coder-1').split('|').map(x => x.trim())).not.toContain('work')
})
test('mod.task title at 71 keeps the id and title or the title', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const { at } = await rowsOf(71, { task: 'title' })
  expect(at('coder-1')).toMatch(/Add titleCase|Add t…|7c9e6679/)
})
test('mod.task off at 71 shows no task column', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const { at } = await rowsOf(71, { task: 'off' })
  expect(at('coder-1')).not.toMatch(/work|Add titleCase|7c9e6679/)
})
for (const task of ['kind', 'off']) {
  test(`the detail shows the full task id and title with mod.task ${task}`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const { ui } = await rowsOf(71, { task })
    await ui.press({ key: 'agent:coder-1' })
    const t = leaves(await ui.drawn()).join(String.fromCharCode(10))
    expect(t).toContain(TASK4)
    expect(t).toContain('Add titleCase')
  })
}

// The review verdict stays in the task column after the kind and is never what is cut. At 50 the whole column drops.
const V = (task_id: string, verdict: string) => ({ kind: 'review_verdict', ts: T0 - 1000, run_id: RUN, task_id, executable: true, passed: verdict === 'holds', verdict, judged_by: 'x' })
for (const cols of [71, 50]) {
  test(`mod.task kind at ${cols}: a holds and a refuted verdict follow the kind`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const wd = await boot($, on, { mod: { task: 'kind' }, notices: { run_id: RUN, events: [V('t-5', 'holds'), V(TASK4, 'refuted')] } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', cols)
    const text = leaves(await ui.drawn()).join(' ')
    if (cols === 71) { expect(text).toMatch(/rev\s+→\s+holds/); expect(text).toMatch(/work\s+→\s+refuted/) } else { expect(text).toContain('review holds · x'); expect(text).toContain('t-5') } // at 50 the tokens give way to the verdict: it now fits
  })
}
test('mod.task title keeps the verdict', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const wd = await boot($, on, { mod: { task: 'title' }, notices: { run_id: RUN, events: [V('t-5', 'holds')] } })
  await openPane($, wd)
  const { ui } = await pane($, 'terminal', 71)
  expect(leaves(await ui.drawn()).join(' ')).toMatch(/→\s+holds/)
})

// A pending permission is a bare ▲ after the kind in kind mode, on a no-task row too: the request id (about 30 characters)
// and the commands are in the permission notice. A no-task agent is a one-cell dash.
const PERM = (w: string) => ({ kind: 'permission_pending', ts: T0 - 60000, run_id: RUN, worker_id: w, request_id: REQ, tool: 'Bash', age_ms: 60000 })
for (const cols of [71, 60, 45]) {
  test(`mod.task kind at ${cols}: a bare ▲ follows the kind, a no-task row shows a dash and its ▲`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const wd = await boot($, on, { mod: { task: 'kind' }, extra: ['running'], notices: { run_id: RUN, events: [V('t-5', 'holds'), PERM('coder-2'), PERM('w-running')] } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', cols)
    const all = leaves(await ui.drawn())
    const rows = all.join(' ')
    expect(rows).toMatch(/work\s+▲/)
    expect(rows).toMatch(/—\s+▲/)
    expect(rows).not.toContain('no task')
    expect(rows).toMatch(/rev\s+→\s+holds/)
    expect(rows).toContain(REQ) // the full id is in the notices
    expect(squeezed(await ui.drawn(), cols)).toEqual([])
  })
}
// With a no-task agent the kind column still costs only its real labels: at 50 the context column stays.
test('mod.task kind at 50 with a no-task agent keeps the context column', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const { rows } = await rowsOf(50, { task: 'kind' })
  expect(rows.some(r => r.trim() === 'ctx')).toBe(true)
})
// When the model name is dropped and the row still does not fit, the kind column goes before an agent id is cut.
test('mod.task kind at 26 drops the kind column before it cuts the orchestrator id', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const wd = await boot($, on, { mod: { task: 'kind' } })
  await openPane($, wd)
  const { ui } = await pane($, 'terminal', 26)
  expect(leaves(await ui.drawn()).filter(r => /^orchestra\s*$/.test(r))).toEqual([]) // the table's id cell is whole, not cut to 'orchestra'
})
test('mod.task kind at 60 keeps the kind label (the title column would have dropped)', async ($, on) => {
  $ref.$ = $; $ref.on = on
  const { at } = await rowsOf(60, { task: 'kind' })
  expect(at('coder-1').split('|').map(x => x.trim())).toContain('work')
})

// The verdict is kept at every width where the context column is kept: the cache column drops before the verdict does
// (a rehearsal pane of 65 columns showed `rev` alone beside a cache bar while the notice said the review held).
for (const cols of [72, 68, 65, 62, 60, 56]) {
  test(`mod.task kind at ${cols}: the verdict is not pushed out by the cache column`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const wd = await boot($, on, { mod: { task: 'kind' }, notices: { run_id: RUN, events: [V('t-5', 'holds')] } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', cols)
    const rows = leaves(await ui.drawn())
    const i = rows.findIndex(r => r.startsWith('rev-1'))
    expect(rows.slice(i, i + 5).join(' ')).toMatch(/rev\s+→\s+holds/)
  })
}

// With the narrow cache cell (mod.cache bar) and a long verdict, a row keeps the cache or the verdict, never neither.
for (const cols of [58, 57, 56, 55]) {
  test(`mod.task kind, mod.cache bar at ${cols}: a refuted row shows the cache (coder-2: 22% then a warm bar) or the verdict`, async ($, on) => {
    $ref.$ = $; $ref.on = on
    const wd = await boot($, on, { mod: { task: 'kind', cache: 'bar' }, notices: { run_id: RUN, events: [V('t-6', 'refuted')] } })
    await openPane($, wd)
    const { ui } = await pane($, 'terminal', cols)
    const rows = leaves(await ui.drawn())
    const i = rows.findIndex(r => r.startsWith('coder-2'))
    expect(rows.slice(i, i + 12).join(' ')).toMatch(/refuted|22%\s+▰▰▰/)
  })
}
