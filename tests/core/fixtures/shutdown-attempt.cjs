'use strict';
// shutdown-attempt.cjs — one process that opens a Core with the role named on its argv and tries to
// stop the owner over the pipe. Prints one line of JSON saying what came back. The role has to come
// from a separate process for the test to mean anything: in-process a Core could be handed any caller,
// but here the identity is argv, the pipe is real, and the owner sees only what the client sent.
const path = require('node:path');
const { openCore } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'index.cjs'));

const [dataDir, role, workerId] = process.argv.slice(2);

(async () => {
  const caller = { role, run_id: 'shutdown-probe', pid: process.pid };
  if (role === 'worker') caller.worker_id = workerId || 'w-probe';
  const core = await openCore({ dataDir, caller, embed: false });
  try {
    const r = await core.shutdownOwner();
    process.stdout.write(JSON.stringify({ ok: true, role, result: r }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, role, code: e.code, message: e.message, detail: e.detail || null }) + '\n');
  } finally { await core.close(); }
})().catch(e => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });
