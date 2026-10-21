import { describe, expect, test } from 'claude-code/testing'
import { IDS, JINA, MENU, boot, band, cmd, later, pane, openPane, words } from './support'

// The Memory menu (ADR 0050 amendment 3): tabs in the pane (Profiles, Routing, Models), a numbered badge on the main page only while the selected
// embedder is behind, and writes that go through belay's own commands after two presses. Every fixture is `belay memory menu --json` as the CLI prints it.
const heavy = { heavy: true }
async function menuPane($: any, on: any, w: Record<string, unknown> = {}) {
  const wd = await boot($, on, { ...heavy, ...w })
  await openPane($, wd)
  const p = await pane($)
  await p.ui.press({ key: 'mem' })
  await later(wd, 10500) // the next round reads the menu (it is open now)
  return { wd, ui: p.ui, text: async () => words(await p.ui.drawn()) }
}
const tab = async (m: any, name: string) => { await m.ui.press({ key: `mtab:${name}` }); await later(m.wd, 10) }
const kinds = (argvs: string[][]) => argvs.map(a => a.slice(a.findIndex(x => x === 'settings' || x === 'embedder')))

describe('the badge on the main page', () => {
  test('a numbered badge shows on the band and the pane button while the selected embedder has notes behind it', async ($, on) => {
    const wd = await boot($, on, { ...heavy })
    await later(wd, 31000)
    expect(wd.menuReads.length).toBeGreaterThan(0)
    expect(wd.menuReads.every(a => a.includes('--badge'))).toBe(true) // the main page asks for the one count, not the whole menu
    expect((await band($)).text).toContain(' [3]')
    await openPane($, wd)
    expect((await pane($)).text).toContain('memory menu [3]')
  })

  test('no badge when the selected embedder is not behind, even though another heavy embedder has a backlog', async ($, on) => {
    const m = MENU()
    ;(m.models.find((x: any) => x.id === IDS.E8) as any).backlog = 5
    const wd = await boot($, on, { ...heavy, menu: { ...m, behind: 0 } })
    await later(wd, 31000)
    expect(wd.menuReads.length).toBeGreaterThan(0)
    expect((await band($)).text).not.toContain('[')
    await openPane($, wd)
    const t = (await pane($)).text
    expect(t).toContain('memory menu')
    expect(t).not.toContain('memory menu [')
  })

  test('the Profiles tab warns, and does not block, when the saved routing with the run profile does not fit the free memory', async ($, on) => {
    const m = await menuPane($, on, { menu: MENU({ levers: { ...MENU().levers, routing: { reviewer: 'gpu-rerank-fast' } } }) })
    expect(await m.text()).toContain('▲ the saved routing and this profile together need 6.9 GB and 6.8 GB is free')
    await m.ui.press({ key: 'set:memory.profile:gpu-rerank' })
    expect(await m.text()).toContain('press the same button again') // a warning, not a refusal
  })

  test('a CPU-only configuration with the menu closed reads no menu at all (reading stays free for the default setup)', async ($, on) => {
    const wd = await boot($, on, {})
    await later(wd, 61000)
    expect(wd.menuReads).toEqual([])
    expect((await band($)).text).not.toContain('[3]')
  })

  test('a menu that cannot be read shows no badge, and says why inside the menu, not in the run\'s errors', async ($, on) => {
    const m = await menuPane($, on, { menu: null })
    expect(await m.text()).toContain('The Memory menu could not be read: belay memory menu exit 1')
    expect(await m.text()).not.toContain('belay agents')
    expect((await band($)).text).not.toContain('memory menu exit')
  })
})

