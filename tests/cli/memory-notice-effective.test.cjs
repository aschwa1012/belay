'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// The no-project notice follows the effective levers: a run whose spec sets the project has notes on, so status and the
// panel's agents read say nothing is off; `belay settings` shows the effective notes state and why; `belay run --json`
// keeps stderr clean; memory:null and redact:false each get the right words.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const TITLE = 'Memory is off for this project';
const fwd = (p) => String(p).split(path.sep).join('/');
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env } });

function project(config) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-mneff-')));
  fs.mkdirSync(`${dir}/.git`);
  if (config) fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify(config));
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

let n = 0;
function runWith(config, specMemory, extra = []) {
  const dir = project(config);
  const wt = `${dir}/wt`; fs.mkdirSync(wt);
  fs.writeFileSync(`${dir}/prompt.txt`, 'one\ntwo\n');
  const runId = `mne-${process.pid}-${Date.now()}-${n++}`;
  const spec = { worktree: wt, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...(specMemory !== undefined ? { memory: specMemory } : {}) };
  fs.writeFileSync(`${dir}/spec.json`, JSON.stringify(spec));
  const r = cli(dir, ['run', `${dir}/spec.json`, '--data', `${dir}/.belay`, ...extra], { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '200' });
  return { dir, r, runId };
}

test('a run whose spec sets the project: status and agents say notes are on, not "Memory is off"; a run with no project still warns', () => {
  const on = runWith(null, { project: 'acme' });
  const off = runWith(null, undefined);
  try {
    assert.strictEqual(on.r.status, 0, on.r.stderr);
    const st = cli(on.dir, ['status', on.runId, '--data', `${on.dir}/.belay`, '--json']);
    assert.strictEqual(st.status, 0, st.stderr);
    assert.strictEqual(JSON.parse(st.stdout).memory_notice, undefined, 'the config has no project but the run does');
    assert.strictEqual(cli(on.dir, ['status', on.runId, '--data', `${on.dir}/.belay`]).stdout.includes(TITLE), false);
    const ag = JSON.parse(cli(on.dir, ['agents', on.runId, '--data', `${on.dir}/.belay`, '--json']).stdout);
    assert.strictEqual(ag.memory_notice, null, 'the panel reads this: the run has none, so the settings notice is dropped');

    const so = cli(off.dir, ['status', off.runId, '--data', `${off.dir}/.belay`, '--json']);
    assert.ok(JSON.parse(so.stdout).memory_notice, 'no project anywhere: the notice stands');
    const ao = JSON.parse(cli(off.dir, ['agents', off.runId, '--data', `${off.dir}/.belay`, '--json']).stdout);
    assert.strictEqual(ao.memory_notice.code, 'memory_project_unset', 'the run launched without a project carries the notice itself');
  } finally { cleanup(on.dir); cleanup(off.dir); }
});

test('belay run --json keeps stderr free of the notice; without --json it prints once', () => {
  const j = runWith(null, undefined, ['--json']);
  const t = runWith(null, undefined);
  try {
    assert.strictEqual(j.r.status, 0, j.r.stderr);
    assert.strictEqual(j.r.stderr.includes(TITLE), false, j.r.stderr);
    assert.strictEqual(t.r.stderr.includes(TITLE), true);
  } finally { cleanup(j.dir); cleanup(t.dir); }
});

test('run: memory:null prints no notice, redact:false with a project says why notes are off', () => {
  const a = runWith(null, null);
  const b = runWith(null, { project: 'acme', redact: false });
  try {
    assert.strictEqual(a.r.stderr.includes(TITLE), false, a.r.stderr);
    assert.strictEqual(b.r.stderr.includes('redaction is disabled'), true, b.r.stderr);
  } finally { cleanup(a.dir); cleanup(b.dir); }
});

