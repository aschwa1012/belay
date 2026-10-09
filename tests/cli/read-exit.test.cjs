'use strict';
// read-exit.test.cjs — a mode-R verb exits once its output has drained, even when the owner's event
// loop is blocked. The fixture (fakes/wedged-owner.cjs) is a live pid on the owner's pipe that never
// answers; from about the fifth dial libuv waits in WaitNamedPipeW for up to 30 s on a thread the dial
// timer cannot cancel, and without the dispatcher's exit the process lingers that long. Every write is
// in a temp sandbox.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');
const { finish, COMMANDS } = require('../../src/cli/belay.cjs');

const WEDGED = `${ROOT}/tests/cli/fakes/wedged-owner.cjs`;
const EXIT_BOUND_MS = 3000;

function startWedged(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WEDGED, dataDir], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    child.once('error', reject);
    child.once('exit', c => reject(new Error(`wedged owner exited early (${c})`)));
    child.stdout.once('data', () => { child.removeAllListeners('exit'); resolve(child); });
  });
}

test('read verbs exit within the bound against a wedged owner, with their full output', async () => {
  const dir = sandbox();
  const owner = await startWedged(dir);
  try {
    const baseline = {};
    for (const verb of ['status', 'workers']) {
      // 7 runs: past the fifth dial, where the stall begins.
      for (let i = 0; i < 7; i += 1) {
        const t0 = Date.now();
        const r = spawnSync(process.execPath, [CLI, verb, '--data', dir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 120000 });
        const ms = Date.now() - t0;
        assert.ok(ms < EXIT_BOUND_MS, `${verb} run ${i + 1} took ${ms} ms (bound ${EXIT_BOUND_MS})`);
        assert.ok(r.status === 0 || r.status === 1, `${verb} exit code ${r.status}, signal ${r.signal}`);
        const out = r.status === 0 ? r.stdout : r.stderr;
        assert.ok(out.length > 0, `${verb} printed nothing`);
        if (r.status === 0) JSON.parse(r.stdout); // complete, parseable output
        // The exit code is stable and the output is complete. Its exact length is not: the status rung's
        // text depends on whether this process's read dial timed out (marked, "no ping sent until") or the
        // saturated fixture pipe refused it (E_NO_OWNER, so the rung pings and reports "timeout"), and the
        // fixture's pending-connect count grows with each run. So compare length within a band, not equal.
        if (!baseline[verb]) baseline[verb] = { code: r.status, len: out.length };
        assert.strictEqual(r.status, baseline[verb].code, `${verb} exit code changed between runs`);
        assert.ok(out.length > baseline[verb].len * 0.75 && out.length < baseline[verb].len * 1.25,
          `${verb} output length ${out.length} is outside the band around the first run's ${baseline[verb].len} (truncated?)`);
        if (verb === 'status' && r.status === 0) {
          const owner = JSON.parse(r.stdout).rungs.find(x => x.rung === 'owner-alive');
          assert.ok(owner && owner.established === false, 'a wedged owner is never reported alive');
        }
      }
    }
  } finally {
    owner.kill();
    cleanup(dir);
  }
});

test('end to end: a large output is complete after the early exit (a piped stdout is synchronous on Windows, so this does not prove draining)', async () => {
  const script = `${sandbox()}/big.cjs`;
  const dirOfScript = script.slice(0, script.lastIndexOf('/'));
  require('node:fs').writeFileSync(script, [
    `const { finish } = require(${JSON.stringify(`${ROOT}/src/cli/belay.cjs`)});`,
    `const line = 'x'.repeat(1023) + '\\n';`,
    `for (let i = 0; i < 3072; i += 1) process.stdout.write(line);`,
    `for (let i = 0; i < 256; i += 1) process.stderr.write(line);`,
    `finish(['agents'], 0);`,
  ].join('\n'));
  try {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = 0, errBytes = 0;
    child.stdout.pause(); child.stderr.pause();
    await new Promise(r => setTimeout(r, 500)); // the reader is slow: nothing is consumed yet
    child.stdout.on('data', d => { out += d.length; });
    child.stderr.on('data', d => { errBytes += d.length; });
    child.stdout.resume(); child.stderr.resume();
    const code = await new Promise(r => child.once('close', r));
    assert.strictEqual(code, 0);
    assert.strictEqual(out, 3072 * 1024);
    assert.strictEqual(errBytes, 256 * 1024);
  } finally {
    cleanup(dirOfScript);
  }
});

// Unit tests of finish through its io seam: fake streams whose write callbacks fire late, a stub exit.
function fakeIo() {
  const log = [];
  const stream = name => ({ write(_chunk, cb) { setTimeout(() => { log.push(`${name} written`); cb(); }, 50); return true; } });
  return { log, io: { stdout: stream('stdout'), stderr: stream('stderr'), exit: c => log.push(`exit ${c}`) } };
}

test('finish exits only after both streams have called back', async () => {
  const { log, io } = fakeIo();
  const p = finish(['status'], 0, io);
  assert.deepStrictEqual(log, [], 'no exit before the callbacks');
  await p;
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[2], 'exit 0');
  assert.deepStrictEqual(log.slice(0, 2).sort(), ['stderr written', 'stdout written']);
});

test('finish exits for a mode-R verb and never for a write or control verb', async () => {
  for (const verb of ['run', 'init', 'stop', 'settings']) {
    const { log, io } = fakeIo();
    await finish([verb], 0, io);
    assert.deepStrictEqual(log, [], `${verb} must keep its natural exit`);
  }
  const { log, io } = fakeIo();
  await finish(['status'], 0, io);
  assert.ok(log.includes('exit 0'));
});

test('finish exits for every mode-R entry in COMMANDS', async () => {
  const rs = Object.entries(COMMANDS).filter(([, c]) => c.mode === 'R').map(([n]) => n);
  assert.ok(rs.length >= 10, 'the table has its read verbs');
  for (const verb of rs) {
    const { log, io } = fakeIo();
    await finish([verb, '--data', 'x'], 0, io);
    assert.ok(log.includes('exit 0'), `${verb} did not exit`);
  }
});
