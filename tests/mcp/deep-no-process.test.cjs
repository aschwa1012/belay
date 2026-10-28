'use strict';
// deep-no-process.test.cjs — an adapter asked only `initialize` and `tools/list` (what `belay mcp status --deep` asks) takes no process
// snapshot, so it starts no PowerShell and creates no snapshot TEMP: the creation-time probe for run.attach starts when the client sends
// `notifications/initialized`, as an MCP client does before any tool call. A snapshot creates <TEMP>/belay-snapshot synchronously when it
// starts its PowerShell (src/core/proc-identity.cjs snapshotEnv), so each adapter gets its own TEMP and the directory is the evidence;
// BELAY_SNAPSHOT_LOG records the finished snapshot. Each adapter is ended by closing its stdin and waited for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { launch, sandboxDir } = require('./rpc.cjs');

const until = async (cond, ms) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return cond(); };

test('initialize and tools/list take no snapshot; notifications/initialized starts the probe', async () => {
  const dir = sandboxDir('deep');
  const quiet = `${dir}/quiet.log`;
  const tmpA = `${dir}/tmp-a`;
  fs.mkdirSync(tmpA);
  const a = launch({ data: `${dir}/data`, env: { BELAY_SNAPSHOT_LOG: quiet, TEMP: tmpA, TMP: tmpA } });
  await a.initialize();
  assert.ok((await a.list()).length > 0);
  await a.close();
  assert.strictEqual(fs.existsSync(`${tmpA}/belay-snapshot`), false, 'a snapshot was started');
  assert.strictEqual(fs.existsSync(quiet), false, 'a snapshot was taken');

  const busy = `${dir}/busy.log`;
  const b = launch({ data: `${dir}/data`, env: { BELAY_SNAPSHOT_LOG: busy } });
  await b.initialize();
  b.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const took = await until(() => fs.existsSync(busy), 30000);
  await b.close();
  assert.ok(took, 'the probe did not start on notifications/initialized');
});
