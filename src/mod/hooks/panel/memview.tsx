// The Memory menu's drawing (ADR 0050 amendment 3): a tabbed view in the pane. Profiles, Routing and Models. Colours are theme keys only. Nothing
// here fetches, writes or runs a command: a press only calls the one `act.mem` handler the caller passes, with a plain action (memory.ts), and
// index.tsx decides what runs. The tabs show the facts `belay memory menu` read; a model's state is the cache's, never a guess.

import type { BelayMenu, BelayMenuModel, BelayPanelMenu, BelayPanelUi } from '../../types/index'
import { fitSegs, type Seg } from './model'
import { CONFIRM_MS } from './held'
import {
  actionId, bytesText, CAP_PRESETS, DEPTH_PRESETS, draftOf, embedLine, fetchLine, gb, MEM_TABS, probeLine, profileText, routeFit, runtimeLine, sameDraft, type MemAction,
} from './memory'
import { cells, clipCells, wrapHard } from './wrap'
import { FreeRow } from './longtext'
import type { Act, Els } from './view'

export type MCtx = { E: Els; state: BelayPanelMenu | null; ui: BelayPanelUi; now: number; cols: number; act: Act }
const press = (act: Act, a: MemAction) => () => act.mem(a)

const tp = (s: Seg): Record<string, unknown> => ({ ...(s.c ? { color: s.c } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}), wrap: 'truncate-end' })
function Row({ E, segs, k, w }: { E: Els; segs: Seg[]; k: string; w: number }) {
  const { Box, Text } = E
  return <Box key={k} flexShrink={0}>{fitSegs(segs, Math.max(1, w)).map(s => <Text {...tp(s)}>{s.t}</Text>)}</Box>
}

// A radio-like pick: its text wraps to the room, and while its write waits for the second press it says so.
function Pick({ E, k, on, text, a, ui, now, cols, act }: { E: Els; k: string; on: boolean; text: string; a: MemAction; ui: BelayPanelUi; now: number; cols: number; act: Act }) {
  const { Box, Button } = E
  const waiting = !!ui.memConfirm && ui.memConfirm.id === actionId(a) && now - ui.memConfirm.at <= CONFIRM_MS
  // The rest of a long text wraps under the pick, dim and indented past its mark, instead of being cut off at the side.
  const [first = '', ...rest] = cells(text) + 6 <= cols ? [text] : wrapHard(text, Math.max(8, cols - 6))
  return (
    <Box key={k} flexDirection="column">
      <Button key={k} plain dimColor={!on && !waiting} label={clipCells(`  ${waiting ? '(?)' : on ? '(•)' : '( )'} ${first}`, cols)} onPress={press(act, a)} />
      {rest.map((l, i) => <Row E={E} w={cols} k={`${k}-w${i}`} segs={[{ t: `      ${l}`, dim: true }]} />)}
    </Box>
  )
}

function Gpu({ E, menu, cols, act }: { E: Els; menu: BelayMenu; cols: number; act: Act }) {
  const { Box, Button } = E
  const g = menu.gpu
  const at = g.at ? g.at.slice(11, 16) : '?'
  const head: Seg[] = g.state === 'probed'
    ? [{ t: 'GPU ', dim: true }, { t: g.device ?? 'unknown device', bold: true }, { t: ` · ${g.freeMb === null ? '?' : gb(g.freeMb)} free${g.totalMb === null ? '' : ` of ${gb(g.totalMb)}`} · probed ${at}`, dim: true }, ...(g.ok ? [] : [{ t: ` · refused: ${g.reason ?? 'unknown'}`, c: 'warning' }])]
    : [{ t: 'GPU ', dim: true }, { t: 'not probed', c: 'warning' }, { t: ' · free memory unknown', dim: true }]
  return (
    <Box flexDirection="column">
      <Row E={E} w={cols} k="gh" segs={head} />
      <Row E={E} w={cols} k="gr" segs={[{ t: '    GPU runtime ', dim: true }, g.runtimeOk ? { t: 'installed', c: 'success' } : { t: g.runtimeInstalled ? 'installed but wrong' : 'not installed', c: 'warning' }]} />
      {g.state !== 'probed' && <Button key="probe" plain dimColor label="  ▸ probe now: shows the command" onPress={press(act, { kind: 'cmd', line: probeLine(menu) })} />}
    </Box>
  )
}

