'use strict';
// operator-check-msys.test.cjs — Git Bash starts some commands (timeout, env, nohup, xargs, npm's `#!/bin/sh` shim) through an MSYS
// program that Cygwin's exec creates with no Windows parent, so the operator check's chain for such a command ends at the helper, born
// after the owner started. The refusal stays (belay cannot prove the command is the operator's); the client's error now says why and
// what to run instead, in text and in detail.hint. Host tables are injected; the owner and the client are real.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');
const { msysHint } = core('msys-hint.cjs');

const T0 = Date.now();
ownSpawnRegistry();
const caller = { role: 'operator', run_id: 'run-msys', pid: process.pid };
const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';

// explorer(old) -> bash(old) ... [bash's child is made by Cygwin exec: its ppid is absent from the snapshot] sh.exe(new) -> node(peer)
const msysChain = (rootImage = 'sh.exe') => new Map([
  [4001, { ppid: 1, created: OLD_ROOT_CREATED, image: 'explorer.exe' }],
  [4002, { ppid: 4001, created: OLD_ROOT_CREATED + 1000, image: 'bash.exe' }],
  [4100, { ppid: 99999, created: T0 + 60000, image: rootImage }],
  [4242, { ppid: 4100, created: T0 + 60500, image: 'node.exe' }],
]);
const nodeChain = () => new Map([ // an ordinary peer whose root is also born after the owner, with no MSYS helper in the text
  [4000, { ppid: 99999, created: T0 + 60000, image: 'pwsh.exe' }],
  [4242, { ppid: 4000, created: T0 + 60500, image: 'node.exe' }],
]);

