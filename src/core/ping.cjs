'use strict';
// ping.cjs — one bounded request and response over the pipe, and nothing else.
//
// ADR 0005 §4: a pipe is alive only if it answers. On Windows a client's connect to a wedged server
// completes at the OS level even though the server's code never runs, so a bare connect is not
// evidence. Every liveness rung and the owner-first read path go through this: connect, write, read
// one line, all under one deadline.
//
// Deliberately dependency-free (net, plus the pipe name) so status.get can reach owner liveness without
// pulling in the store, the owner or the embedder.

const net = require('node:net');
const { pipeName } = require('./lock.cjs');

function request(dataDir, method, params, timeoutMs) {
  const pipe = pipeName(dataDir);
  return new Promise(resolve => {
    const t0 = Date.now();
    let sock = null, settled = false, buf = '';
    const finish = out => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (sock) { if (out.code === 'E_TIMEOUT') sock.unref(); sock.destroy(); } } catch { /* already gone */ }
      resolve({ ...out, ms: Date.now() - t0, pipe });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', code: 'E_TIMEOUT' }), timeoutMs);
    timer.unref();
    try {
      sock = net.connect(pipe);
    } catch (e) { return finish({ ok: false, reason: e.code || e.message, code: 'E_NO_OWNER' }); }
    sock.once('connect', () => { try { sock.write(JSON.stringify({ id: 1, method, params: params || {} }) + '\n'); } catch (e) { finish({ ok: false, reason: e.code || e.message, code: 'E_OWNER_LOST' }); } });
    sock.on('data', d => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, i)); } catch { return finish({ ok: false, reason: 'unparseable response', code: 'E_OWNER_LOST' }); }
      if (msg.error) return finish({ ok: false, reason: msg.error.message, code: msg.error.code, error: msg.error });
      finish({ ok: true, result: msg.result });
    });
    sock.once('error', e => finish({ ok: false, reason: e.code || e.message, code: 'E_NO_OWNER' }));
    sock.once('close', () => finish({ ok: false, reason: 'the owner closed the pipe before answering', code: 'E_OWNER_LOST' }));
  });
}

const ping = (dataDir, timeoutMs = 300) => request(dataDir, 'ping', {}, timeoutMs);

module.exports = { request, ping };