function Profiles(c: MCtx & { menu: BelayMenu }) {
  const { E, menu, ui, now, cols, act } = c
  const { Box } = E
  const lv = menu.levers
  const fit = routeFit(menu, draftOf(menu))
  const pick = (key: string, cur: string, value: string, text: string) => <Pick E={E} k={`set:${key}:${value}`} on={cur === value} text={text} a={{ kind: 'set', key, value }} ui={ui} now={now} cols={cols} act={act} />
  const radios = (key: string, cur: string, values: [string, string][]) => values.map(([v, t]) => pick(key, cur, v, t))
  return (
    <Box flexDirection="column">
      <Gpu E={E} menu={menu} cols={cols} act={act} />
      {fit.ok === false && <FreeRow E={E} w={cols} k="pw" segs={[{ t: `▲ the saved routing and this profile together need ${gb(fit.needMb)} and ${fit.freeMb === null ? '?' : gb(fit.freeMb)} is free: a run would fall back or refuse (see Routing)`, c: 'warning' }]} />}
      <Row E={E} w={cols} k="p1" segs={[{ t: 'When a GPU is available', bold: true }, { t: '  memory.profile', dim: true }]} />
      {menu.profiles.map(p => pick('memory.profile', lv.profile, p.name, profileText(p)))}
      <Row E={E} w={cols} k="p2" segs={[{ t: 'When on CPU only', bold: true }, { t: '  memory.profile_cpu', dim: true }]} />
      {menu.profiles.filter(p => p.device === 'cpu').map(p => pick('memory.profile_cpu', lv.profileCpu, p.name, profileText(p)))}
      <Row E={E} w={cols} k="p3" segs={[{ t: 'If a heavy model fails during a run', bold: true }, { t: '  on_heavy_failure', dim: true }]} />
      {radios('memory.on_heavy_failure', lv.onHeavyFailure, [['fallback', 'fall back to the fallback profile, say so loudly'], ['pause', 'pause the run']])}
      <Row E={E} w={cols} k="p4" segs={[{ t: 'If a heavy embedder is behind at run start', bold: true }, { t: '  on_heavy_behind', dim: true }]} />
      {radios('memory.on_heavy_behind', lv.onHeavyBehind, [['wait', 'wait: embed the backlog first'], ['fallback', 'fall back to nano for this run']])}
      <Row E={E} w={cols} k="p5" segs={[{ t: 'Rerank depth', bold: true }, { t: '  rerank_depth: candidates reranked per search', dim: true }]} />
      <Box>{DEPTH_PRESETS.map(n => pick('memory.rerank_depth', String(lv.rerankDepth), String(n), String(n)))}</Box>
      <Row E={E} w={cols} k="p7" segs={[{ t: 'Search log', bold: true }, { t: '  search_log: each search and its query text, kept in this store only', dim: true }]} />
      {radios('memory.search_log', String(lv.searchLog), [['false', 'off (the default)'], ['true', 'on: for a retrieval eval']])}
      <Row E={E} w={cols} k="p6" segs={[{ t: 'Search log cap', bold: true }, { t: '  search_log_cap_mb: oldest runs pruned first', dim: true }]} />
      <Box>{CAP_PRESETS.map(n => pick('memory.search_log_cap_mb', String(lv.searchLogCapMb), String(n), `${n} MB`))}</Box>
    </Box>
  )
}

const pickName = (p: unknown): string => (p === null || p === undefined ? 'run default' : typeof p === 'string' ? p : 'custom pair')

