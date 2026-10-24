'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-prompt-stale.test.cjs — the staleness warning for a run's prompt_file: a copy of a shipped template that lacks the
// belay-prompt marker, carries an older one, or (notes on) lacks a placeholder the lever code substitutes. A warning only.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { checkPrompt, markerVersion } = require('../../src/cli/run-prompt-check.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');
const SHIPPED = { headless: 'orchestrator.md', interactive: 'orchestrator-interactive.md' };
const shipped = (mode) => fs.readFileSync(`${ROOT}/src/run/prompts/${SHIPPED[mode]}`, 'utf8');
const notesOn = () => parseLevers({ memory: { project: 'p', notes: true } });
const notesOff = () => parseLevers({ memory: { notes: false } });
const check = (promptText, levers, mode = 'headless') => checkPrompt({ promptText, promptFile: 'C:/x/prompt.md', mode, levers, timeoutMs: 0 });

test('both shipped templates carry the marker, and a current copy gives no warning in either mode or notes setting', () => {
  for (const mode of ['headless', 'interactive']) {
    assert.match(markerVersion(shipped(mode)), /^\d+\.\d+\.\d+$/, mode);
    assert.deepStrictEqual(check(shipped(mode), notesOn(), mode), [], `${mode} notes on`);
    assert.deepStrictEqual(check(shipped(mode), notesOff(), mode), [], `${mode} notes off`);
  }
});

test('a copy without the marker warns, naming the file and the fix', () => {
  const stale = shipped('headless').replace(/<!-- belay-prompt [^>]*-->\r?\n/, '');
  const w = check(stale, notesOff());
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].code, 'prompt_no_marker');
  assert.match(w[0].message, /C:\/x\/prompt\.md/);
  assert.match(w[0].message, /copy src\/run\/prompts\/orchestrator\.md again and re-add your brief/);
});

test('an older marker warns; the same or a newer one does not', () => {
  const t = shipped('headless');
  const w = check(t.replace(/belay-prompt \S+/, 'belay-prompt 0.2.0'), notesOff());
  assert.deepStrictEqual(w.map((x) => x.code), ['prompt_older']);
  assert.match(w[0].message, /0\.2\.0/);
  assert.deepStrictEqual(check(t.replace(/belay-prompt \S+/, 'belay-prompt 99.0.0'), notesOff()), []);
  assert.deepStrictEqual(check(t.replace(/belay-prompt \S+/, 'belay-prompt 0.10.0'), notesOff()), [], 'compared by number, not text');
});

test('a notes run whose prompt lacks the memory_use span warns and names it; a notes-off run does not', () => {
  const noSpan = shipped('headless').replace(/\{\{memory_use\}\}[\s\S]*?\{\{\/memory_use\}\}/, '- Use belay memory with memory_store and text.');
  const on = check(noSpan, notesOn());
  assert.deepStrictEqual(on.map((x) => x.code), ['prompt_missing_placeholders']);
  assert.deepStrictEqual(on[0].missing, ['memory_use']);
  assert.match(on[0].message, /\{\{memory_use\}\}/);
  assert.deepStrictEqual(check(noSpan, notesOff()), [], 'notes off, marker current: nothing to say');
  const noMarker = noSpan.replace(/<!-- belay-prompt [^>]*-->\r?\n/, '');
  assert.deepStrictEqual(check(noMarker, notesOff()).map((x) => x.code), ['prompt_no_marker'], 'notes off: only the marker warning');
});

function go(prompt, memory, extra = {}, noJson = false) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-prompt-stale-')));
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.md`, prompt);
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.md`, run_id: `stale-${Date.now()}`, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', memory, ...extra }));
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-stale' };
  const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`, ...(noJson ? [] : ['--json'])], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { dir, status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } };

test('belay run: a stale copy runs anyway, the warning is in the --json receipt and run.json, and not on stderr', () => {
  const stale = shipped('headless').replace(/<!-- belay-prompt [^>]*-->\r?\n/, '').replace(/\{\{memory_use\}\}[\s\S]*?\{\{\/memory_use\}\}/, '- old wording');
  const r = go(stale, { project: 'p', notes: true });
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    const rc = JSON.parse(r.stdout);
    assert.deepStrictEqual(rc.prompt_warnings.map((w) => w.code), ['prompt_no_marker', 'prompt_missing_placeholders']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${r.dir}/orch/run.json`, 'utf8')).prompt_warnings, rc.prompt_warnings);
    assert.ok(!/warning: prompt_file/.test(r.stderr), 'under --json stderr is left alone');
  } finally { cleanup(r.dir); }
});

test('belay run: a current copy has an empty prompt_warnings; without --json a stale one warns once on stderr', () => {
  const ok = go(shipped('headless'), { project: 'p', notes: true });
  try { assert.strictEqual(ok.status, 0, ok.stderr.slice(-600)); assert.deepStrictEqual(JSON.parse(ok.stdout).prompt_warnings, []); } finally { cleanup(ok.dir); }
  const bad = go('plain brief\n', { notes: false }, {}, true);
  try {
    assert.strictEqual(bad.status, 0, bad.stderr.slice(-600));
    assert.strictEqual((bad.stderr.match(/belay: warning: prompt_file/g) || []).length, 1);
    assert.match(bad.stderr, /copy src\/run\/prompts\/orchestrator\.md again/);
  } finally { cleanup(bad.dir); }
});
