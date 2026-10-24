'use strict';
// surface.test.cjs — build step S2, ADR 0024: a worker
// sees only the tools, instructions and settings belay gives it. Pure tests of src/run/surface.cjs
// and the launch-table argv it feeds, plus one read of a real 2.1.283 receipt. No process spawned here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../../src/run/surface.cjs');
const L = require('../../src/run/launch.cjs');
const { createParser } = require('../../src/run/parsers.cjs');

const S0_STREAM = path.join(__dirname, 'fixtures', 'surface-baseline-init.jsonl');

// ------------------------------------------------------------------------- (s1)

test('surface: ancestorExcludes names every ancestor\'s instruction files and none of the cwd\'s own', () => {
  const win = S.ancestorExcludes('C:/a/b/wt');
  assert.deepStrictEqual(win, [
    'C:/a/b/CLAUDE.md', 'C:/a/b/CLAUDE.local.md', 'C:/a/b/.claude/CLAUDE.md', 'C:/a/b/.claude/rules/**',
    'C:/a/CLAUDE.md', 'C:/a/CLAUDE.local.md', 'C:/a/.claude/CLAUDE.md', 'C:/a/.claude/rules/**',
    'C:/CLAUDE.md', 'C:/CLAUDE.local.md', 'C:/.claude/CLAUDE.md', 'C:/.claude/rules/**',
  ]);
  for (const e of win) assert.ok(!e.includes('//'), 'no doubled slash: ' + e);
  assert.ok(!win.some((e) => e.startsWith('C:/a/b/wt/')), 'nothing is added for the cwd itself');

  // A posix-shaped input resolves (via path.resolve, platform default) against the current drive on
  // this host, so the same three-ancestor shape holds, still forward-slashed and never doubled.
  const posix = S.ancestorExcludes('/a/b/wt');
  assert.equal(posix.length, 12);
  for (const e of posix) assert.ok(!e.includes('//'), 'no doubled slash: ' + e);
  assert.ok(!posix.some((e) => e.includes('/a/b/wt/')), 'nothing is added for the cwd itself');
});

// ------------------------------------------------------------------------- (s2)

test('surface: hygieneSettings disables auto-memory and dream and carries the excludes as strings', () => {
  const h = S.hygieneSettings('C:/a/b/wt');
  assert.equal(h.autoMemoryEnabled, false);
  assert.equal(h.autoDreamEnabled, false);
  assert.ok(Array.isArray(h.claudeMdExcludes) && h.claudeMdExcludes.length === 12);
  for (const e of h.claudeMdExcludes) assert.equal(typeof e, 'string');
  assert.deepStrictEqual(h.claudeMdExcludes, S.ancestorExcludes('C:/a/b/wt'));
});

// ------------------------------------------------------------------------- (s3)

test('launch: both argv builders carry --tools and the one token --setting-sources=, on a fresh launch and on a resume', () => {
  const fresh = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's' });
  const toolsAt = fresh.indexOf('--tools');
  assert.ok(toolsAt >= 0);
  assert.deepStrictEqual(fresh.slice(toolsAt, toolsAt + 3), ['--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--setting-sources=']);

  const resumed = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', resumeSessionId: 'sess-1' });
  const toolsAt2 = resumed.indexOf('--tools');
  assert.ok(toolsAt2 >= 0, 'a resume must carry --tools too, never only a fresh launch');
  assert.deepStrictEqual(resumed.slice(toolsAt2, toolsAt2 + 3), ['--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--setting-sources=']);
  assert.deepStrictEqual(resumed.slice(-2), ['--resume', 'sess-1']);

  const withPrompt = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', permissionPromptTool: true });
  const toolsAt3 = withPrompt.indexOf('--tools');
  assert.deepStrictEqual(withPrompt.slice(toolsAt3, toolsAt3 + 3), ['--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--setting-sources=']);
  assert.ok(withPrompt.includes('--permission-prompt-tool'));

  const orch = L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's' });
  const toolsAt4 = orch.indexOf('--tools');
  assert.ok(toolsAt4 >= 0);
  assert.deepStrictEqual(orch.slice(toolsAt4, toolsAt4 + 3), ['--tools', 'Read,Glob,Grep,Edit,Write', '--setting-sources='], 'ADR 0054 decision 1: the orchestrator has no shell');

  const orchResumed = L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's', resumeSessionId: 'sess-2' });
  const toolsAt5 = orchResumed.indexOf('--tools');
  assert.ok(toolsAt5 >= 0, 'an orchestrator resume must carry --tools too');
  assert.deepStrictEqual(orchResumed.slice(toolsAt5, toolsAt5 + 3), ['--tools', 'Read,Glob,Grep,Edit,Write', '--setting-sources=']);
  assert.deepStrictEqual(orchResumed.slice(-2), ['--resume', 'sess-2']);
  for (const a of [fresh, resumed, withPrompt, orch, orchResumed]) assert.ok(!a.includes('--setting-sources'), 'no bare --setting-sources token');
});

