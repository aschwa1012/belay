'use strict';
// raw-claim.cjs — a stand-in for a hostile same-user process (ADR 0045, audit D06): it sends one unkeyed request that names the
// operator, over a loopback port or a pipe, and prints the owner's one-line answer.
//   node raw-claim.cjs <port|pipe> tcp|pipe        a memory write claiming the operator
//   node raw-claim.cjs <port> search              a search of another run's namespace, a read open to every role, claiming the operator
//   node raw-claim.cjs <port> bind                 `bind.open` for a worker, claiming the operator
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

const write = () => ['memory.store', { text: 'forged as the operator', embed: false, caller: claim }];

(async () => {
  if (mode === 'pipe') { console.log(JSON.stringify(await ask(target, ...write()))); return; }
  const tcp = { host: '127.0.0.1', port: Number(target) };
  if (mode === 'tcp') { console.log(JSON.stringify(await ask(tcp, ...write()))); return; }
  if (mode === 'search') { console.log(JSON.stringify(await ask(tcp, 'memory.search', { query: 'anything', namespace: 'run/some-other-run', caller: claim }))); return; }
  if (mode === 'bind') { console.log(JSON.stringify(await ask(tcp, 'bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'forged' }, caller: claim }))); return; }
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