function Routing(c: MCtx & { menu: BelayMenu }) {
  const { E, menu, ui, now, cols, act } = c
  const { Box, Button } = E
  const d = ui.routeDraft ?? draftOf(menu)
  const fit = routeFit(menu, d)
  const changed = !sameDraft(menu, d)
  const half = Math.max(12, Math.floor((cols - 14) / 2))
  const role = (t: string) => (
    <Box key={`r-${t}`}>
      <Box width={13} flexShrink={0}><Row E={E} w={12} k={`rn-${t}`} segs={[{ t, dim: true }]} /></Box>
      <Button key={`route:gpu:${t}`} plain label={clipCells(`GPU ${pickName(d.gpu[t])} ▸`, half)} onPress={press(act, { kind: 'cycle', side: 'gpu', type: t })} />
      <Text2 E={E} t="  " />
      <Button key={`route:cpu:${t}`} plain label={clipCells(`CPU ${pickName(d.cpu[t])} ▸`, half)} onPress={press(act, { kind: 'cycle', side: 'cpu', type: t })} />
    </Box>
  )
  const adv = ui.groups.includes('mem:adv')
  const save: MemAction = { kind: 'saveRouting' }
  const waiting = !!ui.memConfirm && ui.memConfirm.id === actionId(save) && now - ui.memConfirm.at <= CONFIRM_MS
  const fitSegsLine: Seg[] = !fit.models.length
    ? [{ t: 'GPU memory: no GPU model in this routing', dim: true }]
    : [{ t: 'GPU memory: ', dim: true }, { t: `${fit.models.map(m => m.label).join(' + ')} = ${gb(fit.sumMb)} + ${gb(menu.headroomMb)} headroom = ${gb(fit.needMb)}`, c: fit.ok === false ? 'error' : undefined },
      { t: fit.freeMb === null ? ' · free memory unknown: not probed' : ` of ${gb(fit.freeMb)} free`, c: fit.ok === false ? 'error' : undefined, dim: fit.freeMb === null }]
  return (
    <Box flexDirection="column">
      <Row E={E} w={cols} k="rh" segs={[{ t: 'role', dim: true, bold: true }, { t: '          GPU pick, then CPU-only pick (run default is the Profiles choice)', dim: true }]} />
      {menu.mainTypes.map(role)}
      <Button key="adv" plain dimColor label={`${adv ? '▾' : '▸'} advanced: ${menu.advancedTypes.length} other agent types`} onPress={() => act.group('mem:adv')} />
      {adv && menu.advancedTypes.map(role)}
      <Row E={E} w={cols} k="rf" segs={fitSegsLine} />
      {fit.ok === false && <FreeRow E={E} w={cols} k="rx" segs={[{ t: 'does not fit: the routing cannot be saved. Pick smaller models or free GPU memory.', c: 'error' }]} />}
      {fit.ok === null && <FreeRow E={E} w={cols} k="ru" segs={[{ t: 'not probed: the probe at run start still refuses a set that does not fit', dim: true }]} />}
      <Button key="route:save" plain dimColor={!changed && fit.ok !== false}
        label={clipCells(fit.ok === false ? '  ✕ cannot save: does not fit' : !changed ? '  no changes to save' : waiting ? '  ▸ press again to save the routing' : '  ▸ save routing', cols)} onPress={press(act, save)} />
    </Box>
  )
}

function Text2({ E, t }: { E: Els; t: string }) { const { Text } = E; return <Text>{t}</Text> }

function ModelRow({ E, menu, m, ui, now, cols, act }: { E: Els; menu: BelayMenu; m: BelayMenuModel; ui: BelayPanelUi; now: number; cols: number; act: Act }) {
  const { Box, Button } = E
  const del: MemAction = { kind: 'delete', model: m.id }
  const ver: MemAction = { kind: 'verify', model: m.id }
  const asked = (a: MemAction) => !!ui.memConfirm && ui.memConfirm.id === actionId(a) && now - ui.memConfirm.at <= CONFIRM_MS
  const vram = m.device === 'gpu' ? `${m.vramMb === null ? '?' : gb(m.vramMb)} VRAM${m.vramSource === 'reference' ? ' (reference)' : ''}` : 'cpu'
  return (
    <Box key={`m-${m.id}`} flexDirection="column">
      <Row E={E} w={cols} k={`ml-${m.id}`} segs={[{ t: m.label, bold: true }, { t: ` · ${bytesText(m.bytes)} · ${vram} · `, dim: true }, m.state === 'ready' ? { t: 'ready', c: 'success' } : { t: 'download', c: 'warning' }, ...(m.inUse ? [{ t: ' · in use', dim: true }] : [])]} />
      <Box paddingLeft={2}>
        {m.state === 'download' && <Button key={`fetch:${m.id}`} plain label="[download] " onPress={press(act, { kind: 'cmd', line: fetchLine(m) })} />}
        {m.state === 'ready' && <Button key={`verify:${m.id}`} plain label={asked(ver) ? '[verify: press again] ' : '[verify] '} onPress={press(act, ver)} />}
        {m.state === 'ready' && <Button key={`delete:${m.id}`} plain label={asked(del) ? '[delete: press again] ' : '[delete…] '} onPress={press(act, del)} />}
        {m.heavy && m.state === 'ready' && <Row E={E} w={Math.max(8, cols - 30)} k={`bl-${m.id}`} segs={[{ t: m.backlog === null ? `backlog not counted${menu.backlogReason ? ` (${menu.backlogReason})` : ''} ` : `backlog ${m.backlog} `, c: (m.backlog ?? 0) > 0 ? 'warning' : undefined, dim: (m.backlog ?? 0) === 0 }]} />}
        {m.heavy && m.state === 'ready' && m.backlog !== null && m.backlog > 0 && <Button key={`embed:${m.id}`} plain label="[embed now]" onPress={press(act, { kind: 'cmd', line: embedLine(menu, m) })} />}
      </Box>
    </Box>
  )
}

