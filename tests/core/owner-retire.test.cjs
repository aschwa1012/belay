'use strict';
// owner-retire.test.cjs — a command that elected the store owner and is done (belay memory review is one) must not shut the
// owner down under a client that attached to it meanwhile: the owner stays up while another client is attached and stops with
// the last one. Every way a client goes away is driven for real: a clean detach, a crash (the child process killed by its exact
// handle), a reported pid that is dead, and a client that stays attached and idle. No load and no sleeps: each wait is on the
// event itself (the retired owner's stop, a child's output).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { core, sandbox, cleanup, deadPid } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { ping } = core('ping.cjs');
const retire = core('retire.cjs');
const { release } = require('../../src/cli/cmd-memory-stages.cjs');

const CHILD = path.join(__dirname, 'fixtures', 'owner-client.cjs');
const lockOf = (dir) => path.join(dir, 'owner.lock');
const op = (dir, pid = process.pid) => openCore({ dataDir: dir, caller: { role: 'operator', run_id: 'test-run', pid }, embed: false });
// Every Core a helper opens is registered at once, so a helper whose own assertion fails after the open, or a test that fails
// before its finish(), still gets the owner shut down when the file ends (finish() on a closed Core is a no-op).
const opened = new Set();
test.after(async () => {
  for (const c of opened) {
    try { if (c.isOwner()) await c.shutdownOwner(); } catch { /* best effort */ }
    try { await c.close(); } catch { /* best effort */ }
  }
  opened.clear();
});
// A wait that fails the test instead of hanging it.
const within = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms); })]).finally(() => clearTimeout(t)); };

// The elected Core, owner confirmed, ready to be released.
async function elected() {
  const dir = sandbox();
  const rc = await op(dir);
  opened.add(rc);
  await rc.becomeOwner();
  assert.ok(rc.isOwner());
  return { dir, rc };
}
// A client in this process: a read that the owner's pipe answers, so it holds an open connection.
async function inProcessClient(dir, pid) {
  const y = await op(dir, pid);
  opened.add(y);
  await y.worker.list({});
  assert.ok(y.client && y.client.connected, 'the client holds a connection');
  return y;
}
// A client in its own process. `stop()` ends its stdin (clean detach); `child` is the handle for a crash.
function childClient(dir) {
  const child = spawn(process.execPath, [CHILD, dir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((res) => child.once('exit', (code, signal) => res({ code, signal })));
  const attached = new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; if (/attached/.test(out)) resolve(); });
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', () => reject(new Error(`the client exited before attaching: ${out}${err}`)));
  });
  return { child, exited, attached, stop: () => child.stdin.end() };
}
async function finish(dir, rc, ...more) {
  for (const m of more) { try { await m.close(); } catch { /* closed */ } }
  try { if (rc.isOwner()) await rc.shutdownOwner(); } catch { /* best effort */ }
  await rc.close();
  await retire.idle();
  cleanup(dir);
}

test('release with no other client attached stops the owner at once, exactly as before', async () => {
  const { dir, rc } = await elected();
  try {
    const r = await release(rc);
    assert.strictEqual(r, undefined);
    assert.ok(!fs.existsSync(lockOf(dir)), 'owner.lock is gone');
    assert.strictEqual(retire.pending(), 0, 'nothing is left waiting');
  } finally { await finish(dir, rc); }
});

test('a client attached when the electing command releases keeps its owner; the last client leaving stops it', async (tcx) => {
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, process.pid);
  tcx.after(() => Promise.resolve().then(() => y.close()).catch(() => {}));
  try {
    await release(rc);
    assert.ok(fs.existsSync(lockOf(dir)), 'the owner.lock is still held: the owner was not shut down under the client');
    assert.strictEqual((await ping(dir, 1000)).ok, true, 'the owner still answers');
    assert.strictEqual(rc.isOwner(), false, 'the releasing Core no longer claims the owner');
    assert.strictEqual(retire.pending(), 1, 'the retired owner is waited for');
    assert.ok(Array.isArray((await y.worker.list({})).workers), 'the attached client is still served over its pipe');
    await y.close(); // the last client leaves
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)), 'the owner stopped with the last client');
  } finally { await finish(dir, rc, y); }
});

