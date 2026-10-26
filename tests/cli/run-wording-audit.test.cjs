'use strict';
// run-wording-audit.test.cjs — the run lever permission_prompt (ADR 0020 decision 1 as amended): the permission tools and the prompt line
// that goes with them exist only for a run that turns the channel on; and the template header markers are not shown to the model.
// Pure: levers, templates and argv are built here, nothing is launched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { parseLevers, substituteLevers, stripMarkers } = require('../../src/cli/run-levers.cjs');
const L = require('../../src/run/launch.cjs');
const { parseArgv } = require('../../src/mcp/argv.cjs');
const tools = require('../../src/mcp/tools.cjs');

const template = (f) => fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
const LINE = '- Answer permission requests (`mcp__belay__permission_list`, `mcp__belay__permission_decide`) only when the request is inside the plan.';

test('permission_prompt is a boolean run lever, absent from the levers unless on', () => {
  assert.deepStrictEqual(parseLevers({}), { max_fix_rounds: 2, fix_cutoff: 'orchestrator', on_embedder_failure: 'required' });
  assert.strictEqual(parseLevers({ permission_prompt: false }).permission_prompt, undefined);
  assert.strictEqual(parseLevers({ permission_prompt: true }).permission_prompt, true);
  assert.match(parseLevers({ permission_prompt: 'yes' }).error, /permission_prompt must be true or false/);
});

test('the permission line is in both prompts only for a run with the lever on, and substituteLevers counts it', () => {
  for (const [f, mode] of [['orchestrator.md', 'headless'], ['orchestrator-interactive.md', 'interactive']]) {
    const raw = template(f);
    assert.strictEqual(raw.split('{{permission_line}}').length - 1, 1, `${f} carries the placeholder once`);
    const off = substituteLevers(raw, parseLevers({}), 0, { mode });
    assert.ok(!off.text.includes('permission_list') && !off.text.includes('{{'), `${f}: off, no permission tools are named`);
    assert.strictEqual(off.substituted.permission_line, undefined);
    const on = substituteLevers(raw, parseLevers({ permission_prompt: true }), 0, { mode });
    assert.strictEqual(on.text.split(LINE).length - 1, 1, `${f}: on, the line is there once`);
    assert.strictEqual(on.substituted.permission_line, 1);
    // The line is a bullet of Rules of thumb and ends its own line; the bullet after it is intact either way.
    assert.ok(on.text.includes(`${LINE}\n- If a worker dies or stalls`) && off.text.includes('\n- If a worker dies or stalls'));
    assert.strictEqual(on.text.length - off.text.length, LINE.length + 1);
  }
});

test('the orchestrator adapter is launched with --permission-prompt only for such a run, and then lists the permission tools', () => {
  const base = { runId: 'r1', dataDir: path.join(ROOT, 'x-data'), mcpPath: 'adapter.cjs' };
  assert.ok(!L.orchestratorAdapterArgs(base).includes('--permission-prompt'));
  assert.ok(L.orchestratorAdapterArgs({ ...base, permissionPrompt: true }).includes('--permission-prompt'));
  assert.ok(L.orchestratorMcpConfig({ ...base, permissionPrompt: true }).mcpServers.belay.args.includes('--permission-prompt'));
  assert.ok(!L.orchestratorMcpConfig(base).mcpServers.belay.args.includes('--permission-prompt'));
  const argv = (...extra) => ['--role', 'orchestrator', '--run', 'r1', '--data', path.join(ROOT, 'x-data'), '--no-embed', ...extra];
  assert.strictEqual(parseArgv(argv('--permission-prompt')).permissionPrompt, true);
  assert.strictEqual(parseArgv(argv()).permissionPrompt, undefined);
  const names = (permissions) => tools.toolsFor('orchestrator', { permissions }).map((t) => t.name).filter((n) => n.startsWith('permission_'));
  assert.deepStrictEqual(names(false), []);
  assert.deepStrictEqual(names(true), ['permission_list', 'permission_decide']);
});

test('the template header markers are dropped from the rendered prompt and stay in the files that code reads', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const raw = template(f);
    assert.match(raw, /<!-- belay-prompt \d+\.\d+\.\d+ -->/);
    const out = stripMarkers(raw);
    assert.ok(!out.includes('belay-prompt') && !out.includes('belay-mode') && !out.includes('# Orchestrator prompt template'), f);
    assert.ok(out.startsWith('You are the orchestrator of a belay run.'), `${f}: the prompt begins with its first sentence`);
    assert.strictEqual(out.length, raw.length - raw.indexOf('You are the orchestrator'), `${f}: only the header block went`);
  }
  assert.match(template('orchestrator-interactive.md'), /<!-- belay-mode: interactive -->/, 'the file the interactive check reads keeps its marker');
  // An operator's copy keeps its own title and loses only the comment.
  assert.strictEqual(stripMarkers('# My prompt <!-- belay-prompt 0.3.0 -->\n\nbody'), '# My prompt\n\nbody');
  assert.strictEqual(stripMarkers('no markers here'), 'no markers here');
});
