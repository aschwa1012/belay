'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// worker-guard-reads.test.cjs — under BELAY_WORKER_ID the guard refuses what writes and lets what reads answer: `settings` and
// `settings <key>` read the config and answer; `settings <key> <value>` writes it and is refused; `memory export` to stdout reads,
// `memory export --out <file>` writes that file as the operator and is refused, leaving no file. Built CLI, mkdtemp sandbox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const G = require('../../src/cli/worker-guard.cjs');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const env = { BELAY_WORKER_ID: 'w9' };

test('the guard: settings reads answer, its write is refused; export --out is refused, export to stdout answers', () => {
  assert.strictEqual(G.workerRefusal({ name: 'settings', mode: 'W', argv: [], env }), null);
  assert.strictEqual(G.workerRefusal({ name: 'settings', mode: 'W', argv: ['mod.pane'], env }), null);
  assert.match(G.workerRefusal({ name: 'settings', mode: 'W', argv: ['mod.pane', 'off'], env }), /^belay settings: refused/);
  assert.strictEqual(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['export'], env }), null);
  assert.strictEqual(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['export', 'run-1', '--all'], env }), null);
  assert.match(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['export', '--out', 'x.jsonl'], env }), /^belay memory export: refused/);
  assert.match(G.workerRefusal({ name: 'memory', mode: 'R', argv: ['export', '--bogus'], env }), /refused/, 'a form the parser rejects is refused');
  assert.strictEqual(G.workerRefusal({ name: 'settings', mode: 'W', argv: ['mod.pane', 'off'], env: {} }), null);
});

test('the built CLI under the marker: settings answers, export --out writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-reads-')).split(path.sep).join('/');
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, BELAY_WORKER_ID: 'w9' }, encoding: 'utf8', timeout: 60000 });
  const s = run(['settings', '--data', `${dir}/data`]);
  assert.strictEqual(s.status, 0, s.stderr);
  const e = run(['memory', 'export', '--out', `${dir}/exp.jsonl`, '--data', `${dir}/data`]);
  assert.strictEqual(e.status, 1, e.stderr);
  assert.match(e.stderr, /refused/);
  assert.strictEqual(fs.existsSync(`${dir}/exp.jsonl`), false);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing was created in the sandbox');
});
