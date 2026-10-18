'use strict';
// gpu-import-graph.test.cjs — invariant 9 for the GPU tier (ADR 0049 decision 4): only the store owner forks the
// GPU child, so no read path may reach the GPU client, the worker or the probe (the probe calls nvidia-smi and
// the worker imports a native runtime). The model table and the runtime check are pure and may be required
// by a menu or `belay doctor`. Runs in its own process, so require.cache is evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const SRC = path.join(__dirname, '..', '..', 'src');
const requiresOf = file => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
const GPU = /(^|\/)gpu(-probe|-worker|-runtime)?\.cjs$/;
const GGUF = /(^|\/)gguf-models\.cjs$/;
const rel = p => path.relative(SRC, p).split(path.sep).join('/');
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.cjs')) out.push(p); } return out; };

test('who requires which GPU module', () => {
  const by = {};
  for (const f of walk(SRC)) for (const r of requiresOf(f)) {
    const m = /(gpu(?:-probe|-worker|-runtime|-chunk)?|gguf-models)\.cjs$/.exec(r);
    if (m && /^\.\.?\//.test(r)) (by[m[1]] = by[m[1]] || []).push(rel(f));
  }
  for (const k of Object.keys(by)) by[k] = [...new Set(by[k])].sort();
  assert.deepStrictEqual(by, {
    gpu: ['core/gpu-probe.cjs'],
    'gpu-chunk': ['core/gpu-probe.cjs', 'core/gpu-worker.cjs'],
    'gpu-runtime': ['cli/cmd-embedder.cjs', 'core/gpu-probe.cjs', 'core/gpu.cjs'],
    'gguf-models': ['cli/cmd-embedder.cjs', 'core/gpu-probe.cjs', 'core/gpu.cjs'],
  }, 'gpu-worker.cjs is forked by path from gpu.cjs and required by nothing; the probe and the client are required by nothing outside the GPU modules');
});

test('cmd-embedder.cjs requires the GPU modules only inside functions, never at the top', () => {
  const text = fs.readFileSync(path.join(SRC, 'cli', 'cmd-embedder.cjs'), 'utf8');
  assert.ok(!/^(const|let|var) .*require\(['"]\.\.\/core\/(gpu|gguf)[^'"]*['"]\)/m.test(text), 'no top-level require of a GPU module');
  assert.ok(/require\('\.\.\/core\/gpu-runtime\.cjs'\)/.test(text));
});

test('the pure GPU modules need no native code and no embedding library', () => {
  const nonBuiltin = (f) => requiresOf(path.join(SRC, 'core', f)).filter(r => !r.startsWith('node:')).sort();
  assert.deepStrictEqual(nonBuiltin('gguf-models.cjs'), ['./errors.cjs', './models.cjs']);
  assert.deepStrictEqual(nonBuiltin('gpu-chunk.cjs'), []);
  assert.deepStrictEqual(nonBuiltin('gpu-runtime.cjs'), ['./errors.cjs', './lock.cjs', './model-cache.cjs', './process.cjs']);
  for (const f of ['gpu.cjs', 'gpu-probe.cjs', 'gpu-runtime.cjs', 'gpu-worker.cjs', 'gguf-models.cjs']) {
    const text = fs.readFileSync(path.join(SRC, 'core', f), 'utf8');
    assert.ok(!/require\(['"][^'"]*(embedder|embed-worker|transformers)[^'"]*['"]\)/.test(text), `${f} reaches the embedding side`);
    assert.ok(!/require\(['"]node-llama-cpp/.test(text), `${f} requires the runtime directly`);
  }
});

test('openCore, status.get and belay doctor load no GPU module', async () => {
  const loaded = () => Object.keys(require.cache).filter(k => /[\/]src[\/](core|cli)[\/](gpu[^\/]*|gguf-models)\.cjs$/i.test(k));
  assert.deepStrictEqual(loaded(), []);
  const { openCore } = core('index.cjs');
  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    await c.status.get({});
    await c.close();
    const doctor = require(path.join(SRC, 'cli', 'cmd-doctor.cjs'));
    await doctor.run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, json: true, fix: false, command: 'doctor' });
    assert.deepStrictEqual(loaded(), []);
  } finally { cleanup(dir); }
});
