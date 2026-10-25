'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// The no-project notice on the CLI: `belay run` prints it once on stderr before launching, and `belay settings`, `belay status` and
// `belay doctor` list it as a warning with the fix line. Each is silent once memory.project is set. Read commands create no file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const TITLE = 'Notes are on, but no project is set, so this run keeps no notes';
const TITLE_NO_RUN = 'Notes are on, but no project is set, so no notes are kept';
const LINE = '"memory": { "project": "<name>" }';
const fwd = (p) => String(p).split(path.sep).join('/');

function project(config) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-mnotice-')));
  fs.mkdirSync(`${dir}/.git`);
  if (config) fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify(config));
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env } });
const count = (s, t) => s.split(t).length - 1;

for (const [name, config, shown] of [['no config', null, true], ['a config with no project', { memory: { rules: false } }, true], ['a config with a project', { memory: { project: 'acme' } }, false], ['notes off', { memory: { notes: false } }, false]]) {
  test(`settings, status and doctor with ${name}: the warning ${shown ? 'is' : 'is not'} listed, and no file is created`, () => {
    const dir = project(config);
    try {
      const before = fs.readdirSync(dir).sort();
      const st = JSON.parse(cli(dir, ['settings', '--json']).stdout);
      assert.strictEqual(!!st.memory_notice, shown);
      const text = cli(dir, ['settings']).stdout;
      assert.strictEqual(text.includes(TITLE_NO_RUN), shown);
      const dr = JSON.parse(cli(dir, ['doctor', '--json']).stdout);
      const row = dr.checks.find((c) => c.check === 'memory-project');
      assert.strictEqual(row.verdict, shown ? 'missing' : 'ok');
      if (shown) { assert.ok(row.evidence.includes(TITLE_NO_RUN)); assert.strictEqual(row.fix, LINE); }
      const stat = cli(dir, ['status', '--data', `${dir}/.belay`, '--json']);
      assert.strictEqual(stat.status, 0, stat.stderr);
      assert.strictEqual(!!JSON.parse(stat.stdout).memory_notice, shown);
      assert.strictEqual(cli(dir, ['status', '--data', `${dir}/.belay`]).stdout.includes(TITLE_NO_RUN), shown);
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'reading created nothing');
    } finally { cleanup(dir); }
  });
}

function runWith(config, specMemory) {
  const dir = project(config);
  const wt = `${dir}/wt`; fs.mkdirSync(wt);
  fs.writeFileSync(`${dir}/prompt.txt`, 'one\ntwo\n');
  const spec = { worktree: wt, prompt_file: `${dir}/prompt.txt`, run_id: `mn-${process.pid}-${Date.now()}`, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...(specMemory ? { memory: specMemory } : {}) };
  fs.writeFileSync(`${dir}/spec.json`, JSON.stringify(spec));
  const r = cli(dir, ['run', `${dir}/spec.json`, '--data', `${dir}/.belay`], { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '200' });
  return { dir, r };
}

test('run: the notice is printed once on stderr when there is no project, and the stdout receipt does not carry it', () => {
  const { dir, r } = runWith(null);
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(count(r.stderr, TITLE), 1, r.stderr);
    assert.ok(r.stderr.includes(LINE));
    assert.strictEqual(r.stdout.includes(TITLE_NO_RUN), false, 'the receipt on stdout is unchanged');
  } finally { cleanup(dir); }
});

test('run: no notice when the spec or the config sets a project, or notes are off', () => {
  for (const [config, mem] of [[null, { project: 'acme' }], [{ memory: { project: 'acme' } }, null], [null, { notes: false }]]) {
    const { dir, r } = runWith(config, mem);
    try {
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(count(r.stderr, TITLE), 0, r.stderr);
    } finally { cleanup(dir); }
  }
});

// parseLevers computes the notice a launch records on the run row (attachMemory carries its code).
test('launch notice: a config-level memory null is silent, a spec block overrides it, a spec null always is', () => {
  const RL = require('../../src/cli/run-levers.cjs');
  const code = (spec, config) => {
    const l = RL.parseLevers(spec, config === undefined ? {} : { config: { path: 'c.json', memory: config } });
    return { code: l.memory_notice ? l.memory_notice.code : null, recorded: RL.attachMemory(l).memory_notice };
  };
  assert.deepStrictEqual(code({}, null), { code: null, recorded: null }, 'inherited config memory: null');
  assert.deepStrictEqual(code({}, undefined), { code: 'memory_project_unset', recorded: 'memory_project_unset' }, 'nothing set: warned');
  assert.deepStrictEqual(code({ memory: {} }, null), { code: 'memory_project_unset', recorded: 'memory_project_unset' }, 'a spec block overrides the inherited null');
  assert.deepStrictEqual(code({ memory: { project: 'acme' } }, null), { code: null, recorded: null }, 'a project-bearing spec block');
  assert.deepStrictEqual(code({ memory: null }, { project: 'acme' }), { code: null, recorded: null }, 'spec null');
  assert.deepStrictEqual(code({ memory: { project: 'acme', redact: false } }, undefined), { code: 'memory_redact_off', recorded: 'memory_redact_off' });
});