describe('the badge poll and the menu read', () => {
  test('the badge goes when the settings stop naming a heavy tier', async ($, on) => {
    const wd = await boot($, on, { ...heavy })
    await later(wd, 31000)
    expect((await band($)).text).toContain(' [3]')
    wd.w.heavy = false
    await later(wd, 12000) // the next settings round says memory_heavy false
    expect((await band($)).text).not.toContain('[3]')
  })

  test('a refresh forced while a badge read is in flight is not dropped: the full menu is read as soon as that read ends', async ($, on) => {
    const wd = await boot($, on, { ...heavy, menuSlow: 6000 })
    await later(wd, 100)
    expect(wd.menuReads.length).toBe(1) // the first tick started the badge read, which takes 6 s
    expect(wd.menuReads[0]!.includes('--badge')).toBe(true)
    await openPane($, wd)
    const p = await pane($)
    await p.ui.press({ key: 'mem' }) // asks for the full menu while the badge read is still running
    await later(wd, 3000)
    expect(wd.menuReads.length).toBe(1) // never two at once
    await later(wd, 12000)
    expect(wd.menuReads.some(a => !a.includes('--badge'))).toBe(true)
  })

  test('a failing read does not stop the next one', async ($, on) => {
    const wd = await boot($, on, { ...heavy, menu: null })
    await later(wd, 31000)
    const first = wd.menuReads.length
    expect(first).toBeGreaterThan(0)
    await later(wd, 31000)
    expect(wd.menuReads.length).toBeGreaterThan(first)
  })
})

describe('the Profiles tab', () => {
  test('shows the GPU line, both pickers with models, time and VRAM, the two radios, the depth and the log cap', async ($, on) => {
    const m = await menuPane($, on)
    const t = await m.text()
    expect(t).toContain('GPU NVIDIA GeForce RTX 5060 · 6.8 GB free of 7.7 GB · probed 14:02')
    expect(t).toContain('GPU runtime installed')
    expect(t).toContain('When a GPU is available')
    expect(t).toContain('(•) gpu-balanced  Qwen3-Embedding-4B Q4_K_M + Qwen3-Reranker-4B Q4_K_M  ~2.8 s  5.3 GB')
    expect(t).toContain('( ) cpu-fast  voyage-4-nano, no reranker  no extra time  no VRAM')
    expect(t).toContain('When on CPU only')
    expect(t).toContain('(•) cpu-rerank  voyage-4-nano + gte-reranker-modernbert-base int8  ~3.6 s  no VRAM')
    expect(t).toContain('(•) fall back to the fallback profile, say so loudly')
    expect(t).toContain('( ) pause the run')
    expect(t).toContain('(•) wait: embed the backlog first')
    expect(t).toContain('Rerank depth')
    expect(t).toContain('(•) 50')
    expect(t).toContain('Search log cap')
    expect(t).toContain('(•) 500 MB')
  })

  test('the CPU-only picker offers the CPU profiles only', async ($, on) => {
    const m = await menuPane($, on)
    const cpu = (await m.text()).split('When on CPU only')[1]!.split('If a heavy model fails')[0]!
    expect(cpu).toContain('cpu-fast')
    expect(cpu).toContain('cpu-rerank-light')
    expect(cpu).not.toContain('gpu-')
  })

  test('an unprobed GPU says so, and the probe action prints the command instead of running one', async ($, on) => {
    const gpu = { state: 'not_probed', device: null, free_mb: null, total_mb: null, ok: null, reason: null, at: null, runtime: { installed: false, ok: false, command: 'belay embedder fetch --gpu', problems: 1 } }
    const m = await menuPane($, on, { menu: MENU({ gpu }) })
    expect(await m.text()).toContain('GPU not probed · free memory unknown')
    expect(await m.text()).toContain('GPU runtime not installed')
    await m.ui.press({ key: 'probe' })
    expect(m.wd.toasts.at(-1)).toContain('belay memory embed --model Qwen/Qwen3-Embedding-4B-GGUF --project acme')
    expect(await m.text()).toContain('run: belay memory embed --model Qwen/Qwen3-Embedding-4B-GGUF --project acme')
    expect(m.wd.menuWrites).toEqual([])
  })

  test('a pick needs two presses: the first asks, the second writes through belay settings and the menu is read again', async ($, on) => {
    const m = await menuPane($, on)
    await m.ui.press({ key: 'set:memory.profile:gpu-rerank' })
    expect(m.wd.menuWrites).toEqual([])
    expect(await m.text()).toContain('? set memory.profile to gpu-rerank: press the same button again to do it')
    const reads = m.wd.menuReads.length
    await m.ui.press({ key: 'set:memory.profile:gpu-rerank' })
    await later(m.wd, 1500)
    expect(m.wd.menuWrites[0]!.slice(m.wd.menuWrites[0]!.indexOf('settings'), m.wd.menuWrites[0]!.indexOf('settings') + 3)).toEqual(['settings', 'memory.profile', 'gpu-rerank'])
    expect(m.wd.toasts).toContain('belay: memory.profile set to gpu-rerank (was "cpu-fast")')
    await later(m.wd, 11000)
    expect(m.wd.menuReads.length).toBeGreaterThan(reads)
    expect(await m.text()).not.toContain('press the same button again')
  })

  test('another press cancels the confirm, so the same button asks again', async ($, on) => {
    const m = await menuPane($, on)
    await m.ui.press({ key: 'set:memory.on_heavy_failure:pause' })
    await tab(m, 'routing')
    await tab(m, 'profiles')
    await m.ui.press({ key: 'set:memory.on_heavy_failure:pause' })
    expect(m.wd.menuWrites).toEqual([])
    expect(await m.text()).toContain('press the same button again')
  })

  test('a confirm that waits too long is gone: the late second press asks again and writes nothing', async ($, on) => {
    const m = await menuPane($, on)
    await m.ui.press({ key: 'set:memory.rerank_depth:100' })
    await later(m.wd, 9000)
    await m.ui.press({ key: 'set:memory.rerank_depth:100' })
    expect(m.wd.menuWrites).toEqual([])
  })

  test('a value belay refuses shows its error and writes nothing: the pick stays as it was', async ($, on) => {
    const writeResult = () => ({ exitCode: 2, stdout: JSON.stringify({ error: 'memory.rerank_depth must be an integer from 1 to 200; nothing was written', usage: 'u' }), stderr: '' })
    const m = await menuPane($, on, { writeResult })
    await m.ui.press({ key: 'set:memory.rerank_depth:200' })
    await m.ui.press({ key: 'set:memory.rerank_depth:200' })
    await later(m.wd, 10)
    expect(m.wd.toasts).toContain('belay: memory.rerank_depth was not written: memory.rerank_depth must be an integer from 1 to 200; nothing was written')
    expect(await m.text()).toContain('(•) 50')
  })
})

