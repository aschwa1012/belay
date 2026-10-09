'use strict';
// A substrate that produces one well-formed `system/init` on its stdout and exits 7, with the death
// guaranteed to be established before the init can be read.
//
// The guarantee matters. Writing the init and then calling process.exit(7) in one process leaves a
// race: Node's teardown takes a few milliseconds, so the parent can legitimately see the init while
// the pid is still alive, write a `running` row, and only settle it dead on the next poll. That is
// contract-legal and it makes the test say nothing. So the init is emitted by a plain child that
// inherits this process's stdout (fd 1, so the same pipe): this process exits 7 immediately, and
// the line arrives on a pipe the child still holds open, after the exit is a fact.
//
// Whichever liveness channel the manager keys on, `spawn` must reject E_NO_READY carrying
// exit_code 7, and the row written must be `dead`, never `running`.

const { spawn } = require('node:child_process');

const SESSION = process.env.FAKE_SESSION_ID || 'fake-session-0000-0000-0000-00000000dead';
const EMIT_MS = Number(process.env.FAKE_EMIT_MS || 150);

// ADR 0024, build step S2: built from argv like fake-claude.cjs, never hardcoded, so the ready gate's
// surface check sees the same real launch table this substrate was actually started with. The init is
// emitted by a plain child (above) whose own argv is just `--emit`, so the parent hands its `--tools`
// value down through the environment it inherits by default, rather than losing it at the spawn.
function surfaceTools() {
  const argv = process.env.FAKE_TOOLS_ARGV || '';
  const builtins = argv ? argv.split(',').filter(Boolean) : [];
  return [...builtins, 'mcp__belay__memory_store'];
}

if (process.argv.includes('--emit')) {
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: SESSION,
        tools: surfaceTools(),
        plugins: [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }],
        mcp_servers: [{ name: 'belay', status: 'connected' }],
      }) + '\n'
    );
    process.exit(0);
  }, EMIT_MS);
} else {
  const toolsAt = process.argv.indexOf('--tools');
  if (toolsAt >= 0) process.env.FAKE_TOOLS_ARGV = process.argv[toolsAt + 1];
  spawn(process.execPath, [__filename, '--emit'], { stdio: ['ignore', 1, 'ignore'], windowsHide: true }).unref();
  process.exit(7);
}