test('settings shows the effective notes state and why, in text and json', () => {
  for (const [config, value, why] of [
    [null, false, 'memory.project is not set'],
    [{ memory: { project: 'acme' } }, true, 'memory.project is set'],
    [{ memory: { project: 'acme', redact: false } }, false, 'memory.redact is false'],
    [{ memory: { project: 'acme', notes: false } }, false, null],
  ]) {
    const dir = project(config);
    try {
      const j = JSON.parse(cli(dir, ['settings', '--json']).stdout);
      const row = j.settings.find((r) => r.key === 'memory.notes');
      assert.strictEqual(row.value, value, JSON.stringify(config));
      if (why) {
        assert.ok(row.note.includes(why), row.note);
        assert.ok(cli(dir, ['settings']).stdout.includes(`effective: ${value ? 'on' : 'off'}, because ${why}`));
      } else assert.ok(row.source !== 'default', 'notes: false is stated in the file, not a default');
      if (config && config.memory.redact === false) assert.strictEqual(j.memory_notice.code, 'memory_redact_off');
    } finally { cleanup(dir); }
  }
});

// A run answers for itself: status and the agents read follow what its launch recorded, in every case, never the config as it is now.
const notices = (dir, runId) => {
  const st = JSON.parse(cli(dir, ['status', runId, '--data', `${dir}/.belay`, '--json']).stdout);
  const ag = JSON.parse(cli(dir, ['agents', runId, '--data', `${dir}/.belay`, '--json']).stdout);
  return { status: st.memory_notice ? st.memory_notice.code : null, agents: ag.memory_notice ? ag.memory_notice.code : null };
};

test('a run keeps its own notice when the config changes: no project at launch stays warned, explicit off and memory null stay silent, redact false stays named', () => {
  const noProject = runWith(null, undefined);
  const memNull = runWith(null, null);
  const notesOff = runWith(null, { notes: false });
  const redactOff = runWith(null, { project: 'acme', redact: false });
  const cfgNull = runWith({ memory: null }, undefined);
  try {
    for (const x of [noProject, memNull, notesOff, redactOff, cfgNull]) assert.strictEqual(x.r.status, 0, x.r.stderr);
    assert.strictEqual(cfgNull.r.stderr.includes(TITLE), false, 'a config-level memory: null is as silent as a spec-level one');
    // the config as it is now: a project for the run launched without one, nothing for the rest
    fs.writeFileSync(`${noProject.dir}/belay.config.json`, JSON.stringify({ memory: { project: 'acme' } }));
    assert.deepStrictEqual(notices(noProject.dir, noProject.runId), { status: 'memory_project_unset', agents: 'memory_project_unset' }, 'the config gained a project; the live run was launched without one');
    assert.deepStrictEqual(notices(memNull.dir, memNull.runId), { status: null, agents: null }, 'memory null: silent against an empty config');
    assert.deepStrictEqual(notices(notesOff.dir, notesOff.runId), { status: null, agents: null }, 'notes false: silent against an empty config');
    assert.deepStrictEqual(notices(redactOff.dir, redactOff.runId), { status: 'memory_redact_off', agents: 'memory_redact_off' }, 'redaction off is named even though the config has no redact setting');
    assert.deepStrictEqual(notices(cfgNull.dir, cfgNull.runId), { status: null, agents: null });
  } finally { for (const x of [noProject, memNull, notesOff, redactOff, cfgNull]) cleanup(x.dir); }
});

test('settings <key> prints the same because line as the full listing', () => {
  for (const [config, why] of [[{ memory: { project: 'acme' } }, 'on, because memory.project is set'], [null, 'off, because memory.project is not set'], [{ memory: { project: 'acme', redact: false } }, 'off, because memory.redact is false']]) {
    const dir = project(config);
    try {
      const one = cli(dir, ['settings', 'memory.notes']);
      assert.strictEqual(one.status, 0, one.stderr);
      assert.ok(one.stdout.includes(`effective: ${why}`), one.stdout);
    } finally { cleanup(dir); }
  }
  const dir = project({ memory: { project: 'acme', notes: false } });
  try { assert.ok(!cli(dir, ['settings', 'memory.notes']).stdout.includes('effective:'), 'stated in the file: no effective line'); } finally { cleanup(dir); }
});