async function refused(shot, { msystem, operatorCheckExtra } = {}) {
  const keep = process.env.MSYSTEM;
  if (msystem === undefined) delete process.env.MSYSTEM; else process.env.MSYSTEM = msystem;
  const dir = sandbox();
  const ports = new Set();
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: async () => [...ports].map(p => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`).join(''),
    snapshot: async () => shot,
    ...(operatorCheckExtra || {}),
  } });
  await o.start();
  const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
  try {
    await c.connect(); ports.add(c.sock.localPort);
    const read = await c.call('memory.get', { id: 'x', caller }).then(() => null, (e) => e);
    const write = await c.call('memory.store', { text: 'x', namespace: 'project/p', embed: false, caller }).then(() => null, (e) => e);
    return { read, write };
  } finally {
    await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir);
    if (keep === undefined) delete process.env.MSYSTEM; else process.env.MSYSTEM = keep;
  }
}

test('a command started through an MSYS helper is still refused, and the error names the cause and the way around it, in text and in JSON', { skip, timeout: 60000 }, async () => {
  const { read, write } = await refused(msysChain('sh.exe'));
  for (const e of [read, write]) {
    assert.ok(e && e.code === 'E_UNBOUND', e && e.message);
    assert.strictEqual(e.detail.reason, 'operator_check');
    assert.strictEqual(e.detail.operator_cause, 'root_after_owner');
    assert.match(e.detail.hint, /MSYS helper/);
    assert.match(e.detail.hint, /PowerShell or cmd/);
    assert.match(e.detail.hint, /node "[^"]+belay\.cjs" <command>/);
    assert.ok(e.message.endsWith(e.detail.hint), 'the same line is in the text');
    assert.ok(!/[\r\n]/.test(e.detail.hint) && e.detail.hint.length <= 400, String(e.detail.hint.length));
  }
  assert.ok(!/Retry; the check is asked again/.test(read.message), 'a retry cannot help under Git Bash, so the line that offers one is replaced');
  const cli = /node "([^"]+belay\.cjs)"/.exec(read.detail.hint)[1];
  assert.ok(fs.existsSync(path.normalize(cli)), `the printed path exists: ${cli}`);
});

test('MSYSTEM adds the line to a root refusal that names no helper; without it, or with a non-root cause, nothing is added', { skip, timeout: 60000 }, async () => {
  const withEnv = await refused(nodeChain(), { msystem: 'MINGW64' });
  assert.ok(withEnv.read && withEnv.read.code === 'E_UNBOUND' && /MSYS helper/.test(withEnv.read.detail.hint), withEnv.read && withEnv.read.message);
  const plain = await refused(nodeChain());
  assert.ok(plain.read && plain.read.code === 'E_UNBOUND', plain.read && plain.read.message);
  assert.ok(!plain.read.detail.hint && !/MSYS/.test(plain.read.message), plain.read.message);
  // MSYSTEM with a snapshot that does not hold the peer: refused for another reason, no cause, no line
  const other = await refused(new Map(), { msystem: 'MINGW64' });
  assert.ok(other.read && other.read.code === 'E_UNBOUND', other.read && other.read.message);
  assert.ok(!other.read.detail.hint && !other.read.detail.operator_cause, other.read.message);
});

const conn = () => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100 });
const table = async () => '  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';

test('the refusal carries a fixed cause: the root forms are told from a proven descent from a spawned process', async () => {
  // the real false refusal: a chain root inside a live orchestrator's window, recorded by the provenance as a descendant of it
  const inWindow = await OC.create({ startedAt: T0, spawned: () => [], provenance: () => ({ alive: [{ pid: 4100, created: T0 + 60000, kind: 'descendant of orchestrator pid 900' }] }), deps: { table, snapshot: async () => msysChain('timeout.exe') } })({ conn: conn() });
  assert.strictEqual(inWindow.ok, false);
  assert.match(inWindow.reason, /descendant of orchestrator pid 900 pid 4100, timeout\.exe/);
  assert.strictEqual(inWindow.cause, 'root_in_window');
  // a chain proved to run through a worker (a live spawned record on a chain process, not a recorded root)
  const direct = await OC.create({ startedAt: T0, spawned: () => [{ pid: 4002, created: OLD_ROOT_CREATED + 1000, kind: 'worker' }], deps: { table, snapshot: async () => new Map([...msysChain('timeout.exe'), [4100, { ppid: 4002, created: T0 + 60000, image: 'timeout.exe' }]]) } })({ conn: conn() });
  assert.strictEqual(direct.ok, false);
  assert.strictEqual(direct.cause, 'direct_spawn');
  const afterOwner = await OC.create({ startedAt: T0, spawned: () => [], deps: { table, snapshot: async () => msysChain('sh.exe') } })({ conn: conn() });
  assert.strictEqual(afterOwner.cause, 'root_after_owner');
  const unfollowable = await OC.create({ startedAt: T0, spawned: () => [], deps: { table, snapshot: async () => new Map([[4242, { ppid: 4300, created: 5, image: 'node.exe' }], [4300, { ppid: 4242, created: 5, image: 'sh.exe' }]]) } })({ conn: conn() });
  assert.strictEqual(unfollowable.cause, 'root_unfollowable'); // a loop in the chain
});

test('the hint is true words only: root causes with a helper image or MSYSTEM; a direct spawn, a pipe and the rest get nothing', () => {
  const win = 'the peer descends from a process belay spawned (descendant of orchestrator pid 9 pid 4100, timeout.exe)';
  assert.ok(msysHint(win, 'root_in_window', {}), 'the real root form gets the hint');
  assert.strictEqual(msysHint('the peer descends from a process belay spawned (worker pid 4100, timeout.exe)', 'direct_spawn', {}), null, 'a proven worker chain does not');
  assert.strictEqual(msysHint('the peer descends from a process belay spawned (worker pid 4100, claude.exe)', 'direct_spawn', { MSYSTEM: 'MINGW64' }), null, 'MSYSTEM does not turn a proven chain into the Git Bash break');
  assert.ok(msysHint("the peer's chain ends at pid 4100 (nohup.exe), which was not running", 'root_after_owner', {}));
  assert.strictEqual(msysHint("the peer's chain ends at pid 4000 (pwsh.exe), which was not running", 'root_after_owner', {}), null);
  assert.strictEqual(msysHint('a process named mysh.exe', 'root_after_owner', {}), null);
  assert.ok(msysHint('x', 'root_after_owner', { MSYSTEM: 'MINGW64' }));
  assert.strictEqual(msysHint('this platform has no peer check', undefined, { MSYSTEM: 'MINGW64' }), null);
  assert.strictEqual(msysHint('x', 'unknown', { MSYSTEM: 'MINGW64' }), null);
  assert.strictEqual(msysHint('the process chain could not be followed to a root (pid 4242)', 'root_unfollowable', { MSYSTEM: 'MINGW64' }), null, 'a chain that cannot be followed is not the Git Bash break');
});

test('a check that fails to run on a later ping leaves no cause from an earlier refusal on the connection', { skip, timeout: 60000 }, async () => {
  const dir = sandbox();
  let calls = 0;
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheck: async () => {
    calls += 1;
    if (calls === 1) return { ok: false, cause: 'root_after_owner', reason: 'the peer\'s chain ends at pid 4100 (sh.exe), which was not running' };
    throw new Error('the check broke');
  } });
  await o.start();
  const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
  try {
    await c.connect();
    const first = await c._send('ping', { caller, verify_operator: true });
    assert.strictEqual(first.operator_cause, 'root_after_owner');
    const second = await c._send('ping', { caller, verify_operator: true });
    assert.strictEqual(second.operator_reason, 'the operator check failed to run');
    assert.ok(!('operator_cause' in second), 'the earlier cause is not carried onto a failure to run');
  } finally { await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
});
