// rpc.cjs — spawns the adapter as a child process and drives it over stdio, the way Claude Code and
// Codex do. Every child is killed by its exact pid at the end of a test, never by matching a command
// line. Not a test file: `node --test tests/mcp` will not pick this name up.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..').split('\\').join('/');
const BIN = `${ROOT}/src/mcp/belay-mcp.cjs`;
const FAKE = `${ROOT}/tests/mcp/fake-core.cjs`;

// A fresh sandbox data dir under the OS temp dir. Never the repository's own store.
function sandboxDir(tag = 'mcp') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `belay-${tag}-`)).split('\\').join('/');
}

class Adapter {
  constructor(child) {
    this.child = child;
    this.pid = child.pid;
    this.pending = new Map();
    this.stderr = '';
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => { this.exitCode = code; this.exitSignal = signal; resolve({ code, signal }); });
    });
    this._buf = '';
    child.stdout.on('data', (d) => {
      this._buf += d.toString('utf8');
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i);
        this._buf = this._buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.resolve(m); }
      }
    });
    child.stderr.on('data', (d) => { this.stderr += d.toString('utf8'); });
    this._nextId = 1;
  }

  send(method, params, timeoutMs = 20000) {
    const id = this._nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout waiting for ${method} id ${id}`)); }
      }, timeoutMs).unref();
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return p;
  }

  async initialize() {
    return this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  }

  async list() {
    const r = await this.send('tools/list', {});
    return r.result.tools;
  }

  async call(name, args = {}, timeoutMs = 20000) {
    const r = await this.send('tools/call', { name, arguments: args }, timeoutMs);
    return r.result;
  }

  // End stdin, which is how a client detaches, and wait for exit. Falls back to a kill by exact pid.
  async close(ms = 5000) {
    if (this.exitCode !== undefined) return this.exitCode;
    this.child.stdin.end();
    const timer = new Promise((r) => setTimeout(() => r('timeout'), ms).unref());
    const which = await Promise.race([this.exited, timer]);
    if (which === 'timeout') this.kill();
    return this.exitCode;
  }

  kill() {
    if (this.exitCode === undefined && this.pid) {
      try { process.kill(this.pid); } catch { /* already gone */ }
    }
  }
}

// argv is the whole identity; nothing else is passed. `fake` injects the stand-in core through the one
// environment variable the binary honours.
function launch({ role = 'orchestrator', run = 'run-1', data, workerId, noEmbed = true, log, fake = true, extra = [], cwd, env: extraEnv } = {}) {
  const argv = [BIN, '--role', role, '--run', run];
  if (data) argv.push('--data', data);
  if (workerId) argv.push('--worker-id', workerId);
  if (noEmbed) argv.push('--no-embed');
  if (log) argv.push('--log', log);
  argv.push(...extra);
  const env = { ...process.env };
  if (fake) env.BELAY_FAKE_CORE = FAKE; else delete env.BELAY_FAKE_CORE;
  Object.assign(env, extraEnv || {});
  const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], env, ...(cwd ? { cwd } : {}) });
  return new Adapter(child);
}

// Runs the binary to completion with an immediately closed stdin, for the argv cases. A refusal exits
// before it ever reads stdin; an accepted argv line takes the stdin-end shutdown path and exits too,
// so this never waits on a live adapter. Bounded anyway, and the timeout kill is by exact pid.
function runArgv(args, env = {}, ms = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(child.pid); } catch { /* already gone */ }
    }, ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err, pid: child.pid, timedOut }); });
    child.stdin.end();
  });
}

module.exports = { Adapter, launch, runArgv, sandboxDir, ROOT, BIN, FAKE };
