'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ED = require('../../src/run/exe-discovery.cjs');

function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-exe-')); }
function touch(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
const fwd = (p) => p.split(path.sep).join('/');

test('the environment variable wins over config and PATH', () => {
  const r = ED.resolveTool('claude', { env: { BELAY_CLAUDE_EXE: 'C:/a/claude.exe', PATH: '' }, configured: 'C:/b/claude.exe' });
  assert.deepEqual(r, { path: 'C:/a/claude.exe', source: 'env' });
});

test('a configured path wins over PATH', () => {
  const r = ED.resolveTool('codex', { env: { PATH: '' }, configured: 'C:/b/codex.exe' });
  assert.deepEqual(r, { path: 'C:/b/codex.exe', source: 'config' });
});

test('a claude.exe directly on PATH is found', () => {
  const d = sandbox();
  touch(path.join(d, 'claude.exe'));
  const r = ED.resolveTool('claude', { env: { PATH: d } });
  assert.equal(r.source, 'PATH');
  assert.equal(r.path, fwd(path.join(d, 'claude.exe')));
});

test('an npm shim is followed to the package executable, never returned itself', () => {
  const d = sandbox();
  touch(path.join(d, 'claude.cmd'));
  touch(path.join(d, 'claude'));
  const real = path.join(d, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  touch(real);
  const r = ED.resolveTool('claude', { env: { PATH: `${path.join(d, 'nowhere')}${path.delimiter}${d}` } });
  assert.equal(r.path, fwd(real));
  assert.equal(r.source, 'PATH');
});

test('a shim without its package is not a hit', () => {
  const d = sandbox();
  touch(path.join(d, 'codex.cmd'));
  const r = ED.resolveTool('codex', { env: { PATH: d } });
  assert.equal(r.path, null);
});

test('nothing found: the error names the environment variable and the config key', () => {
  const r = ED.resolveTool('claude', { env: { PATH: sandbox() } });
  assert.equal(r.path, null);
  assert.match(r.error, /BELAY_CLAUDE_EXE/);
  assert.match(r.error, /claude_exe/);
  assert.throws(() => ED.exeFor('claude', { PATH: sandbox() }), /BELAY_CLAUDE_EXE/);
});

test('exportConfigured sets the variable from config unless the environment already has it', () => {
  const effective = (found, key) => ({ resolved: key === 'claude_exe' ? 'C:/cfg/claude.exe' : null });
  const env = {};
  ED.exportConfigured({}, effective, env);
  assert.equal(env.BELAY_CLAUDE_EXE, 'C:/cfg/claude.exe');
  assert.equal(env.BELAY_CODEX_EXE, undefined);
  const env2 = { BELAY_CLAUDE_EXE: 'C:/env/claude.exe' };
  ED.exportConfigured({}, effective, env2);
  assert.equal(env2.BELAY_CLAUDE_EXE, 'C:/env/claude.exe');
});

test('a relative PATH entry is ignored, even if it holds a claude.exe', () => {
  const d = sandbox();
  touch(path.join(d, 'bin', 'claude.exe'));
  const prev = process.cwd();
  process.chdir(d);
  try {
    const r = ED.resolveTool('claude', { env: { PATH: 'bin' } });
    assert.equal(r.path, null);
  } finally { process.chdir(prev); }
});

test('a miss is not cached: the same PATH finds claude once it is installed', () => {
  const d = sandbox();
  const env = { PATH: d };
  assert.throws(() => ED.exeFor('claude', env), /BELAY_CLAUDE_EXE/);
  touch(path.join(d, 'claude.exe'));
  assert.equal(ED.exeFor('claude', env), fwd(path.join(d, 'claude.exe')));
});

test('belay run with no claude executable exits 1 with no usage block before any file is created', () => {
  const { spawnSync } = require('node:child_process');
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'wt'));
  fs.writeFileSync(path.join(d, 'prompt.md'), 'hi\n');
  fs.writeFileSync(path.join(d, 'spec.json'), JSON.stringify({ worktree: path.join(d, 'wt'), prompt_file: 'prompt.md' }));
  const env = { ...process.env, PATH: sandbox() };
  delete env.BELAY_CLAUDE_EXE;
  const cli = path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
  const r = spawnSync(process.execPath, [cli, 'run', path.join(d, 'spec.json'), '--data', path.join(d, 'data')], { cwd: d, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr + r.stdout, /usage: belay run/);
  assert.match(r.stderr + r.stdout, /BELAY_CLAUDE_EXE/);
  assert.equal(fs.existsSync(path.join(d, 'data')), false, 'no data dir was created');
});