// ------------------------------------------------------------------------- (s4)

test('surface: a 2.1.283-shaped init with the six tools, belay tools and a builtin plugin passes', () => {
  const ready = {
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'mcp__belay__memory_store', 'mcp__belay__ping'],
    plugins: [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }, { name: 'telemetry', path: 'builtin', source: 'telemetry@builtin' }],
  };
  const r = S.checkSurface(ready, { permissionPrompt: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.evidence.tools_hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(r.evidence.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.deepStrictEqual(r.evidence.belay_tools, ['mcp__belay__memory_store', 'mcp__belay__ping']);
  assert.deepStrictEqual(r.evidence.plugins, ready.plugins);
});

// ------------------------------------------------------------------------- (s5)

const BASE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'mcp__belay__ping'];
const BASE_PLUGINS = [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }];

test('surface: each way the surface can differ is refused and named', () => {
  const extraBuiltin = S.checkSurface({ tools: [...BASE_TOOLS, 'Task'], plugins: BASE_PLUGINS }, {});
  assert.equal(extraBuiltin.ok, false);
  assert.match(extraBuiltin.reason, /^the system\/init surface is not the one ADR 0024 allows:/);
  assert.match(extraBuiltin.reason, /Task/);

  const missingWrite = S.checkSurface({ tools: BASE_TOOLS.filter((t) => t !== 'Write'), plugins: BASE_PLUGINS }, {});
  assert.equal(missingWrite.ok, false);
  assert.match(missingWrite.reason, /Write/);

  const foreignMcp = S.checkSurface({ tools: [...BASE_TOOLS, 'mcp__other__x'], plugins: BASE_PLUGINS }, {});
  assert.equal(foreignMcp.ok, false);
  assert.match(foreignMcp.reason, /mcp__other__x/);

  const permitListed = S.checkSurface({ tools: [...BASE_TOOLS, 'mcp__belay__permit'], plugins: BASE_PLUGINS }, { permissionPrompt: true });
  assert.equal(permitListed.ok, false);
  assert.match(permitListed.reason, /mcp__belay__permit/);

  const badPlugin = S.checkSurface({ tools: BASE_TOOLS, plugins: [{ name: 'x', path: 'user', source: 'example-plugin@example' }] }, {});
  assert.equal(badPlugin.ok, false);
  assert.match(badPlugin.reason, /example-plugin@example/);

  const badMemory = S.checkSurface({ tools: BASE_TOOLS, plugins: BASE_PLUGINS, memory_paths: { auto: 'C:/x/memory/' } }, {});
  assert.equal(badMemory.ok, false);
  assert.match(badMemory.reason, /memory_paths\.auto/);
  assert.match(badMemory.reason, /C:\/x\/memory\//);

  const toolsAbsent = S.checkSurface({ plugins: BASE_PLUGINS }, {});
  assert.equal(toolsAbsent.ok, false);
  assert.match(toolsAbsent.reason, /tools is not an array/);

  // Two differences at once are both named, not just the first.
  const both = S.checkSurface({ tools: [...BASE_TOOLS, 'Task', 'mcp__other__x'], plugins: BASE_PLUGINS }, {});
  assert.equal(both.ok, false);
  assert.match(both.reason, /Task/);
  assert.match(both.reason, /mcp__other__x/);

  // F1 (S2 review 1, should-fix 1): a non-array plugins value is refused, never thrown on.
  const pluginsObject = S.checkSurface({ tools: BASE_TOOLS, plugins: {} }, {});
  assert.equal(pluginsObject.ok, false);
  assert.match(pluginsObject.reason, /plugins/);

  const pluginsString = S.checkSurface({ tools: BASE_TOOLS, plugins: 'x' }, {});
  assert.equal(pluginsString.ok, false);
  assert.match(pluginsString.reason, /plugins/);

  // F2 (should-fix 2): plugins absent or null is refused too (decision 6's letter), not accepted.
  const pluginsAbsent = S.checkSurface({ tools: BASE_TOOLS }, {});
  assert.equal(pluginsAbsent.ok, false);
  assert.match(pluginsAbsent.reason, /plugins/);

  const pluginsNull = S.checkSurface({ tools: BASE_TOOLS, plugins: null }, {});
  assert.equal(pluginsNull.ok, false);
  assert.match(pluginsNull.reason, /plugins/);

  // F2: any memory_paths that is not null or undefined is refused, not only a truthy `.auto`.
  const memoryOtherKey = S.checkSurface({ tools: BASE_TOOLS, plugins: BASE_PLUGINS, memory_paths: { project: 'x' } }, {});
  assert.equal(memoryOtherKey.ok, false);
  assert.match(memoryOtherKey.reason, /memory_paths/);

  const memoryString = S.checkSurface({ tools: BASE_TOOLS, plugins: BASE_PLUGINS, memory_paths: 'x' }, {});
  assert.equal(memoryString.ok, false);
  assert.match(memoryString.reason, /memory_paths/);

  const memoryArray = S.checkSurface({ tools: BASE_TOOLS, plugins: BASE_PLUGINS, memory_paths: [] }, {});
  assert.equal(memoryArray.ok, false);
  assert.match(memoryArray.reason, /memory_paths/);

  const memoryAutoEmpty = S.checkSurface({ tools: BASE_TOOLS, plugins: BASE_PLUGINS, memory_paths: { auto: '' } }, {});
  assert.equal(memoryAutoEmpty.ok, false);
  assert.match(memoryAutoEmpty.reason, /memory_paths/);

  // F2: the belay tool set is "any mcp__belay__*, and at least one" — an init listing none is refused.
  const noBelayTools = S.checkSurface({ tools: S.CLAUDE_TOOLS, plugins: BASE_PLUGINS }, {});
  assert.equal(noBelayTools.ok, false);
  assert.match(noBelayTools.reason, /mcp__belay/);

  // F2: mcp__belay__permit without a configured prompt tool stays allowed — the real S0 init lists it.
  const permitNoPrompt = S.checkSurface({ tools: [...BASE_TOOLS, 'mcp__belay__permit'], plugins: BASE_PLUGINS }, {});
  assert.equal(permitNoPrompt.ok, true, JSON.stringify(permitNoPrompt));
});

// ------------------------------------------------------------------------- (s6)

test('surface: the probe\'s real S0 init is refused, naming Task, SendMessage and Workflow', () => {
  const lines = fs.readFileSync(S0_STREAM, 'utf8').split('\n').filter(Boolean);
  const initLine = lines.find((l) => { try { const j = JSON.parse(l); return j.type === 'system' && j.subtype === 'init'; } catch { return false; } });
  assert.ok(initLine, 'the baseline fixture must carry a system/init line');

  const parser = createParser('claude-code');
  const [ev] = parser.pushLine(initLine);
  assert.equal(ev.kind, 'ready');

  const r = S.checkSurface(ev, { permissionPrompt: false });
  assert.equal(r.ok, false, 'the real baseline surface (30 tools) must not pass ADR 0024\'s gate');
  assert.match(r.reason, /Task/);
  assert.match(r.reason, /SendMessage/);
  assert.match(r.reason, /Workflow/);
});

// ------------------------------------------------------------------------- (s7)

test('launch: writeWorkerFiles writes the excludes for its cwd and still disables the named plugins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-surface-launch-'));
  const userSettings = path.join(dir, 'user-settings.json');
  fs.writeFileSync(userSettings, JSON.stringify({ enabledPlugins: { 'example-plugin@example': true } }));
  const wdir = path.join(dir, 'workers', 'w1');
  const cwd = path.join(dir, 'wt');

  const r = L.writeWorkerFiles({ dir: wdir, workerId: 'w1', runId: 'run-1', dataDir: dir, settingsPath: userSettings, cwd });
  const settings = JSON.parse(fs.readFileSync(r.settingsPath, 'utf8'));
  assert.deepStrictEqual(settings.enabledPlugins, { 'example-plugin@example': false });
  assert.deepStrictEqual(settings.claudeMdExcludes, S.ancestorExcludes(cwd));
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.autoDreamEnabled, false);

  // No cwd: exactly today's object, unchanged.
  const r2 = L.writeWorkerFiles({ dir: path.join(dir, 'workers', 'w2'), workerId: 'w2', runId: 'run-1', dataDir: dir, settingsPath: userSettings });
  const settings2 = JSON.parse(fs.readFileSync(r2.settingsPath, 'utf8'));
  assert.deepStrictEqual(settings2, { enabledPlugins: { 'example-plugin@example': false } });

  fs.rmSync(dir, { recursive: true, force: true });
});
