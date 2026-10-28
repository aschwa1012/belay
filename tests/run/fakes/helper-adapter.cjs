'use strict';
// A stand-in for the orchestrator's MCP adapter, which a fake orchestrator starts: it writes its pid to FAKE_ADAPTER_PIDFILE, starts
// one detached "worker" of its own (a helper-sleeper writing FAKE_WORKER_PIDFILE), and idles until it is killed.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
fs.writeFileSync(process.env.FAKE_ADAPTER_PIDFILE, String(process.pid));
spawn(process.execPath, [path.join(__dirname, 'helper-sleeper.cjs')], { windowsHide: true, stdio: 'ignore', detached: true, env: { ...process.env, FAKE_HELPER_PIDFILE: process.env.FAKE_WORKER_PIDFILE } }).unref();
setInterval(() => {}, 1000);