describe('the Routing tab', () => {
  const press = async (m: any, key: string, n = 1) => { for (let i = 0; i < n; i += 1) { await m.ui.press({ key }); await later(m.wd, 5) } }

  test('a row for the orchestrator, reviewer and coder with a GPU pick and a CPU-only pick, the other agent types under advanced, and the summed VRAM', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'routing')
    const t = await m.text()
    for (const r of ['orchestrator', 'reviewer', 'coder']) expect(t).toContain(r)
    expect(t.split('GPU run default ▸').length - 1).toBe(3)
    expect(t.split('CPU run default ▸').length - 1).toBe(3)
    expect(t).toContain('advanced: 2 other agent types')
    expect(t).not.toContain('tester')
    expect(t).toContain('GPU memory: Qwen3-Embedding-4B Q4_K_M + Qwen3-Reranker-4B Q4_K_M = 5.3 GB + 0.8 GB headroom = 6.0 GB of 6.8 GB free')
    expect(t).toContain('no changes to save')
    await m.ui.press({ key: 'adv' })
    expect(await m.text()).toContain('tester')
  })

  test('a pick cycles from run default through the profiles, and the CPU pick offers only CPU profiles', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'routing')
    await press(m, 'route:gpu:reviewer', 5)
    expect(await m.text()).toContain('GPU gpu-rerank ▸')
    await press(m, 'route:cpu:coder', 3)
    expect(await m.text()).toContain('CPU cpu-rerank ▸')
    await press(m, 'route:cpu:coder', 1)
    expect(await m.text()).toContain('CPU run default ▸')
    expect(m.wd.menuWrites).toEqual([])
  })

  test('a routing that does not fit is red and cannot be saved: the press writes nothing and says why', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'routing')
    await press(m, 'route:gpu:reviewer', 4) // gpu-rerank-fast adds the 0.6B reranker to the run profile's models
    const t = await m.text()
    expect(t).toContain('= 6.1 GB + 0.8 GB headroom = 6.9 GB of 6.8 GB free')
    expect(t).toContain('does not fit: the routing cannot be saved')
    expect(t).toContain('✕ cannot save: does not fit')
    await press(m, 'route:save', 2)
    expect(m.wd.menuWrites).toEqual([])
    expect(m.wd.toasts.at(-1)).toBe('belay: the routing was not saved: its GPU models need 6.9 GB with headroom and 6.8 GB is free.')
  })

  test('a routing that fits is saved through its two settings after two presses, and the draft is cleared', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'routing')
    await press(m, 'route:gpu:reviewer', 5)
    await press(m, 'route:cpu:reviewer', 3)
    expect(await m.text()).toContain('▸ save routing')
    await press(m, 'route:save', 1)
    expect(await m.text()).toContain('▸ press again to save the routing')
    expect(m.wd.menuWrites).toEqual([])
    await press(m, 'route:save', 1)
    await later(m.wd, 100)
    const w = kinds(m.wd.menuWrites)
    expect(w.length).toBe(1) // both settings in ONE call: belay validates both before it writes either
    expect(w[0]!.slice(0, 7)).toEqual(['settings', '--set', 'memory.routing', '{"reviewer":"gpu-rerank"}', '--set', 'memory.routing_cpu', '{"reviewer":"cpu-rerank"}'])
    expect(m.wd.toasts).toContain('belay: memory.routing and memory.routing_cpu saved')
  })

  test('a routing with no picks writes null for both settings (the lever\'s own "no routing")', async ($, on) => {
    const menu = MENU({ levers: { ...MENU().levers, routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank' } } })
    const m = await menuPane($, on, { menu })
    await tab(m, 'routing')
    expect(await m.text()).toContain('GPU gpu-rerank ▸')
    await press(m, 'route:gpu:reviewer', 3) // gpu-rerank is the sixth of eight options: three more presses wrap to run default
    await press(m, 'route:cpu:reviewer', 1) // cpu-rerank is the last CPU option: one more wraps to run default
    await press(m, 'route:save', 2)
    await later(m.wd, 100)
    expect(kinds(m.wd.menuWrites).map(a => a.slice(0, 7))).toEqual([['settings', '--set', 'memory.routing', 'null', '--set', 'memory.routing_cpu', 'null']])
  })

  test('without a probe the fit is unknown and nothing is refused on a guess', async ($, on) => {
    const gpu = { state: 'not_probed', device: null, free_mb: null, total_mb: null, ok: null, reason: null, at: null, runtime: { installed: true, ok: true, command: 'x', problems: 0 } }
    const m = await menuPane($, on, { menu: MENU({ gpu }) })
    await tab(m, 'routing')
    await press(m, 'route:gpu:reviewer', 4)
    const t = await m.text()
    expect(t).toContain('free memory unknown: not probed')
    expect(t).not.toContain('cannot save')
    await press(m, 'route:save', 2)
    await later(m.wd, 100)
    expect(m.wd.menuWrites.length).toBe(1)
  })
})

describe('the Models tab', () => {
  test('lists embedders and rerankers with size, VRAM or cpu, and state, the backlog, the GPU runtime and the disk used', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'models')
    const t = await m.text()
    expect(t).toContain('Qwen3-Embedding-4B Q4_K_M · 2.3 GB · 2.6 GB VRAM (reference) · ready · in use')
    expect(t).toContain('Qwen3-Embedding-8B Q4_K_M · 4.4 GB · 4.6 GB VRAM (reference) · download')
    expect(t).toContain('voyage-4-nano q4 · 232 MB · cpu · ready')
    expect(t).toContain('jina-reranker-v1-tiny-en int8 · 33 MB · cpu · ready')
    expect(t).toContain('gte-reranker-modernbert-base int8 · 148 MB · cpu · download')
    expect(t).toContain('backlog 3')
    expect(t).toContain('[embed now]')
    expect(t).toContain('GPU runtime · installed')
    expect(t).toContain('disk used by models 2.6 GB in 3 models')
  })

  test('a download and an embed-now print the exact command (they last minutes and a reload would end them) and run nothing', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'models')
    await m.ui.press({ key: `fetch:${IDS.E8}` })
    expect(m.wd.toasts.at(-1)).toBe(`belay: run  belay embedder fetch --gpu --model ${IDS.E8}`)
    await m.ui.press({ key: 'fetch:Alibaba-NLP/gte-reranker-modernbert-base' })
    expect(m.wd.toasts.at(-1)).toBe('belay: run  belay embedder fetch --reranker Alibaba-NLP/gte-reranker-modernbert-base')
    await m.ui.press({ key: `embed:${IDS.E4}` })
    expect(m.wd.toasts.at(-1)).toBe(`belay: run  belay memory embed --model ${IDS.E4} --project acme`)
    expect(await m.text()).toContain(`run: belay memory embed --model ${IDS.E4} --project acme`)
    expect(m.wd.menuWrites).toEqual([])
    expect(m.wd.spawned).toEqual([])
  })

  test('the embed-now button is only there while there is a backlog', async ($, on) => {
    const m = await menuPane($, on, { menu: MENU({ behind: 0, models: MENU().models.map((x: any) => (x.id === IDS.E4 ? { ...x, backlog: 0 } : x)) }) })
    await tab(m, 'models')
    expect(await m.text()).toContain('backlog 0')
    expect(await m.text()).not.toContain('[embed now]')
  })

  test('verify runs belay embedder verify after two presses and toasts the answer', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'models')
    await m.ui.press({ key: `verify:${IDS.E4}` })
    expect(await m.text()).toContain('hash Qwen/Qwen3-Embedding-4B-GGUF against its table')
    await m.ui.press({ key: `verify:${IDS.E4}` })
    await later(m.wd, 100)
    expect(kinds(m.wd.menuWrites)[0]!.slice(0, 5)).toEqual(['embedder', 'verify', '--gpu', '--model', IDS.E4])
    expect(m.wd.toasts).toContain(`belay: ${IDS.E4} verified`)
    await m.ui.press({ key: 'runtime:verify' })
    await m.ui.press({ key: 'runtime:verify' })
    await later(m.wd, 100)
    expect(kinds(m.wd.menuWrites)[1]!.slice(0, 3)).toEqual(['embedder', 'verify', '--gpu'])
  })

  test('delete removes a model nothing uses after two presses, and refuses one the settings use with the reason', async ($, on) => {
    const m = await menuPane($, on)
    await tab(m, 'models')
    await m.ui.press({ key: `delete:${IDS.E4}` })
    await m.ui.press({ key: `delete:${IDS.E4}` })
    expect(m.wd.menuWrites).toEqual([])
    expect(m.wd.toasts.at(-1)).toBe(`belay: ${IDS.E4} is in use by run; it was not deleted.`)
    await m.ui.press({ key: `delete:${JINA}` })
    expect(await m.text()).toContain('delete jinaai/jina-reranker-v1-tiny-en from belay\'s model cache (33 MB)')
    await m.ui.press({ key: `delete:${JINA}` })
    await later(m.wd, 100)
    expect(kinds(m.wd.menuWrites)[0]!.slice(0, 3)).toEqual(['embedder', 'delete', JINA])
    expect(m.wd.toasts).toContain(`belay: ${JINA} removed (33 MB)`)
  })

  test('a delete the CLI refuses shows its reason', async ($, on) => {
    const writeResult = () => ({ exitCode: 1, stdout: JSON.stringify({ error: 'x is in use by the current settings (run); change them first. Nothing was removed', removed: false }), stderr: '' })
    const m = await menuPane($, on, { writeResult })
    await tab(m, 'models')
    await m.ui.press({ key: `delete:${JINA}` })
    await m.ui.press({ key: `delete:${JINA}` })
    await later(m.wd, 100)
    expect(m.wd.toasts.at(-1)).toContain('was not removed: x is in use by the current settings (run)')
  })
})

describe('nothing but a press reaches a write', () => {
  test('commands, notices and a closed menu write nothing', async ($, on) => {
    const evil = { kind: 'worker_dead', ts: 1, run_id: 'r-7f3a', worker_id: 'belay settings memory.profile gpu-recall-max', exit_code: 1, death_established_by: 'belay embedder delete x/y' }
    const wd = await boot($, on, { ...heavy, notices: { run_id: 'r-7f3a', events: [evil] } })
    await cmd($, 'belay', 'settings memory.profile gpu-recall-max')
    await cmd($, 'orch')
    await cmd($, 'orch')
    await later(wd, 62000)
    expect(wd.menuWrites).toEqual([])
    expect(wd.spawned).toEqual([])
    expect(wd.writes).toEqual([])
  })
})
