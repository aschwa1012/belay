'use strict';
// owner-tcp.cjs — ADR 0045 decision 4: the loopback listener a `bound` owner serves its operator on. A named pipe does not tell the
// owner which process dialled it; a loopback TCP connection does (operator-check.cjs reads the connection table). The listener binds
// 127.0.0.1 on an ephemeral port that owner.lock publishes beside the pipe. It speaks the same protocol as the pipe and reaches the
// same dispatcher; the only difference is the transport mark on each connection, which is the one thing the operator check requires.

const net = require('node:net');

// -> Promise<net.Server>, listening. `owner._conn` is the pipe's own connection handler.
function listenTcp(owner) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((c) => { c.belayTransport = 'tcp'; owner._conn(c); });
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => { server.removeListener('error', reject); server.on('error', () => { /* a listener that fails after listening cannot be repaired */ }); resolve(server); });
  });
}

module.exports = { listenTcp };
