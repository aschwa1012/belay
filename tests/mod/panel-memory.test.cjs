'use strict';
require('../helpers/tmp.cjs');
// The panel's Memory menu model (src/mod/hooks/panel/memory.ts), tested in npm test and CI: the plugin's own tests run only in Claude Code's plugin
// harness. The model is loaded by type stripping and fed the REAL `belay memory menu` output, so the two sides cannot drift apart unseen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPanelModule } = require('./load-ts.cjs');
const { menu: buildMenu } = require('../../src/core/memory-menu.cjs');
const P = require('../../src/core/gpu-probe.cjs');
const C = require('../../src/cli/config.cjs');
const AD = require('../../src/run/agent-defaults.cjs');
const { writeSetting, writeSettings } = require('../../src/cli/cmd-settings.cjs');

let M, root, saved;
test.before(async () => {
  M = await loadPanelModule('memory');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-panelmem-'));
  saved = { c: process.env.BELAY_MODEL_CACHE, g: process.env.BELAY_GPU_RUNTIME };
  process.env.BELAY_MODEL_CACHE = path.join(root, 'models');
  process.env.BELAY_GPU_RUNTIME = path.join(root, 'gpu');
});
test.after(() => {
  for (const [k, v] of [['BELAY_MODEL_CACHE', saved.c], ['BELAY_GPU_RUNTIME', saved.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const real = async (memory, probed = true) => {
  const proj = fs.mkdtempSync(path.join(root, 'p-'));
  fs.mkdirSync(path.join(proj, '.belay'));
  if (memory) fs.writeFileSync(path.join(proj, 'belay.config.json'), JSON.stringify({ memory }));
  const file = P.peaksFile();
  if (probed) P.recordLast(file, { ok: true, device: { name: 'RTX 5060' }, dedicated: { free_mb: 7000, total_mb: 7899 } }, []);
  else fs.rmSync(file, { force: true });
  const json = JSON.parse(JSON.stringify(await buildMenu({ found: C.discover(proj), dataDir: path.join(proj, '.belay'), agentTypes: AD.AGENT_KEYS })));
  return { json, menu: M.normMenu(json), proj };
};

test('the panel reads the real menu: the GPU line, the levers, the profiles, the models and the agent types', async () => {
  const { menu } = await real({ project: 'acme', profile: 'gpu-balanced', profile_cpu: 'cpu-rerank', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank-light' } });
  assert.ok(menu);
  assert.deepStrictEqual([menu.gpu.state, menu.gpu.device, menu.gpu.freeMb, menu.gpu.totalMb, menu.gpu.ok], ['probed', 'RTX 5060', 7000, 7899, true]);
  assert.deepStrictEqual([menu.levers.profile, menu.levers.profileCpu, menu.levers.rerankDepth, menu.levers.searchLogCapMb, menu.levers.onHeavyBehind, menu.levers.onHeavyFailure], ['gpu-balanced', 'cpu-rerank', 50, 500, 'wait', 'fallback']);
  assert.deepStrictEqual([menu.levers.routing, menu.levers.routingCpu], [{ reviewer: 'gpu-rerank' }, { reviewer: 'cpu-rerank-light' }]);
  assert.strictEqual(menu.profiles.length, 7);
  assert.strictEqual(menu.models.length, 8);
  assert.deepStrictEqual(menu.mainTypes, ['orchestrator', 'reviewer', 'coder']);
  assert.ok(menu.advancedTypes.includes('tester'));
  assert.strictEqual(menu.headroomMb, 768);
  assert.strictEqual(M.badgeOf({ behind: menu.behind }), 0, 'no store, nothing behind: no badge');
});

test('the badge is the selected embedder\'s backlog and nothing else', async () => {
  const { menu } = await real({ project: 'acme' });
  assert.strictEqual(M.badgeOf({ behind: 4 }), 4);
  assert.strictEqual(M.badgeOf({ behind: 0 }), 0, 'another embedder backlog is not in behind, so it gives no badge');
  assert.strictEqual(M.badgeOf(null), 0);
  assert.strictEqual(M.normBadge({ v: 1, badge: true, behind: 3, selected_embedder: 'x' }), 3);
  for (const bad of [null, {}, { v: 1, behind: 3 }, { v: 1, badge: true, behind: 'x' }, { v: 2, badge: true, behind: 1 }]) assert.strictEqual(M.normBadge(bad), null);
});

test('normMenu is defensive: a wrong version, a missing table or a non-object is null, and a field of the wrong type becomes null, never invented', async () => {
  const { json } = await real(null);
  for (const bad of [null, 3, 'x', {}, { ...json, v: 2 }, { ...json, models: [] }, { ...json, profiles: 'x' }, { ...json, levers: null }]) assert.strictEqual(M.normMenu(bad), null, JSON.stringify(bad).slice(0, 40));
  const odd = M.normMenu({ ...json, headroom_mb: 'x', gpu: { ...json.gpu, free_mb: 'lots', device: 5 }, models: [...json.models, null, { id: '' }, 7] });
  assert.strictEqual(odd.headroomMb, 768);
  assert.strictEqual(odd.gpu.freeMb, null);
  assert.strictEqual(odd.gpu.device, null);
  assert.strictEqual(odd.models.length, json.models.length, 'rows with no id are dropped');
  const noisy = M.normMenu({ ...json, project: 'a\u0007b' });
  assert.strictEqual(noisy.project, 'a\u0007b', 'the project is not drawn by the menu; models and labels are cleaned');
});

test('routeFit sums the GPU models once each, at the measured peak, with the headroom, against the free memory', async () => {
  const { menu } = await real({ profile: 'gpu-balanced' });
  const d = M.draftOf(menu);
  const f = M.routeFit(menu, d);
  assert.strictEqual(f.models.length, 2);
  assert.strictEqual(f.sumMb, 2629 + 2782);
  assert.strictEqual(f.needMb, 2629 + 2782 + 768);
  assert.deepStrictEqual([f.freeMb, f.ok], [7000, true]);
  const more = M.routeFit(menu, { gpu: { reviewer: 'gpu-rerank-fast' }, cpu: {} });
  assert.strictEqual(more.models.length, 3, 'the 0.6B reranker is added to the run profile\'s two');
  assert.strictEqual(more.ok, false, '2629 + 2782 + 879 + 768 > 7000');
  assert.strictEqual(M.routeFit(menu, { gpu: { reviewer: 'gpu-rerank' }, cpu: {} }).models.length, 2, 'a model the run profile already loads counts once');
  assert.strictEqual(M.routeFit(menu, { gpu: { reviewer: { embedder: 'Qwen/Qwen3-Embedding-8B-GGUF', reranker: 'none' } }, cpu: {} }).models.length, 3, 'a custom pair counts its models');
  const cpu = (await real({ profile: 'cpu-rerank' }, false)).menu;
  assert.deepStrictEqual([M.routeFit(cpu, M.draftOf(cpu)).models.length, M.routeFit(cpu, M.draftOf(cpu)).ok], [0, true]);
  const unprobed = (await real({ profile: 'gpu-balanced' }, false)).menu;
  assert.deepStrictEqual([M.routeFit(unprobed, M.draftOf(unprobed)).freeMb, M.routeFit(unprobed, M.draftOf(unprobed)).ok], [null, null], 'free memory unknown: nothing is refused on a guess');
});

test('the routing draft: picks cycle from run default, a custom pair is kept until pressed, and the maps it writes drop run-default entries', async () => {
  const { menu } = await real({ routing: { coder: { embedder: 'onnx-community/voyage-4-nano-ONNX', reranker: 'giladgd/Qwen3-Reranker-4B-GGUF' } } });
  let d = M.draftOf(menu);
  assert.deepStrictEqual(M.draftMaps(d).routing, menu.levers.routing, 'unchanged: the custom pair is saved as it was');
  assert.strictEqual(M.sameDraft(menu, d), true);
  d = M.cycleDraft(menu, d, 'gpu', 'coder');
  assert.deepStrictEqual(M.draftMaps(d).routing, null, 'a press takes a custom pair to run default');
  d = M.cycleDraft(menu, d, 'gpu', 'coder');
  assert.strictEqual(d.gpu.coder, 'cpu-fast');
  d = M.cycleDraft(menu, d, 'cpu', 'coder');
  assert.strictEqual(d.cpu.coder, 'cpu-fast');
  assert.deepStrictEqual(M.routingWrites(d), { kind: 'setMany', pairs: [['memory.routing', '{"coder":"cpu-fast"}'], ['memory.routing_cpu', '{"coder":"cpu-fast"}']] });
  assert.deepStrictEqual(M.routingWrites({ gpu: {}, cpu: {} }).pairs.map((w) => w[1]), ['null', 'null']);
  assert.deepStrictEqual(M.writeArgv(M.routingWrites(d), { models: [] }), [['settings', '--set', 'memory.routing', '{"coder":"cpu-fast"}', '--set', 'memory.routing_cpu', '{"coder":"cpu-fast"}']]);
  assert.ok(M.writeArgv({ kind: 'setMany', pairs: [['memory.routing', '{}'], ['memory.project', 'x']] }, { models: [] }).error, 'every key of a set must be one the menu writes');
  const cpuOpts = M.cpuOptions(menu);
  assert.ok(cpuOpts.every((o) => o === null || !o.startsWith('gpu-')));
  assert.strictEqual(M.nextPick(cpuOpts, cpuOpts[cpuOpts.length - 1]), null, 'the last option wraps to run default');
});

test('the commands the menu prints are exactly the ones belay runs', async () => {
  const { menu } = await real({ project: 'acme' });
  const by = (id) => menu.models.find((m) => m.id === id);
  assert.strictEqual(M.fetchLine(by('Qwen/Qwen3-Embedding-8B-GGUF')), 'belay embedder fetch --gpu --model Qwen/Qwen3-Embedding-8B-GGUF');
  assert.strictEqual(M.fetchLine(by('Alibaba-NLP/gte-reranker-modernbert-base')), 'belay embedder fetch --reranker Alibaba-NLP/gte-reranker-modernbert-base');
  assert.strictEqual(M.fetchLine(by('onnx-community/voyage-4-nano-ONNX')), 'belay embedder fetch');
  assert.strictEqual(M.embedLine(menu, by('Qwen/Qwen3-Embedding-4B-GGUF')), 'belay memory embed --model Qwen/Qwen3-Embedding-4B-GGUF --project acme');
  assert.strictEqual(M.runtimeLine(menu), 'belay embedder fetch --gpu');
  assert.match(M.probeLine(menu), /^belay embedder fetch --gpu {2}then {2}belay embedder fetch --gpu --model Qwen\/Qwen3-Embedding-0\.6B-GGUF$/);
});

test('the panel reads the live runs, and a model the config names is in use by the next run, not by "run"', async () => {
  const { json, menu } = await real({ project: 'acme', profile: 'gpu-rerank' });
  assert.deepStrictEqual(menu.liveRuns, []);
  assert.deepStrictEqual(M.normMenu({ ...json, live_runs: ['r-live'] }).liveRuns, ['r-live']);
  const by = json.models.filter((m) => m.in_use_by.length).flatMap((m) => m.in_use_by);
  assert.ok(by.includes('next run (config)'), JSON.stringify(by));
  assert.ok(!by.includes('run'), 'a bare "run" names no run');
});

test('resultLine: a receipt, a refusal with belay\'s own words, and an unparseable answer', () => {
  const set = { kind: 'set', key: 'memory.profile', value: 'gpu-rerank' };
  const receipt = JSON.stringify({ key: 'memory.profile', old: { value: 'cpu-fast' } });
  const scope = "; applies to the next run, and a spec's memory.profile overrides it";
  assert.strictEqual(M.resultLine(set, 0, receipt, ''), `belay: memory.profile set to gpu-rerank (was "cpu-fast")${scope}`);
  assert.strictEqual(M.resultLine(set, 0, receipt, '', { liveRuns: [] }), `belay: memory.profile set to gpu-rerank (was "cpu-fast")${scope}`);
  assert.strictEqual(M.resultLine(set, 0, receipt, '', { liveRuns: ['r-1', 'r-2'] }), `belay: memory.profile set to gpu-rerank (was "cpu-fast"); live run r-1, r-2 keeps the profile it started with, this applies to the next run, and a spec's memory.profile overrides it`);
  assert.strictEqual(M.resultLine({ kind: 'set', key: 'memory.rerank_depth', value: '40' }, 0, JSON.stringify({ key: 'memory.rerank_depth', old: { value: 50 } }), '', { liveRuns: ['r-1'] }), 'belay: memory.rerank_depth set to 40 (was 50)', 'a key that is not a profile carries no profile note');
  assert.strictEqual(M.resultLine(set, 2, JSON.stringify({ error: 'bad value' }), ''), 'belay: memory.profile was not written: bad value');
  assert.strictEqual(M.resultLine(set, 1, 'not json\nsecond', ''), 'belay: memory.profile was not written: not json');
  assert.strictEqual(M.resultLine({ kind: 'delete', model: 'a/b' }, 0, JSON.stringify({ removed: true, bytes: 35000000 }), ''), 'belay: a/b removed (33 MB)');
  assert.match(M.resultLine({ kind: 'verify', model: null }, 1, JSON.stringify({ verified: false, problems: ['x'] }), ''), /verify of the GPU runtime failed/);
});

test('settings writes keep belay settings\' own validation: a refused value writes nothing, and the routing writes go through', async () => {
  const proj = fs.mkdtempSync(path.join(root, 'w-'));
  const file = path.join(proj, 'belay.config.json');
  fs.writeFileSync(file, JSON.stringify({ memory: { project: 'acme' } }));
  const ctx = { cwd: proj };
  const before = fs.readFileSync(file, 'utf8');
  for (const [k, v] of [['memory.rerank_depth', '999'], ['memory.routing_cpu', '{"reviewer":"gpu-rerank"}'], ['memory.routing', '{"reviewer":"bogus"}'], ['memory.profile', 'nope'], ['memory.on_heavy_failure', 'explode'], ['memory.search_log_cap_mb', '0']]) {
    const r = writeSetting(C.discover(proj), k, v, ctx);
    assert.ok(r.code !== 0, `${k} ${v} is refused`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, `${k} ${v}: nothing was written`);
  }
  const pairs = M.routingWrites({ gpu: { reviewer: 'gpu-rerank' }, cpu: { reviewer: 'cpu-rerank' } }).pairs;
  // one bad key refuses BOTH: the good first pair is not written either
  const bad = writeSettings(C.discover(proj), [pairs[0], ['memory.routing_cpu', '{"reviewer":"gpu-rerank"}']], ctx);
  assert.ok(bad.code !== 0, 'the second pair is refused');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'so the first is not written');
  const both = writeSettings(C.discover(proj), pairs, ctx);
  assert.strictEqual(both.code, 0, both.text);
  assert.deepStrictEqual(both.json.keys, ['memory.routing', 'memory.routing_cpu']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).memory, { project: 'acme', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank' } });
  const cleared = writeSetting(C.discover(proj), 'memory.routing_cpu', 'null', ctx);
  assert.strictEqual(cleared.code, 0, cleared.text);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).memory.routing_cpu, null);
});
