'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm
// run-register.test.cjs — ADR 0045 decision 4, the headless orchestrator's record in the machine-wide spawn register. A register
// that cannot be written must not leave the orchestrator running unrecorded: another store's owner would take its descendants for
// operators. `belay run` ends the child by its exact pid before it is attached or sent its prompt, and the run fails.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const { sandbox, cleanup, makeSpec } = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

test('run: a headless orchestrator that cannot be recorded in the spawn register is ended before its prompt and the run fails', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { startup_timeout_ms: 30000 });
  const blocker = `${dir}/not-a-directory`;
  fs.writeFileSync(blocker, 'x');
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_SPAWN_REGISTRY: `${blocker}/registry` }, // a directory under a file: no record can be written
    });
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stdout: ${r.stdout}; stderr: ${r.stderr}`);
    const receipt = JSON.parse(r.stderr);
    assert.match(receipt.ended_by, /could not be recorded in the spawn register/, receipt.ended_by);
    assert.ok(!receipt.attach, 'the run was attached to an unrecorded orchestrator: ' + JSON.stringify(receipt.attach));
    assert.ok(Number.isInteger(receipt.orchestrator.pid), JSON.stringify(receipt.orchestrator));
    assert.strictEqual(P.pidAlive(receipt.orchestrator.pid), false, 'the unrecorded orchestrator is still running');
    // the prompt never reached it: a stream-json session answers a user message with a system/init event, and there is none
    const stream = fs.readdirSync(orchestratorDir).filter((n) => /stream/.test(n)).map((n) => fs.readFileSync(`${orchestratorDir}/${n}`, 'utf8')).join('');
    assert.ok(!/"type":"system"/.test(stream), `the orchestrator answered a prompt: ${stream.slice(0, 300)}`);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present');
    assert.ok(runId);
  } finally { cleanup(dir); }
});