test('release names what it did: a deferral lists the attached client, a stop gives the stop receipt', async (tcx) => {
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, process.pid);
  tcx.after(() => Promise.resolve().then(() => y.close()).catch(() => {}));
  try {
    const r = await rc.releaseOwner();
    assert.strictEqual(r.stopped, 'deferred');
    assert.strictEqual(r.deferred, true);
    assert.deepStrictEqual(r.attached.map((a) => a.pid), [process.pid]);
    assert.match(r.attached[0].via, /pid check answers/);
    await y.close();
    await within(retire.idle(), 15000, 'the retired owner to stop');
    const again = await rc.releaseOwner();
    assert.strictEqual(again.stopped, 'none', 'a Core that holds no owner stops nothing');
  } finally { await finish(dir, rc, y); }
});

test('a client in another process that detaches cleanly: the owner outlives the release and stops after it', async () => {
  const { dir, rc } = await elected();
  const c = childClient(dir);
  try {
    await within(c.attached, 20000, 'the client process to attach');
    await release(rc);
    assert.ok(fs.existsSync(lockOf(dir)), 'the owner is up while the client process is attached');
    assert.strictEqual((await ping(dir, 1000)).ok, true);
    c.stop();
    assert.strictEqual((await within(c.exited, 20000, 'the client to exit')).code, 0);
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)));
  } finally { c.child.kill(); await c.exited; await finish(dir, rc); }
});

test('a client that crashes: the owner does not linger once its connection and process are gone', async () => {
  const { dir, rc } = await elected();
  const c = childClient(dir);
  try {
    await within(c.attached, 20000, 'the client process to attach');
    await release(rc);
    assert.ok(fs.existsSync(lockOf(dir)), 'up while the client lives, idle as it is');
    c.child.kill(); // the exact handle; a terminate skips the client's handlers, which is the crash being driven
    await within(c.exited, 20000, 'the client to die');
    await within(retire.idle(), 15000, 'the retired owner to stop after the crash');
    assert.ok(!fs.existsSync(lockOf(dir)), 'the owner stopped after the crashed client');
  } finally { c.child.kill(); await c.exited; await finish(dir, rc); }
});

test('a connection whose reported pid is dead does not hold the owner (the pid check, not the connection, decides)', async () => {
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, deadPid()); // the socket is open, the pid it names has long exited
  try {
    const r = await rc.releaseOwner();
    assert.strictEqual(r.stopped, 'in-process', 'no live client was attached, so the owner stopped now');
    assert.ok(!fs.existsSync(lockOf(dir)));
  } finally { await finish(dir, rc, y); }
});

test('a client whose pid dies while the connection stays open is dropped by the poll', async () => {
  const { dir, rc } = await elected();
  const real = require('../../src/core/lock.cjs');
  const y = await inProcessClient(dir, process.pid);
  const pidAlive = real.pidAlive;
  try {
    await release(rc);
    assert.ok(fs.existsSync(lockOf(dir)));
    real.pidAlive = (pid) => (pid === process.pid ? false : pidAlive(pid)); // the pid check now says the client's process is gone
    await within(retire.idle(), 15000, 'the poll to notice the dead pid');
    assert.ok(!fs.existsSync(lockOf(dir)), 'the owner stopped although the socket never closed');
  } finally { real.pidAlive = pidAlive; await finish(dir, rc, y); }
});

test('a second client that attaches during the retirement holds the owner until it too is gone', async (tcx) => {
  const { dir, rc } = await elected();
  const y1 = await inProcessClient(dir, process.pid);
  tcx.after(() => Promise.resolve().then(() => y1.close()).catch(() => {}));
  let y2 = null;
  tcx.after(() => Promise.resolve().then(() => y2.close()).catch(() => {}));
  try {
    await release(rc);
    y2 = await inProcessClient(dir, process.pid);
    await y1.close();
    assert.ok(fs.existsSync(lockOf(dir)), 'one client is still attached');
    assert.strictEqual((await ping(dir, 1000)).ok, true);
    await y2.close();
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)));
  } finally { await finish(dir, rc, y1, ...(y2 ? [y2] : [])); }
});

test('a remote shutdown during the retirement stops the owner once and the wait ends', async (tcx) => {
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, process.pid); // an operator: allowed to ask for the shutdown
  tcx.after(() => Promise.resolve().then(() => y.shutdownOwner()).catch(() => {}));
  try {
    await release(rc);
    await y.shutdownOwner();
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)));
    assert.strictEqual(retire.pending(), 0);
  } finally { await finish(dir, rc, y); }
});

