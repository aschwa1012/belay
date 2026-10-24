'use strict';
// forge-from-worker.cjs — what a worker's Bash can do against the run's owner (ADR 0045, audit D06), as a script the fake Claude
// starts as its child. Env: FORGE_DATA_DIR, FORGE_RUN_ID, FORGE_WORKER_ID, FORGE_OUT (a JSON file written when every attempt has an answer).
// Every attempt is an unkeyed request that names a role it was not given, on the pipe and on the loopback port, plus the real
// CLI's own `stop` and `worker kill` with the worker marker removed (the marker is only the stopgap; the owner's refusal is the boundary).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { readOwnerLock, pipeName } = require(path.join(ROOT, 'src/core/lock.cjs'));
const dataDir = process.env.FORGE_DATA_DIR;
const runId = process.env.FORGE_RUN_ID;

function ask(arg, method, params) {
  return new Promise((resolve) => {
    const s = net.connect(arg);
    let buf = '';
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ error: { code: 'E_TIMEOUT', message: 'no answer in 30 s' } }), 30000);
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); done(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', (e) => { clearTimeout(timer); done({ error: { code: 'E_CONN', message: e.message } }); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params }) + '\n'));
  });
}

(async () => {
  const lock = readOwnerLock(dataDir) || {};
  const pipe = pipeName(dataDir);
  const tcp = { host: '127.0.0.1', port: lock.tcp_port };
  const op = { role: 'operator', run_id: runId, pid: process.pid };
  const results = [];
  const note = (attempt, r) => results.push({ attempt, ok: !r.error, code: r.error ? r.error.code : null, reason: r.error && r.error.detail ? r.error.detail.reason || null : null, message: r.error ? r.error.message : null, written_by: r.result && r.result.written_by });
  note('pipe: memory.store as operator', await ask(pipe, 'memory.store', { text: 'forged on the pipe', embed: false, caller: op }));
  note('pipe: memory.store as orchestrator', await ask(pipe, 'memory.store', { text: 'forged as the orchestrator', embed: false, caller: { ...op, role: 'orchestrator' } }));
  note('pipe: bind.open as operator', await ask(pipe, 'bind.open', { identity: { role: 'orchestrator', run_id: runId }, caller: op }));
  note('pipe: run.stop as operator', await ask(pipe, 'run.stop', { run_id: runId, caller: op }));
  note('tcp: memory.store as operator', await ask(tcp, 'memory.store', { text: 'forged on the port', embed: false, caller: op }));
  note('tcp: bind.open as operator', await ask(tcp, 'bind.open', { identity: { role: 'orchestrator', run_id: runId }, caller: op }));
  note('tcp: run.stop as operator', await ask(tcp, 'run.stop', { run_id: runId, caller: op }));
  // the CLI itself, as a worker's Bash would run it, with the marker stripped
  const env = { ...process.env }; delete env.BELAY_WORKER_ID;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/belay.cjs'), 'stop', runId, '--data', dataDir, '--json'], { env, encoding: 'utf8', windowsHide: true });
  let rec = null; try { rec = JSON.parse(r.status === 0 ? r.stdout : r.stderr); } catch { /* left null */ }
  results.push({ attempt: 'cli: belay stop without the marker', ok: r.status === 0, status: r.status, code: rec && rec.error ? rec.error.code : null, message: rec && rec.error ? rec.error.message : String(r.stderr).slice(0, 400) });
  // `worker kill` signals the worker's pid itself, so the owner never sees the request: the CLI asks the owner to vouch for it first
  const wid = process.env.FORGE_WORKER_ID;
  if (wid) {
    const k = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/belay.cjs'), 'worker', 'kill', wid, '--data', dataDir, '--json'], { env, encoding: 'utf8', windowsHide: true });
    let krec = null; try { krec = JSON.parse(k.status === 0 ? k.stdout : (k.stdout || k.stderr)); } catch { /* left null */ }
    results.push({ attempt: 'cli: belay worker kill without the marker', ok: k.status === 0, status: k.status, code: krec && krec.killed === false ? 'REFUSED' : null, killed: krec ? krec.killed : null, message: krec && krec.reason ? krec.reason : String(k.stderr).slice(0, 400) });
  }
  fs.writeFileSync(process.env.FORGE_OUT, JSON.stringify(results));
})();
