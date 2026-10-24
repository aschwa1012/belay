'use strict';
// A minimal stdio MCP server: just enough of the protocol for Claude Code to connect and list one
// tool, so a launched worker really has an MCP child process. Used by the subtree measurement,
// which needs a grandchild to ask whether it dies with its parent. It is not belay's adapter.
const fs = require('node:fs');

const LOG = process.argv.includes('--log') ? process.argv[process.argv.indexOf('--log') + 1] : null;
const log = (s) => { if (LOG) try { fs.appendFileSync(LOG, s + '\n'); } catch { /* best effort */ } };
log(JSON.stringify({ at: Date.now(), event: 'start', pid: process.pid, argv: process.argv }));

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    log(JSON.stringify({ at: Date.now(), in: m.method, id: m.id }));
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.1' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    } else if (m.method && m.method.startsWith('notifications/')) {
      // no response for notifications
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
process.stdin.on('end', () => { log(JSON.stringify({ at: Date.now(), event: 'stdin-end' })); process.exit(0); });
process.stdin.resume();
