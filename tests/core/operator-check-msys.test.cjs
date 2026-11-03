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
    assert.match(e.detail.hint, /MSYS helper/);
    assert.match(e.detail.hint, /PowerShell or cmd/);
    assert.match(e.detail.hint, /node \S+belay\.cjs <command>/);
    assert.ok(e.message.endsWith(e.detail.hint), 'the same line is in the text');
    assert.ok(!/[\r\n]/.test(e.detail.hint) && e.detail.hint.length <= 400, String(e.detail.hint.length));
  }
  const cli = /node (\S+belay\.cjs)/.exec(read.detail.hint)[1];
  assert.ok(fs.existsSync(path.normalize(cli)), `the printed path exists: ${cli}`);
});

test('MSYSTEM in the environment adds the line even when the refusal names no helper; neither adds nothing', { skip, timeout: 60000 }, async () => {
  const withEnv = await refused(nodeChain(), { msystem: 'MINGW64' });
  assert.ok(withEnv.read && withEnv.read.code === 'E_UNBOUND' && /MSYS helper/.test(withEnv.read.detail.hint), withEnv.read && withEnv.read.message);
  const plain = await refused(nodeChain());
  assert.ok(plain.read && plain.read.code === 'E_UNBOUND', plain.read && plain.read.message);
  assert.ok(!plain.read.detail.hint && !/MSYS/.test(plain.read.message), plain.read.message);
});

test('the hint is true words only: it is produced for a helper image and for MSYSTEM, and for nothing else', () => {
  assert.ok(msysHint('the peer descends from a process belay spawned (descendant of orchestrator pid 9 pid 4100, timeout.exe)', {}));
  assert.ok(msysHint("the peer's chain ends at pid 4100 (nohup.exe), which was not running", {}));
  assert.strictEqual(msysHint("the peer's chain ends at pid 4000 (pwsh.exe), which was not running", {}), null);
  assert.strictEqual(msysHint('a process named mysh.exe', {}), null);
  assert.ok(msysHint('x', { MSYSTEM: 'MINGW64' }));
});

test('no trust change: a chain born after the owner under a live orchestrator window is refused by the check itself', async () => {
  const conn = { belayTransport: 'tcp', remotePort: 61000, localPort: 52100 };
  const table = async () => '  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';
  const check = OC.create({ startedAt: T0, spawned: () => [], provenance: () => ({ alive: [{ pid: 4100, created: T0 + 60000, kind: 'descendant of orchestrator pid 900' }] }), deps: { table, snapshot: async () => msysChain('timeout.exe') } });
  const v = await check({ conn });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /descendant of orchestrator pid 900 pid 4100, timeout\.exe/);
});
