'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// `belay settings agents.<type>.codex_model` (audit L24): listed, written and unset like the other agents keys, refused on the
// orchestrator, and a Codex model under agents.<type>.model is refused at the write.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const fwd = (p) => String(p).split(path.sep).join('/');

function project() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-settings-cx-')));
  fs.mkdirSync(`${dir}/.git`);
  return dir;
}
function cli(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, windowsHide: true, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout || r.stderr); } catch { /* text */ }
  return { code: r.status, out, stderr: r.stderr };
}
const readConfig = (dir) => JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'));

test('settings: codex_model is written for a worker type, read back with the file as its source, and unset by null', () => {
  const dir = project();
  try {
    const w = cli(dir, ['settings', 'agents.coder.codex_model', 'gpt-6-sol']);
    assert.strictEqual(w.code, 0, w.stderr);
    assert.deepStrictEqual([w.out.old.value, w.out.new.value, w.out.new.source], [null, 'gpt-6-sol', `${dir}/belay.config.json`]);
    assert.deepStrictEqual(readConfig(dir), { agents: { coder: { codex_model: 'gpt-6-sol' } } });
    const r = cli(dir, ['settings', 'agents.coder.codex_model']);
    assert.deepStrictEqual([r.out.value, r.out.source], ['gpt-6-sol', `${dir}/belay.config.json`]);
    const u = cli(dir, ['settings', 'agents.coder.codex_model', 'null']);
    assert.strictEqual(u.code, 0, u.stderr);
    assert.deepStrictEqual([u.out.new.value, u.out.new.source], [null, 'default']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings: the orchestrator has no codex_model, and a Codex model under model is refused with the file unchanged', () => {
  const dir = project();
  try {
    assert.strictEqual(cli(dir, ['settings', 'agents.orchestrator.codex_model', 'gpt-6-sol']).code, 2);
    assert.ok(!fs.existsSync(`${dir}/belay.config.json`));
    const bad = cli(dir, ['settings', 'agents.coder.model', 'gpt-6-sol']);
    assert.strictEqual(bad.code, 2);
    assert.match(JSON.stringify(bad.out), /not a Claude model/);
    assert.ok(!fs.existsSync(`${dir}/belay.config.json`), 'nothing was written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
