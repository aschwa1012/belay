'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// worker-guard.test.cjs — the identity-bind stopgap: a process whose environment carries BELAY_WORKER_ID is a worker's, and the
// CLI refuses every verb that writes (each one opens the core as the operator). Read verbs still answer. Real CLI children.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const L = require('../../src/run/launch.cjs');
const G = require('../../src/cli/worker-guard.cjs');
const { COMMANDS } = require('../../src/cli/belay.cjs');

const CLI = path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const base = () => { const e = { ...process.env }; delete e.BELAY_WORKER_ID; return e; };
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env, cwd: path.join(__dirname, '..', '..') });

test('buildEnv names the worker, and only when asked; a stale marker from up-tree is dropped', () => {
  assert.strictEqual(L.buildEnv({ PATH: 'x' }, { workerId: 'w-7' }).BELAY_WORKER_ID, 'w-7');
  assert.strictEqual(L.buildEnv({ PATH: 'x', BELAY_WORKER_ID: 'w-old' }, {}).BELAY_WORKER_ID, undefined, 'an orchestrator launch inherits no marker');
  assert.strictEqual(L.buildEnv({ PATH: 'x', BELAY_WORKER_ID: 'w-old' }, { workerId: 'w-new' }).BELAY_WORKER_ID, 'w-new');
  assert.strictEqual(L.buildEnv({ PATH: 'x' }, { workerId: '' }).BELAY_WORKER_ID, undefined);
});

test('every command of mode W or C, and the memory write verbs, are refused under the marker; the read verbs are not', () => {
  const env = { BELAY_WORKER_ID: 'w-1' };
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (spec.mode === 'R') continue;
    assert.match(G.workerRefusal({ name, mode: spec.mode, argv: [], env }) || '', /refused/, `${name} (mode ${spec.mode})`);
  }
  for (const verb of ['verify', 'import', 'embed', 'restore', 'archive', 'promote', 'scrub', 'review', 'resolve', 'nonsense', undefined]) {
    assert.match(G.workerRefusal({ name: 'memory', mode: 'R', argv: verb === undefined ? [] : [verb], env }) || '', /refused/, `memory ${verb}`);
  }
  assert.match(G.workerRefusal({ name: 'doctor', mode: 'R', fix: true, env }) || '', /refused/);
  for (const verb of ['search', 'list', 'show', 'timeline', 'stats', 'export', 'proposals']) assert.strictEqual(G.workerRefusal({ name: 'memory', mode: 'R', argv: [verb], env }), null, `memory ${verb}`);
  assert.strictEqual(G.workerRefusal({ name: 'status', mode: 'R', argv: [], env }), null);
  assert.strictEqual(G.workerRefusal({ name: 'doctor', mode: 'R', fix: false, env }), null);
  assert.strictEqual(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['verify'], env: {} }), null, 'no marker, no refusal');
  assert.strictEqual(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['verify'], env: { BELAY_WORKER_ID: '' } }), null);
});

test('the built CLI: under the marker memory verify exits 1 and writes nothing; without it the same call reaches its own check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wg-'));
  try {
    const data = path.join(dir, 'data').split(path.sep).join('/');
    for (const args of [['memory', 'verify', 'x', '--status', 'verified', '--receipt', 'test:y', '--data', data], ['memory', 'archive', 'purge', '--all', '--data', data], ['stop', '--data', data], ['task', 'assign', 't', 'w', '--data', data]]) {
      const r = cli(args, { ...base(), BELAY_WORKER_ID: 'w-1' });
      assert.strictEqual(r.status, 1, args.join(' '));
      assert.match(r.stderr, /refused.*worker w-1/s);
    }
    assert.strictEqual(fs.existsSync(data), false, 'a refused verb created no data dir and elected no owner');
    const plain = cli(['memory', 'verify', 'x', '--status', 'verified', '--receipt', 'test:y', '--data', data], base());
    assert.doesNotMatch(plain.stderr, /BELAY_WORKER_ID/, 'the same call without the marker is not refused by the guard');
    const read = cli(['status', '--data', data], { ...base(), BELAY_WORKER_ID: 'w-1' });
    assert.doesNotMatch(read.stderr, /BELAY_WORKER_ID/, 'a read command answers under the marker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
