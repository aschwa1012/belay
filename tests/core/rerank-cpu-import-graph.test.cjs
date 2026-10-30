'use strict';
// rerank-cpu-import-graph.test.cjs — invariant 9 for the CPU rerank tier (ADR 0050 decision 5): only the store owner
// forks the rerank child, so no read path may reach the client or the worker (the worker imports the embedding
// library and an onnx runtime). The pin table and the arithmetic are pure and may be required by a menu, the levers or
// `belay doctor`. Runs in its own process, so require.cache is evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const SRC = path.join(__dirname, '..', '..', 'src');
const requiresOf = file => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
const rel = p => path.relative(SRC, p).split(path.sep).join('/');
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.cjs')) out.push(p); } return out; };

test('who requires which CPU rerank module', () => {
  const by = {};
  for (const f of walk(SRC)) for (const r of requiresOf(f)) {
    const m = /(rerank-cpu|rerank-worker|rerank-pure|onnx-rerankers)\.cjs$/.exec(r);
    if (m && /^\.\.?\//.test(r)) (by[m[1]] = by[m[1]] || []).push(rel(f));
  }
  for (const k of Object.keys(by)) by[k] = [...new Set(by[k])].sort();
  // When the store owner (or the rerank provider registry) starts to require rerank-cpu.cjs, add that file here:
  // the point of the check is that the list is short and names no read path.
  assert.deepStrictEqual(by, {
    'rerank-cpu': ['core/rerank-provider.cjs'],
    'rerank-pure': ['core/rerank-worker.cjs'],
    // memory-menu.cjs reads the pure pin table to list the CPU rerankers in the Memory menu; the table needs no native code.
    'onnx-rerankers': ['cli/cmd-embedder.cjs', 'core/memory-menu.cjs', 'core/rerank-cpu.cjs', 'core/rerank-provider.cjs', 'core/retrieval-profiles.cjs'],
  }, 'rerank-worker.cjs is forked by path from rerank-cpu.cjs and required by nothing; rerank-cpu.cjs is required by the provider registry alone, lazily');
});

test('no read path, command or MCP module requires the client or the worker; cmd-embedder.cjs requires the table only', () => {
  for (const f of walk(SRC)) {
    const r = rel(f);
    if (!/^(cli|mcp|run)\//.test(r)) continue;
    for (const dep of requiresOf(f)) assert.ok(!/rerank-(cpu|worker)\.cjs$/.test(dep), `${r} requires ${dep}`);
  }
  for (const f of ['status.cjs', 'doctor.cjs', 'memory-levers.cjs', 'retrieval-profiles.cjs', 'retrieval-routing.cjs', 'models.cjs', 'model-cache.cjs']) {
    const p = path.join(SRC, 'core', f);
    if (fs.existsSync(p)) for (const dep of requiresOf(p)) assert.ok(!/rerank-(cpu|worker)\.cjs$/.test(dep), `core/${f} requires ${dep}`);
  }
});

test('the pure modules need no native code and no embedding library; the client and worker never require the embedder or the GPU side', () => {
  const nonBuiltin = (f) => requiresOf(path.join(SRC, 'core', f)).filter(r => !r.startsWith('node:')).sort();
  assert.deepStrictEqual(nonBuiltin('onnx-rerankers.cjs'), ['./errors.cjs', './models.cjs']);
  assert.deepStrictEqual(nonBuiltin('rerank-pure.cjs'), []);
  assert.deepStrictEqual(nonBuiltin('rerank-worker.cjs'), ['./rerank-pure.cjs']);
  assert.deepStrictEqual(nonBuiltin('rerank-cpu.cjs'), ['./errors.cjs', './model-cache.cjs', './onnx-rerankers.cjs', './process.cjs']);
  for (const f of ['rerank-cpu.cjs', 'rerank-worker.cjs', 'rerank-pure.cjs', 'onnx-rerankers.cjs']) {
    const text = fs.readFileSync(path.join(SRC, 'core', f), 'utf8');
    assert.ok(!/require\(['"][^'"]*(embedder|embed-worker|transformers|gpu|gguf)[^'"]*['"]\)/.test(text), `${f} reaches the embedder or GPU side`);
  }
  assert.ok(!/require\(['"][^'"]*transformers/.test(fs.readFileSync(path.join(SRC, 'core', 'rerank-worker.cjs'), 'utf8')), 'the worker imports the package by path, as embedder-core does');
});

test('the provider registry requires rerank-cpu only inside a function, never at the top of the file', () => {
  const text = fs.readFileSync(path.join(SRC, 'core', 'rerank-provider.cjs'), 'utf8');
  const found = [...text.matchAll(/^.*require\(['"]\.\/rerank-cpu\.cjs['"]\).*$/gm)];
  assert.strictEqual(found.length, 1);
  assert.match(found[0][0], /^\s+/, `a top-level require: ${found[0][0]}`);
});

test('openCore, status.get, belay doctor and the retrieval levers load neither the rerank client nor its worker', async () => {
  const loaded = () => Object.keys(require.cache).filter(k => /[\\/]src[\\/]core[\\/]rerank-(cpu|worker)\.cjs$/i.test(k)); // the class takes either slash: Windows cache keys use backslashes
  assert.deepStrictEqual(loaded(), []);
  core('onnx-rerankers.cjs'); core('retrieval-profiles.cjs'); core('memory-levers.cjs');
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