test('a read-mode command waits for a retired owner before it ends the process, and does not wait when there is none', async () => {
  const { finish: finishCommand } = require('../../src/cli/belay.cjs');
  const stream = { write(_chunk, cb) { setImmediate(cb); return true; } };
  const exits = [];
  const io = { stdout: stream, stderr: stream, exit: (c) => exits.push(c) };
  await finishCommand(['memory', 'stats'], 0, io);
  assert.deepStrictEqual(exits, [0], 'no retired owner: the process ends at once');
  let stopOwner;
  retire.register(new Promise((r) => { stopOwner = r; }));
  try {
    const ending = finishCommand(['memory', 'stats'], 0, io);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(exits, [0], 'a retired owner is still serving: the process has not ended');
    stopOwner();
    await ending;
    assert.deepStrictEqual(exits, [0, 0], 'the owner stopped, so the process ends');
  } finally { stopOwner(); } // a failed assertion must not leave the synthetic retirement pending for a later retire.idle()
});

test('belay memory verify, run as a command over an owner it elected, defers to an attached client and says so on stderr', async () => {
  process.env.BELAY_TEST_MODE = '1';
  const { run } = require('../../src/cli/cmd-memory.cjs');
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, process.pid);
  const written = [];
  const stderr = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try {
    try {
      await run({ argv: ['verify', 'no-such-note', '--status', 'verified', '--receipt', 'commit:abcdef1'], cwd: dir, dataDir: dir, dataDirGiven: true, openCore: async () => rc });
    } finally { process.stderr.write = stderr; }
    assert.ok(fs.existsSync(lockOf(dir)), 'the owner was not shut down under the attached client');
    assert.strictEqual(retire.pending(), 1, written.join('').slice(0, 600));
    assert.match(written.join(''), new RegExp(`stays up for the other client\\(s\\) attached to it: pid ${process.pid} \\(operator\\).*Ctrl-C`));
    await y.close();
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)));
  } finally { process.stderr.write = stderr; await finish(dir, rc, y); }
});

test('a write after an immediate-stop release fails E_SHUTDOWN: it neither elects nor holds an owner', async () => {
  const { dir, rc } = await elected();
  try {
    const r = await rc.releaseOwner();
    assert.strictEqual(r.stopped, 'in-process');
    await assert.rejects(() => rc.memory.recordEvent({ kind: 'wrapup', key: 'late', ok: true, message: 'x' }), (e) => e.code === 'E_SHUTDOWN' && /memory\.recordEvent was refused/.test(e.message));
    assert.strictEqual(rc.isOwner(), false);
    assert.ok(!fs.existsSync(lockOf(dir)), 'no owner was elected');
    assert.strictEqual(retire.pending(), 0);
  } finally { await finish(dir, rc); }
});

test('the other elect-then-shutdown commands release through releaseOwner', () => {
  for (const f of ['cmd-memory.cjs', 'cmd-message.cjs', 'cmd-pause.cjs', 'cmd-worker.cjs', 'cmd-memory-stages.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', f), 'utf8');
    assert.ok(!/core\.shutdownOwner\(\)|rc\.shutdownOwner\(\)/.test(src), `${f} no longer shuts its owner down unconditionally`);
    assert.match(src, /releaseOwnerOf/, f);
  }
});

test('after a deferred release the Core never elects another owner: a later write is refused E_SHUTDOWN (audit L18)', async (tcx) => {
  const { dir, rc } = await elected();
  const y = await inProcessClient(dir, process.pid);
  tcx.after(() => Promise.resolve().then(() => y.close()).catch(() => {}));
  try {
    const r = await rc.releaseOwner();
    assert.strictEqual(r.stopped, 'deferred');
    await y.close();
    await within(retire.idle(), 15000, 'the retired owner to stop');
    assert.ok(!fs.existsSync(lockOf(dir)), 'the retired owner is gone');
    await assert.rejects(rc.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_SHUTDOWN', 'the write is refused, naming the shutdown');
    assert.ok(!fs.existsSync(lockOf(dir)), 'and no stray owner was elected for it');
  } finally { await finish(dir, rc, y); }
});
