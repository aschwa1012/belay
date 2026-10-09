'use strict';
// client-wedged.test.cjs — a wedged owner (pid alive, event loop blocked, pipe accepting at the OS
// level) must cost a process ONE timeout, not one per read, and must not keep the process alive.
// libuv's Windows pipe server has ~4 pending instances; once a wedged owner's are used up a dial sits in
// a 30 s WaitNamedPipeW that cannot be cancelled. After one dial or answer timeout the owner is marked
// unresponsive for the rest of the process: reads go to the copy with no dial, writes fail fast.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore, pipeName } = core('index.cjs');
const { Client } = core('client.cjs');
const unresponsive = core('unresponsive.cjs');
const { ping } = core('ping.cjs');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const FIX = `${ROOT}/tests/core/fixtures`;

async function startOwner(script, dir, extra = []) {
  const child = spawn(process.execPath, [`${FIX}/${script}`, dir, ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  for (let i = 0; i < 400 && !/READY|"ready":true/.test(buf); i += 1) await new Promise(r => setTimeout(r, 25));
  assert.match(buf, /READY|"ready":true/, `the owner did not start: ${buf}`);
  return child;
}

// Counts every net.connect to a pipe while fn runs.
async function countDials(fn) {
  const real = net.connect;
  let n = 0;
  net.connect = function (...a) { n += 1; return real.apply(this, a); };
  try { await fn(); } finally { net.connect = real; }
  return n;
}

test('a wedged owner: 8 reads in one process cost one dial and finish fast, each naming the unresponsive owner', async () => {
  const dir = sandbox();
  let child = null;
  try {
    child = await startOwner('owner-wedged.cjs', dir, ['12000']);
    await new Promise(r => setTimeout(r, 700)); // now wedged
    unresponsive.reset();
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const t0 = Date.now();
    const vias = [];
    const dials = await countDials(async () => {
      for (let i = 0; i < 8; i += 1) {
        await c.memory.list({});
        vias.push((await c.status.get({})).established_by);
      }
    });
    const ms = Date.now() - t0;
    // The dial count below is the strict regression check. The time bound only has to stay far under what a regression
    // costs without the back-off (every read dialling a wedged owner, up to 8 x 30 s); a fixed 2.5 s failed under full-suite load.
    assert.ok(ms < 20000, `8 reads took ${ms} ms`);
    assert.ok(dials <= 1, `${dials} dials; only the first read may dial a wedged owner`);
    assert.ok(vias.every(v => /owner unresponsive \(answer timed out at 300 ms; pid \d+, .*\); read from copy until \d{4}-/.test(v)), JSON.stringify(vias));
    await c.close();
  } finally {
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

// An owner that answers everything, after delayMs() (pings at once). Not wedged: it replies.
async function slowOwner(dir, delayMs) {
  const conns = new Set();
  const seen = [];
  const srv = net.createServer(s => {
    conns.add(s); s.on('close', () => conns.delete(s)); s.on('error', () => {});
    let buf = '';
    s.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        seen.push(req.method);
        const t = setTimeout(() => { if (!s.destroyed) s.write(JSON.stringify({ id: req.id, result: { pid: process.pid, items: [] } }) + '\n'); }, req.method === 'ping' ? 0 : delayMs());
        t.unref();
      }
    });
  });
  const pipe = pipeName(dir);
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(pipe, res); });
  fs.mkdirSync(path.join(dir, 'owner.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid, pipe, listening: true, acquired_at: Date.now() }));
  return { seen, close: () => { for (const s of conns) s.destroy(); srv.close(); } };
}

test('writes ignore a read-timeout backoff: the write still dials, is sent and gets its answer', async () => {
  const dir = sandbox();
  let owner = null;
  try {
    unresponsive.reset();
    owner = await slowOwner(dir, () => 900);
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await c.memory.list({}); // times out at 300 ms: backoff armed
    assert.ok(unresponsive.get(pipeName(dir), process.pid), 'the read armed the backoff');
    const dials = await countDials(async () => {
      const r = await c.task.create({ spec: 'x' });
      assert.strictEqual(r.pid, process.pid, 'the write was answered by the owner');
    });
    assert.ok(dials >= 1, 'a write dials despite the backoff');
    assert.ok(owner.seen.includes('task.create'), 'the write was sent');
    await c.close();
  } finally { if (owner) owner.close(); unresponsive.reset(); cleanup(dir); }
});

test('backoff: reads skip the dial for 10 s, re-dial once after it, and an answer clears the mark', async () => {
  const dir = sandbox();
  let owner = null;
  let now = 1000000;
  let delay = 900;
  try {
    unresponsive.reset();
    unresponsive.setClock(() => now);
    owner = await slowOwner(dir, () => delay);
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const dialsOf = fn => countDials(fn);
    assert.strictEqual(await dialsOf(() => c.memory.list({})), 1, 'first read dials and times out');
    now += 5000;
    assert.strictEqual(await dialsOf(async () => { await c.memory.list({}); await c.memory.list({}); }), 0, 'inside the backoff: no dial');
    now += 5001; // 10001 ms after the mark
    assert.strictEqual(await dialsOf(() => c.memory.list({})), 1, 'after the backoff: one dial, which times out again');
    assert.ok(unresponsive.get(pipeName(dir), process.pid), 'the timeout re-armed the backoff');
    now += 3000;
    assert.strictEqual(await dialsOf(() => c.memory.list({})), 0, 're-armed: no dial');
    now += 10000;
    delay = 0; // the owner recovers
    assert.strictEqual(await dialsOf(async () => { const r = await c.memory.list({}); assert.strictEqual(r.pid, process.pid, 'answered by the owner'); }), 1);
    now -= 20000; // even a clock that went back finds no mark: an answer cleared it
    assert.strictEqual(unresponsive.get(pipeName(dir), process.pid), null);
    await c.close();
  } finally { if (owner) owner.close(); unresponsive.reset(); cleanup(dir); }
});

// A socket whose connect never completes, to see what the code does with it when its timer fires.
function withFakeSocket(fn) {
  const real = net.connect;
  const made = [];
  net.connect = () => { const s = new EventEmitter(); s.calls = []; s.unref = () => { s.calls.push('unref'); }; s.destroy = () => { s.calls.push('destroy'); }; s.write = () => {}; made.push(s); return s; };
  return Promise.resolve().then(() => fn(made)).finally(() => { net.connect = real; });
}

test('a dial that times out unrefs its socket before destroying it (client.cjs)', async () => {
  await withFakeSocket(async made => {
    const c = new Client(sandbox(), { elect: false, connectRetries: 1, dialTimeoutMs: 50 });
    await assert.rejects(c._dial(50), e => e.code === 'E_TIMEOUT');
    assert.deepStrictEqual(made[0].calls, ['unref', 'destroy']);
  });
});

test('a ping that times out unrefs its socket (ping.cjs)', async () => {
  await withFakeSocket(async made => {
    const r = await ping(sandbox(), 50);
    assert.strictEqual(r.code, 'E_TIMEOUT');
    assert.ok(made[0].calls.includes('unref'), made[0].calls.join());
  });
});

test('during the backoff: the status rung names the mark and its time and sends no ping', async () => {
  const dir = sandbox();
  let owner = null;
  try {
    unresponsive.reset();
    owner = await slowOwner(dir, () => 900);
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await c.memory.list({}); // the answer times out: backoff armed
    const pings = () => owner.seen.filter(m => m === 'ping').length;
    const before = pings();
    const st = await c.status.get({});
    const rung = st.rungs.find(r => r.rung === 'owner-alive');
    assert.strictEqual(rung.established, false);
    assert.match(rung.by, /marked unresponsive at \d{4}-.* \(answer timed out\), no ping sent until \d{4}-/);
    assert.doesNotMatch(rung.by, /bounded ping over/);
    assert.strictEqual(rung.detail.ping_ms, null);
    assert.strictEqual(pings(), before, 'status sent no ping');
    await c.close();
  } finally { if (owner) owner.close(); unresponsive.reset(); cleanup(dir); }
});

test('during the backoff a vector read still pings, and against a wedged owner fails within the ping bound with E_OWNER_LOST', async () => {
  const dir = sandbox();
  let child = null;
  try {
    child = await startOwner('owner-wedged.cjs', dir, ['12000']);
    await new Promise(r => setTimeout(r, 700));
    unresponsive.reset();
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await c.memory.list({}); // arms the backoff
    assert.ok(unresponsive.get(core('index.cjs').pipeName(dir), child.pid), 'backoff armed');
    for (const call of [() => c.memory.search({ query: 'which process?' }), () => c.memory.store({ text: 'x' })]) {
      const t0 = Date.now();
      await assert.rejects(call(), e => {
        assert.strictEqual(e.code, 'E_OWNER_LOST', `${e.code}: ${e.message}`);
        assert.match(e.message, /did not answer a 300 ms ping/);
        return true;
      });
      assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
    }
    await c.close();
  } finally {
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test('a healthy owner: every read is dialled once and answered by the owner, never marked', async () => {
  const dir = sandbox();
  let child = null;
  try {
    child = await startOwner('owner-proc.cjs', dir);
    unresponsive.reset();
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const dials = await countDials(async () => {
      for (let i = 0; i < 6; i += 1) {
        const s = await c.status.get({});
        assert.strictEqual(s.established_by, 'owner', `read ${i} was not answered by the owner: ${s.established_by}`);
        await c.memory.list({});
      }
    });
    assert.strictEqual(dials, 1, 'one connection, kept for every read');
    await c.close();
    const k = new Client(dir, { elect: false, connectRetries: 1, caller: callerFor('orchestrator') });
    await k.connect();
    await k.shutdown();
  } finally {
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test('a process that does 6 reads against a wedged owner and returns from main exits within 3 s', async () => {
  const dir = sandbox();
  let owner = null;
  try {
    owner = await startOwner('owner-wedged.cjs', dir, ['20000']);
    await new Promise(r => setTimeout(r, 700));
    const t0 = Date.now();
    const reader = spawn(process.execPath, [`${FIX}/wedged-reads.cjs`, dir, '6'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    reader.stdout.on('data', d => { out += d; });
    const code = await new Promise(res => reader.once('exit', res));
    const ms = Date.now() - t0;
    assert.strictEqual(code, 0, out);
    const j = JSON.parse(out.trim());
    assert.strictEqual(j.reads.length, 6);
    assert.ok(ms < 3000, `the reader process took ${ms} ms to exit (reads: ${JSON.stringify(j.reads)})`);
  } finally {
    if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});
