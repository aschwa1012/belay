'use strict';
// Child for utf8-split-chunks.test.cjs: loads the real adapter with process.stdin replaced by an EventEmitter and delivers one
// JSON-RPC line as two 'data' events split inside a two-byte character. Prints the adapter's reply lines as JSON on stdout.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const fake = new EventEmitter(); fake.resume = () => fake; fake.setEncoding = () => fake; fake.pause = () => fake;
Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
const out = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { out.push(String(s)); return true; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utf8split-'));
process.argv = [process.argv[0], path.join(root, 'src/mcp/belay-mcp.cjs'), '--role', 'orchestrator', '--run', 'r1', '--data', dir.split(path.sep).join('/')];
require(path.join(root, 'src/mcp/belay-mcp.cjs'));
const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x\u00e9y' }) + '\n', 'utf8');
const at = line.indexOf(0xc3) + 1;
fake.emit('data', line.subarray(0, at));
fake.emit('data', line.subarray(at));
setImmediate(() => setImmediate(() => {
  process.stdout.write = realWrite;
  process.stdout.write(JSON.stringify(out) + '\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}));
