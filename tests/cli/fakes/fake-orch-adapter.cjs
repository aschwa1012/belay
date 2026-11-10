'use strict';
// fake-orch-adapter.cjs — ADR 0029 amendment 1, the review's driver ported. A fake orchestrator that spawns
// the real belay-mcp orchestrator adapter from --mcp-config (detached, to escape the job that would kill it
// at once), spawns one worker through it, then behaves as fake-claude. With FAKE_E2E_KILL_ADAPTER=1 the adapter
// is terminated 350 ms after the orchestrator exits, as Claude Code does (measured, ADR 0029 context), by delayed-kill.cjs, which
// signals only the adapter's exact pid, creation time and image.
// Env (FAKE_ prefixed so the launch environment's allowlist passes them): FAKE_E2E_FAKE_CLAUDE (path of fake-claude.cjs),
// FAKE_E2E_OUT (jsonl log path), FAKE_E2E_WT (the worker's worktree), FAKE_E2E_WORKER_IGNORE_END ('1' makes the worker ignore stdin end, so its graceful stop runs to the bound).
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const at = process.argv.indexOf('--mcp-config');
const cfg = JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8'));
const srv = Object.values(cfg.mcpServers)[0];
if (srv.args.includes('worker')) { require(process.env.FAKE_E2E_FAKE_CLAUDE); return; }
srv.args.push('--log', process.env.FAKE_E2E_OUT + '.adapter.log');
const adapterEnv = { ...process.env, FAKE_IGNORE_STDIN_END: process.env.FAKE_E2E_WORKER_IGNORE_END || '' };
const adapter = spawn(srv.command, srv.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: adapterEnv, detached: true });
const OUT = process.env.FAKE_E2E_OUT;
const log = (o) => fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...o }) + '\n');
log({ ev: 'adapter-spawned', adapter_pid: adapter.pid, orch_pid: process.pid });
// The kill below names the adapter by pid, creation time and image (ADR 0039), read here while this handle holds it: from a snapshot
// (retried) whose entry for that pid has this process as its parent, so it is the adapter and not a later holder of the number. The
// fake-claude half, whose stdin end is this process's exit, starts only once the read has settled, so the exit never comes before it.
// A read that fails is logged; the delayed kill then signals nothing, and the test names why.
let adapterId = { created: null, image: null };
const identityRead = process.env.FAKE_E2E_KILL_ADAPTER !== '1' ? Promise.resolve() : (async () => {
  const ID = require('../../../src/core/proc-identity.cjs');
  const snap = await ID.snapshotRetry({ attempts: 3 }).catch(() => null);
  const e = snap && snap.get(adapter.pid);
  if (e && e.created != null && e.ppid === process.pid && ID.handleLive(adapter)) {
    adapterId = { created: e.created, image: e.image };
    log({ ev: 'adapter-created', created: e.created, image: e.image });
  } else log({ ev: 'adapter-created-failed', why: !snap ? 'no snapshot' : !e ? 'pid not in the snapshot' : e.ppid !== process.pid ? `ppid ${e.ppid}` : 'exited during the read' });
})();
adapter.stderr.on('data', (d) => log({ ev: 'adapter-stderr', s: String(d).slice(0, 300) }));
let buf = '';
const pending = new Map();
adapter.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a response */ }
  }
});
let nid = 1;
const call = (method, params) => new Promise((r) => { const id = nid++; pending.set(id, r); adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
(async () => {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const r = await call('tools/call', { name: 'worker_spawn', arguments: { substrate: 'claude-code', worktree: process.env.FAKE_E2E_WT, prompt: 'hi', worker_id: 'w-real' } });
  log({ ev: 'worker_spawn', r: JSON.stringify(r).slice(0, 600) });
})();
process.on('exit', () => {
  log({ ev: 'orch-exit' });
  if (process.env.FAKE_E2E_KILL_ADAPTER === '1') {
    const k = spawn(process.execPath, [require.resolve('./delayed-kill.cjs'), String(adapter.pid), String(adapterId.created), String(adapterId.image), '350', OUT], { detached: true, stdio: 'ignore', windowsHide: true });
    k.unref();
  }
});
// fake-claude answers after FAKE_ANSWER_DELAY_MS, which gives the worker time to exist.
identityRead.then(() => require(process.env.FAKE_E2E_FAKE_CLAUDE));
