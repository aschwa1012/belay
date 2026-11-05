'use strict';
require('../helpers/tmp.cjs');
// panel-read-store.test.cjs — one real `belay panel-read` round against a sandbox store (invariant 6: reading never writes).
// panel-read.test.cjs drives the verb with fake reads; this runs the built CLI as a process over a planted store and compares every
// byte of the data dir before and after, so a part that opened the store in a way that writes would show.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openCore } = require('../../src/core/index.cjs');

const CLI = path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const RUN = 'run-panel-read';
let dir = null;
let dataDir = null;

// Every file under dir, by relative path, with its size and sha256: a changed byte, a new file or a removed one all show.
function fingerprint(root) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${d}/${e.name}`, r);
      else { const b = fs.readFileSync(`${d}/${e.name}`); out[r] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex')}`; }
    }
  })(root, '');
  return out;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-panel-read-')).split(path.sep).join('/');
  dataDir = `${dir}/.belay`;
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', turns: 0, started_at: Date.now() });
    await core.task.create({ spec: 'a task for the panel to read' });
  } finally {
    await core.shutdownOwner();
    await core.close();
  }
});

after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('a real panel-read round reads the store and changes no byte of the data dir', () => {
  const before = fingerprint(dataDir);
  assert.ok(Object.keys(before).length > 0, 'the planted store has files');
  const r = spawnSync(process.execPath, [CLI, 'panel-read', RUN, '--settings', '--tail', '10', '--data', dataDir, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 20000, cwd: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.parts.agents && doc.parts.agents.json, `the agents part came back: ${JSON.stringify(doc.parts.agents)}`);
  assert.ok(doc.parts.notices && doc.parts.notices.json, `the notices part came back: ${JSON.stringify(doc.parts.notices)}`);
  assert.deepStrictEqual(fingerprint(dataDir), before, 'panel-read changed the data dir (a file added, removed or rewritten)');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.belay'], 'and made no file beside it');
});

test('--tail above the transcript verb\'s own cap of 1000 is a usage error before any read', () => {
  const r = spawnSync(process.execPath, [CLI, 'panel-read', RUN, '--tail', '5000', '--data', dataDir], { encoding: 'utf8', windowsHide: true, timeout: 20000, cwd: dir });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /--tail needs a whole number from 1 to 1000/);
});
