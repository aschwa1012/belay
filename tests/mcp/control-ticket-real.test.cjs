'use strict';
// control-ticket-real.test.cjs — the real belay-mcp adapter's ticket wiring (ADR 0045 decision 5). A real orchestrator adapter (owner in its own process), a fake-claude worker,
// then the built CLI's `belay message` (gets a ticket, the adapter redeems it) and a raw dialler with no ticket (refused).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');
const { adapterPipeName } = require('../../src/core/lock.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const CLI = `${ROOT}/src/cli/belay.cjs`;

function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, windowsHide: true, env: { ...process.env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}
function raw(pipe, params) {
  return new Promise((resolve, reject) => {
    const c = net.connect(pipe, () => c.write(`${JSON.stringify({ id: 1, method: 'worker.message', params })}\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    c.on('error', reject);
  });
}

test('real adapter: the CLI message is served on a ticket; a raw operator claim is refused', { timeout: 90000 }, async (t) => {
  const data = sandboxDir('ticket-real');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = launch({ role: 'orchestrator', data, fake: false, noEmbed: true, env: { BELAY_FAKE_PATHS: JSON.stringify({ claudeExe: FAKE_CLAUDE, codexExe: FAKE_CLAUDE, userSettings: USER_SETTINGS }) } });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const r = await a.call('worker_spawn', { substrate: 'claude-code', worktree, prompt: 'do the thing' });
  assert.strictEqual(r.isError, false, JSON.stringify(r.structuredContent));
  const w = r.structuredContent;

  const refused = await raw(adapterPipeName(data, a.pid), { caller: { role: 'operator', pid: 1 }, worker_id: w.id, text: 'forged' });
  assert.strictEqual(refused.error && refused.error.detail && refused.error.detail.reason, 'ticket', JSON.stringify(refused));

  const m = await cli(['message', w.id, 'hello', 'there', '--data', data, '--json']);
  assert.strictEqual(m.code, 0, `${m.out}\n${m.err}`);
  assert.strictEqual(JSON.parse(m.out).sent, true, m.out);
  const stop = await cli(['worker', 'stop', w.id, '--data', data, '--json']);
  assert.strictEqual(stop.code, 0, `${stop.out}\n${stop.err}`);
});
