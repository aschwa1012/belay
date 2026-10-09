'use strict';
// A fake Claude Code substrate that is a tree, not a process: it starts one plain child that
// outlives it (stdio ignored, so it holds none of this process's pipes), records that child's pid
// where the test can read it, reaches ready, and never exits on stdin close. It stands in for a
// real worker's MCP adapter — exactly the grandchild a stop has to take with it (ADR 0011 §2).
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const SESSION = process.env.FAKE_SESSION_ID || 'fake-session-0000-0000-0000-0000000000ch';
const PID_FILE = process.env.FAKE_CHILD_PID_FILE || null;

const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
if (PID_FILE) fs.writeFileSync(PID_FILE, String(kid.pid));

// ADR 0024, build step S2: built from this process's own argv, like fake-claude.cjs.
const toolsAt = process.argv.indexOf('--tools');
const tools = [...(toolsAt >= 0 ? process.argv[toolsAt + 1].split(',').filter(Boolean) : []), 'mcp__belay__memory_store'];
process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', session_id: SESSION, tools,
  plugins: [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }],
  mcp_servers: [{ name: 'belay', status: 'connected' }],
}) + '\n');

setInterval(() => {}, 1000);
process.stdin.resume();
