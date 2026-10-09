'use strict';
// A fake Codex CLI: `exec --json`, one process per turn, the prompt in argv and nothing on stdin.
// It emits the four event shapes the parser knows — thread.started, item.completed/agent_message,
// turn.completed — and, standing in for the belay worker adapter that the real binary would launch
// from its `-c mcp_servers.belay.*` overrides, it appends a JSON-RPC tools/list frame to the
// adapter log named in those overrides. That log is the only evidence ADR 0001 §8 has on this
// substrate (WR-5: a crashed Codex MCP server is otherwise silent), so the gate is drivable both
// ways: FAKE_CODEX_NO_TOOLS_LIST=1 connects nothing, FAKE_CODEX_HANG=1 stays alive after it.

const fs = require('node:fs');

const THREAD = process.env.FAKE_THREAD_ID || 'fake-thread-0000-0000-0000-000000000001';
const NO_TOOLS_LIST = process.env.FAKE_CODEX_NO_TOOLS_LIST === '1';
const HANG = process.env.FAKE_CODEX_HANG === '1';
const TOOLS_LIST_MS = Number(process.env.FAKE_CODEX_TOOLS_LIST_MS || 30);
const TURN_MS = Number(process.env.FAKE_CODEX_TURN_MS || 400);

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// The adapter's argv arrives inside `-c mcp_servers.belay.args=["...","--log","<path>"]`, which is
// a TOML array of strings and so JSON-parseable.
function adapterLogPath() {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith('mcp_servers.belay.args='));
  if (!a) return null;
  try {
    const args = JSON.parse(a.slice('mcp_servers.belay.args='.length));
    const i = args.indexOf('--log');
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  } catch {
    return null;
  }
}

const prompt = process.argv[process.argv.length - 1];
say({ type: 'thread.started', thread_id: THREAD });

if (!NO_TOOLS_LIST) {
  setTimeout(() => {
    const log = adapterLogPath();
    if (!log) return;
    try {
      fs.appendFileSync(log, JSON.stringify({ at: Date.now(), dir: 'out', method: 'tools/list', id: 1 }) + '\n');
    } catch { /* the ready check will report the log it could not read */ }
  }, TOOLS_LIST_MS);
}

// A hung worker has to stay alive to be hung: nothing else holds this event loop open.
if (HANG) setInterval(() => {}, 1000);

setTimeout(() => {
  if (HANG) return;
  say({ type: 'item.completed', item: { type: 'agent_message', text: 'echo: ' + prompt } });
  say({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 20 } });
  process.exit(0);
}, TURN_MS);
