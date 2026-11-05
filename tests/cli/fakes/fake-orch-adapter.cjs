'use strict';
// fake-orch-adapter.cjs — ADR 0029 amendment 1, the review's driver ported. A fake orchestrator that spawns
// the real belay-mcp orchestrator adapter from --mcp-config (detached, to escape the job that would kill it
// at once), spawns one worker through it, then behaves as fake-claude. With FAKE_E2E_KILL_ADAPTER=1 the adapter
// is terminated 350 ms after the orchestrator exits, as Claude Code does (measured, ADR 0029 context), by delayed-kill.cjs, which
// signals only the adapter's exact pid and creation time.
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
// The kill below names the adapter by pid and creation time (ADR 0039), read here while this handle holds it. A read that lands after
// the adapter exited is dropped, and without a creation time the delayed kill signals nothing.
let adapterCreated = null;
if (process.env.FAKE_E2E_KILL_ADAPTER === '1') {
  const ID = require('../../../src/core/proc-identity.cjs');
  ID.createdOf(adapter.pid).then((r) => { if (r && ID.handleLive(adapter)) { adapterCreated = r.created; log({ ev: 'adapter-created', created: r.created }); } }, () => {});
}
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
    const k = spawn(process.execPath, [require.resolve('./delayed-kill.cjs'), String(adapter.pid), String(adapterCreated), '350', OUT], { detached: true, stdio: 'ignore', windowsHide: true });
    k.unref();
  }
});
// fake-claude answers after FAKE_ANSWER_DELAY_MS, which gives the worker time to exist.
require(process.env.FAKE_E2E_FAKE_CLAUDE);
