'use strict';
// cmd-wake-stream.cjs — ADR 0037 amendment 5 decision 2. Mode R: connects to the run's wake pipe (the
// interactive launcher's publisher, src/run/wake-pipe.cjs) and prints each line it sends as it arrives.
// It opens no store, starts no process and writes no file. It sends nothing: the pipe accepts no input.
// It exits 0 when the pipe closes, and 1 when no line (the publisher's heartbeat is one, every 5 s)
// arrives for 15 s, which includes never connecting at all (invariant 7: a pipe is alive only if it
// answers). The belay mod spawns this verb and reads its stdout.

const net = require('node:net');
const { StringDecoder } = require('node:string_decoder');

const HEARTBEAT_TIMEOUT_MS = 15000;
const USAGE = 'usage: belay wake-stream --run <id> --nonce <n> [--heartbeat-timeout-ms <n>] [--data <dir>]\n';

const usageError = (message) => ({ code: 2, text: `belay wake-stream: ${message}\n\n${USAGE}`, json: { error: message } });

function parseArgs(argv) {
  let runId = null;
  let nonce = null;
  let timeoutMs = HEARTBEAT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') { runId = argv[i += 1]; if (!runId || runId.startsWith('-')) return { error: '--run needs a run id' }; continue; }
    if (a === '--nonce') { nonce = argv[i += 1]; if (!nonce || nonce.startsWith('-')) return { error: '--nonce needs a value' }; continue; }
    if (a === '--heartbeat-timeout-ms') {
      const n = Number(argv[i += 1]);
      if (!Number.isInteger(n) || n <= 0) return { error: '--heartbeat-timeout-ms needs a positive integer' };
      timeoutMs = n; continue;
    }
    return { error: `unexpected argument ${a}` };
  }
  if (!runId) return { error: '--run <id> is required' };
  if (!nonce) return { error: '--nonce <n> is required' };
  return { runId, nonce, timeoutMs };
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);
  const { wakePipeName } = require('../run/wake-pipe.cjs');
  // The store directory is found as every other command finds it (--data, then the config's data_dir, then <project root>/.belay):
  // the launcher names its pipe from that directory. config.cjs reads files only; it starts nothing and writes nothing.
  const C = require('./config.cjs');
  const seam = ctx.wakeStreamDeps && ctx.wakeStreamDeps.pipe;
  const pipe = seam || wakePipeName(C.dataDirOf(C.discover(ctx.cwd || process.cwd()), ctx), parsed.runId, parsed.nonce);
  const out = ctx.emit || ((t) => { process.stdout.write(t); });
  const started = Date.now();
  return new Promise((resolve) => {
    let buf = '';
    let lines = 0;
    let done = false;
    let timer = null;
    const sock = net.connect(pipe);
    const finish = (code, text, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* gone */ }
      resolve({ code, text, json: { run_id: parsed.runId, pipe, lines, ended: reason, ms: Date.now() - started } });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(1, `belay wake-stream: no line from ${pipe} for ${parsed.timeoutMs} ms\n`, 'no heartbeat'), parsed.timeoutMs);
    };
    arm();
    const dec = new StringDecoder('utf8');
    sock.on('data', (d) => {
      arm();
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) { lines += 1; out(`${line}\n`); }
      }
    });
    sock.on('error', (e) => finish(1, `belay wake-stream: ${(e && e.code) || (e && e.message) || e} on ${pipe}\n`, 'error'));
    sock.on('close', () => finish(0, '', 'pipe closed'));
  });
}

module.exports = { run, parseArgs, HEARTBEAT_TIMEOUT_MS };
