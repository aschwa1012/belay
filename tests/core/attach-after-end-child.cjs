'use strict';
// A separate process standing in for an orchestrator adapter whose first core calls land after the run ended
// (attach-after-end.test.cjs). argv: data dir, run id. It tries a worker write and an attach as the orchestrator role and
// prints one JSON line: the error code of each, or "ok". It never elects when the guard holds, so it leaves no owner behind.
process.env.BELAY_TEST_MODE = '1';
const { openCore } = require('../../src/core/index.cjs');

(async () => {
  const [dataDir, runId] = process.argv.slice(2);
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  const out = {};
  const attempt = async (name, fn) => { try { await fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
  await attempt('worker', () => core.worker.write({ id: 'w-stray', substrate: 'claude-code', pid: process.pid, pid_image: 'node.exe', state: 'running', turns: 0, started_at: Date.now() }));
  await attempt('attach', () => core.run.attach({ adapter_pid: process.pid }));
  out.isOwner = core.isOwner();
  process.stdout.write(JSON.stringify(out) + '\n');
  try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
  try { await core.close(); } catch { /* best effort */ }
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ crashed: String(e && e.message) }) + '\n'); process.exit(1); });