function Models(c: MCtx & { menu: BelayMenu }) {
  const { E, menu, ui, now, cols, act } = c
  const { Box, Button } = E
  const g = menu.gpu
  const rv: MemAction = { kind: 'verify', model: null }
  const asked = !!ui.memConfirm && ui.memConfirm.id === actionId(rv) && now - ui.memConfirm.at <= CONFIRM_MS
  const group = (title: string, kind: 'embedder' | 'reranker') => (
    <Box key={`g-${kind}`} flexDirection="column">
      <Row E={E} w={cols} k={`gt-${kind}`} segs={[{ t: title, dim: true, bold: true }]} />
      {menu.models.filter(m => m.kind === kind).map(m => <ModelRow E={E} menu={menu} m={m} ui={ui} now={now} cols={cols} act={act} />)}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {group('embedders', 'embedder')}
      {group('rerankers', 'reranker')}
      <Row E={E} w={cols} k="mrt" segs={[{ t: 'GPU runtime', bold: true }, { t: ' · ', dim: true }, g.runtimeOk ? { t: 'installed', c: 'success' } : { t: g.runtimeInstalled ? 'installed but wrong' : 'not installed', c: 'warning' }]} />
      <Box paddingLeft={2}>
        {g.runtimeInstalled && <Button key="runtime:verify" plain label={asked ? '[verify: press again] ' : '[verify] '} onPress={press(act, rv)} />}
        {!g.runtimeOk && <Button key="runtime:install" plain label="[install]" onPress={press(act, { kind: 'cmd', line: runtimeLine(menu) })} />}
      </Box>
      <Row E={E} w={cols} k="mdisk" segs={[{ t: `disk used by models ${bytesText(menu.diskBytes)} in ${menu.diskModels} model${menu.diskModels === 1 ? '' : 's'}`, dim: true }]} />
    </Box>
  )
}

// The Memory menu: the tab bar, the one confirm line, the last answer, and the open tab.
export function MemoryPane(c: MCtx) {
  const { E, state, ui, now, cols, act } = c
  const { Box, Button } = E
  const menu = state?.menu ?? null
  const tab = ui.memTab ?? 'profiles'
  const waiting = ui.memConfirm && now - ui.memConfirm.at <= CONFIRM_MS ? ui.memConfirm : null
  return (
    <Box flexDirection="column">
      <Box>
        <Button key="mtab:back" plain dimColor label="‹ back  " onPress={press(act, { kind: 'tab', tab: 'main' })} />
        {MEM_TABS.map(t => <Button key={`mtab:${t}`} plain dimColor={t !== tab} label={`${t === tab ? '▸ ' : '  '}${t} `} onPress={press(act, { kind: 'tab', tab: t })} />)}
      </Box>
      {waiting && <FreeRow E={E} w={cols} k="mc" segs={[{ t: `? ${waiting.text}: press the same button again to do it; any other press cancels`, c: 'warning' }]} />}
      {ui.memNote && <FreeRow E={E} w={cols} k="mn" segs={[{ t: ui.memNote, dim: true }]} />}
      {!menu && <FreeRow E={E} w={cols} k="mu" segs={[{ t: state?.error ? `The Memory menu could not be read: ${state.error}` : 'reading the Memory menu…', dim: !state?.error, c: state?.error ? 'warning' : undefined }]} />}
      {menu && tab === 'profiles' && <Profiles {...c} menu={menu} />}
      {menu && tab === 'routing' && <Routing {...c} menu={menu} />}
      {menu && tab === 'models' && <Models {...c} menu={menu} />}
      <FreeRow E={E} w={cols} k="mf" segs={[{ t: 'writes the config file through belay settings · two presses · /orch toggles', dim: true }]} />
    </Box>
  )
}
