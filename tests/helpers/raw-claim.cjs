'use strict';
// raw-claim.cjs — a stand-in for a hostile same-user process (ADR 0045, audit D06): it sends one unkeyed request that names the
// operator, over a loopback port or a pipe, and prints the owner's one-line answer.
//   node raw-claim.cjs <port|pipe> tcp|pipe        a memory write claiming the operator
//   node raw-claim.cjs <port> search              a search of another run's namespace, a read open to every role, claiming the operator
//   node raw-claim.cjs <port> bind                 `bind.open` for a worker, claiming the operator
//   node raw-claim.cjs <port> orch-bind            `bind.open` for the run's orchestrator, claiming the operator
//   node raw-claim.cjs <port> run-stop             `run.stop`, claiming the operator
//   node raw-claim.cjs <port> orphan <outfile>     start a detached copy of `tcp`, wait for this process to exit, and let the copy
//                                                  write its answer to <outfile>: the copy's parent is gone, the way a worker's detached
//                                                  process escapes an ancestry check

const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [, , target, mode, outFile] = process.argv;
const RUN = 'run-opcheck';
const claim = { role: 'operator', run_id: RUN, pid: process.pid };

function ask(connectArg, method, params) {
  return new Promise((resolve) => {
    const s = net.connect(connectArg);
    let buf = '';
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ error: { code: 'E_TIMEOUT', message: 'no answer in 20 s' } }), 20000);
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); done(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', (e) => { clearTimeout(timer); done({ error: { code: 'E_CONN', message: e.message } }); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params }) + '\n'));
  });
}

// Two requests on ONE connection, the way Client.call does for a read the anonymous role may not make: ask to be checked (a ping with
// verify_operator), then make the call. A verdict belongs to the connection, so both must travel on it. -> the second answer.
const NL = String.fromCharCode(10);
function askVerified(connectArg, method, params) {
  return new Promise((resolve) => {
    const s = net.connect(connectArg);
    let buf = '';
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ error: { code: 'E_TIMEOUT', message: 'no answer in 30 s' } }), 30000);
    let sentSecond = false;
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split(NL);
      if (!sentSecond && lines.length > 1) { sentSecond = true; s.write(JSON.stringify({ id: 2, method, params }) + NL); } // after the check's answer, as Client.call does
      if (lines.length > 2 && lines[1]) { clearTimeout(timer); done(JSON.parse(lines[1])); }
    });
    s.on('error', (e) => { clearTimeout(timer); done({ error: { code: 'E_CONN', message: e.message } }); });
    s.on('connect', () => {
      s.write(JSON.stringify({ id: 1, method: 'ping', params: { caller: claim, verify_operator: true } }) + NL);
    });
  });
}

const write = () => ['memory.store', { text: 'forged as the operator', embed: false, caller: claim }];

(async () => {
  if (mode === 'pipe') { console.log(JSON.stringify(await ask(target, ...write()))); return; }
  const tcp = { host: '127.0.0.1', port: Number(target) };
  if (mode === 'tcp') { console.log(JSON.stringify(await ask(tcp, ...write()))); return; }
  if (mode === 'search') { console.log(JSON.stringify(await askVerified(tcp, 'memory.search', { query: 'anything', namespace: 'run/some-other-run', caller: claim }))); return; }
  if (mode === 'bind') { console.log(JSON.stringify(await ask(tcp, 'bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'forged' }, caller: claim }))); return; }
  if (mode === 'orch-bind') { console.log(JSON.stringify(await ask(tcp, 'bind.open', { identity: { role: 'orchestrator', run_id: RUN }, caller: claim }))); return; }
  if (mode === 'run-stop') { console.log(JSON.stringify(await ask(tcp, 'run.stop', { run_id: RUN, caller: claim }))); return; }
  if (mode === 'orphan-child') {
    const parent = Number(outFile.split('|')[1]);
    for (let i = 0; i < 400; i++) { try { process.kill(parent, 0); await new Promise((r) => setTimeout(r, 50)); } catch { break; } }
    fs.writeFileSync(outFile.split('|')[0], JSON.stringify(await ask(tcp, ...write())));
    return;
  }
  if (mode === 'orphan') {
    const kid = spawn(process.execPath, [__filename, target, 'orphan-child', `${outFile}|${process.pid}`], { windowsHide: true, stdio: 'ignore', detached: true });
    kid.unref();
  }
})();
