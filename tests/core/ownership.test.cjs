'use strict';
// ownership.test.cjs — election, the pipe, copy-then-read and the three prototype defects this lift
// had to fix: a call with no deadline, an unsafe stale-lock takeover, and a worker that could elect.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid, listDataDir, runFixture, startOwnerProcess, stopOwnerProcesses, trackOwnerChild, sleep, FIXTURES } = require('./helpers.cjs');

const { openCore, pipeName, pidAlive } = core('index.cjs');
const { Client } = core('client.cjs');
const { acquireLock, readOwnerLock } = core('lock.cjs');
const { ping, request } = core('ping.cjs');

const SIDECARS = f => f.endsWith('-wal') || f.endsWith('-shm');

// The owner from `slow-owner.cjs`, whose listen is held back so a test can dial into the window between
// winning the lock and serving the pipe. Returned before it is ready, which is the whole point, and the
// window stays open until `release()` rather than for a fixed number of milliseconds a busy machine can
// spend before this process has even reached its own `acquireLock`.
function startSlowOwner(dir, releaseFile) {
  const { spawn } = require('node:child_process');
  const child = trackOwnerChild(spawn(process.execPath, [path.join(FIXTURES, 'slow-owner.cjs'), dir, releaseFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  let buf = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the slow owner never reported ready')), 20000);
    child.stdout.on('data', d => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      const info = JSON.parse(buf.slice(0, i));
      if (info.ready) resolve(info); else reject(new Error('the slow owner failed to start: ' + JSON.stringify(info)));
    });
    child.once('error', e => { clearTimeout(timer); reject(e); });
  });
  const exited = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  ready.catch(() => { /* a test that fails before awaiting this must not also die of an unhandled rejection */ });
  const release = () => fs.writeFileSync(releaseFile, 'listen');
  return { child, ready, exited, release };
}

test('a write elects an owner in-process, and shutdownOwner is what stops it', async (tcx) => {
  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => c.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => c.close()));
    assert.strictEqual(c.isOwner(), false, 'openCore takes no lock');
    assert.strictEqual(c.ownerInfo(), null);
    assert.deepStrictEqual(listDataDir(dir), [], 'openCore creates no file');

    await c.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(c.isOwner(), true);
    const info = c.ownerInfo();
    assert.strictEqual(info.pid, process.pid);
    assert.strictEqual(info.alive, true);
    assert.strictEqual(info.pipe, pipeName(dir));
    assert.ok(fs.existsSync(path.join(dir, 'owner.lock', 'owner.json')));
    assert.strictEqual(readOwnerLock(dir).pid, process.pid);

    const stop = await c.shutdownOwner();
    assert.strictEqual(stop.stopped, 'in-process');
    assert.strictEqual(stop.pid, process.pid);
    assert.strictEqual(c.isOwner(), false);
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'a clean stop releases the lock');
    assert.deepStrictEqual(listDataDir(dir).filter(SIDECARS), [], 'a clean stop leaves no WAL sidecars');
    await c.close();
  } finally { cleanup(dir); }
});

test('a worker-role core never elects: no owner means E_NO_OWNER and no lock', async (tcx) => {
  const dir = sandbox();
  try {
    const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
    tcx.after(() => Promise.resolve().then(() => w.close()));
    await assert.rejects(w.memory.store({ text: 'nope', embedding: [1, 0], embedding_model: 'm', dim: 2 }), e => {
      assert.strictEqual(e.code, 'E_NO_OWNER');
      assert.strictEqual(e.detail.elect, false);
      return true;
    });
    assert.deepStrictEqual(listDataDir(dir), [], 'a refused worker write creates no lock and no store');
    await w.close();
  } finally { cleanup(dir); }
});

test('copy-then-read answers with no owner alive and leaves nothing behind', async (tcx) => {
  const dir = sandbox();
  try {
    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => o.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => o.close()));
    await o.run.attach({ adapter_pid: process.pid });
    await o.memory.store({ namespace: 'ns', text: 'written while an owner existed', embedding: [1, 0], embedding_model: 'm', dim: 2 });
    await o.shutdownOwner();
    await o.close();

    const before = listDataDir(dir);
    assert.deepStrictEqual(before.filter(SIDECARS), []);
    const beforeMtime = fs.statSync(path.join(dir, 'memory.db')).mtimeMs;

    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()));
    const rows = await reader.memory.list({ namespace: 'ns' });
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].text, 'written while an owner existed');

    const st = await reader.status.get({});
    assert.strictEqual(st.established_by, 'copy', 'rows came from a copy, and status says so');
    assert.strictEqual(reader.isOwner(), false, 'a read never elects');

    assert.deepStrictEqual(listDataDir(dir), before, 'reading created no file in the data dir');
    assert.deepStrictEqual(listDataDir(dir).filter(SIDECARS), [], 'no -wal or -shm beside the live store');
    assert.strictEqual(fs.statSync(path.join(dir, 'memory.db')).mtimeMs, beforeMtime, 'reading never wrote');
    await reader.close();
  } finally { cleanup(dir); }
});

test('every Core method is reachable over the pipe against an owner in another process', async (tcx) => {
  const dir = sandbox();
  let owner = null;
  try {
    owner = await startOwnerProcess(dir);
    assert.strictEqual(readOwnerLock(dir).pid, owner.child.pid);

    const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => orch.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => orch.close()));
    const attached = await orch.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(attached.run.epoch, 1);
    assert.strictEqual(orch.isOwner(), false, 'a live owner is used, never displaced');

    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    const t = await orch.task.create({ spec: 'over the pipe', files_owned: ['a'] });
    const a = await orch.task.assign({ task_id: t.id, worker_id: 'w1' });

    const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
    tcx.after(() => Promise.resolve().then(() => w.close()));
    const ck = await w.continuity.checkpoint({ task_id: t.id, summary: 'over the pipe', next_step: 'keep going' });
    assert.strictEqual(ck.source, 'worker');
    assert.strictEqual(ck.written_by, 'w1');
    await assert.rejects(w.task.create({ spec: 'not mine' }), e => e.code === 'E_ROLE');
    const renewed = await w.lease.renew({ lease_id: a.new_lease.id });
    assert.ok(renewed.expires_at >= a.new_lease.expires_at);

    // Vectors cross the pipe as base64 float32 and come back as scores, not as arrays.
    const stored = await orch.memory.store({ namespace: 'run/test-run', text: 'vector over the wire', embedding: [0.6, 0.8], embedding_model: 'm', dim: 2 });
    const found = await w.memory.search({ query_embedding: [0.6, 0.8], k: 1 });
    assert.strictEqual(found.results[0].id, stored.id);
    assert.ok(found.results[0].score > 0.999);

    const st = await orch.status.get({});
    assert.strictEqual(st.established_by, 'owner');
    const rung = st.rungs.find(r => r.rung === 'owner-alive');
    assert.strictEqual(rung.established, true);
    assert.strictEqual(rung.detail.pid, owner.child.pid);
    assert.strictEqual(rung.detail.pid_alive, true);
    assert.strictEqual(rung.detail.answered, true, 'a pipe is alive only if it answers');

    const stop = await orch.shutdownOwner();
    assert.strictEqual(stop.stopped, 'remote');
    await owner.exited;
    assert.strictEqual(pidAlive(owner.child.pid), false);
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'a pipe shutdown releases the lock too');
    owner = null;

    await w.close();
    await orch.close();
  } finally {
    if (owner) { try { await (await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false })).shutdownOwner(); } catch { /* already gone */ } }
    cleanup(dir);
  }
});

test('a worker cannot stop the owner over the pipe, and an operator can', async (t) => {
  const dir = sandbox();
  // Unconditional, and it runs whether the assertions below pass or throw. A leaked owner child holds
  // this file's runner open with nothing on stdout, so a failure here would stall the suite, not fail it.
  t.after(async () => { await stopOwnerProcesses(dir); cleanup(dir); });
  {
    const owner = await startOwnerProcess(dir);

    // A separate process, so the role is argv rather than a value this test handed to a facade, and the
    // pipe is the real one. Every worker adapter holds a client like this one.
    const refused = JSON.parse((await runFixture('shutdown-attempt.cjs', [dir, 'worker', 'w-probe'])).stdout.trim());
    assert.strictEqual(refused.ok, false, 'a worker adapter must not be able to retire the store owner');
    assert.strictEqual(refused.code, 'E_ROLE');
    assert.strictEqual(refused.detail.role, 'worker');
    assert.deepStrictEqual(refused.detail.allowed, ['orchestrator', 'operator']);
    assert.ok(refused.message.includes('worker'), 'the refusal names the role it came from');

    // The refusal is an effect, not a word: the owner is still alive and still answering.
    assert.strictEqual(pidAlive(owner.child.pid), true);
    assert.strictEqual((await ping(dir, 1000)).ok, true, 'a pipe is alive only if it answers');

    const allowed = JSON.parse((await runFixture('shutdown-attempt.cjs', [dir, 'operator'])).stdout.trim());
    assert.strictEqual(allowed.ok, true, `an operator may stop the owner: ${JSON.stringify(allowed)}`);
    assert.strictEqual(allowed.result.stopped, 'remote');
    // owner.exited was attached at spawn. Waiting on a listener added here instead would miss the
    // event whenever the owner exits before this line runs, and wait for it for ever.
    await owner.exited;
    assert.strictEqual(pidAlive(owner.child.pid), false);
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')));
  }
});

test('a raw socket that sends shutdown with no caller at all is refused', async (t) => {
  const dir = sandbox();
  t.after(async () => { await stopOwnerProcesses(dir); cleanup(dir); });
  {
    const owner = await startOwnerProcess(dir);
    // ADR 0012 §3: the owner trusts the role the client sends, and any local process can send one. What
    // it must never do is act on a request that claims no role whatever.
    const r = await request(dir, 'shutdown', {}, 2000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'E_ROLE');
    assert.strictEqual(r.error.detail.role, null);
    assert.strictEqual(pidAlive(owner.child.pid), true);
    assert.strictEqual((await ping(dir, 1000)).ok, true);
  }
});

test('the lock says listening:false until the pipe is up, and a client dialling that window never hangs', async (t) => {
  const dir = sandbox();
  const releaseFile = `${dir}.release`; // beside the sandbox, never inside it: the data dir holds its own layout and nothing else
  // Teardown opens the window first, so a failed test's owner can still be asked to stop the sanctioned
  // way before the pid backstop is reached, and it runs whatever the assertions did.
  t.after(async () => {
    try { fs.writeFileSync(releaseFile, 'listen'); } catch { /* the test never got that far */ }
    await stopOwnerProcesses(dir);
    try { fs.rmSync(releaseFile, { force: true }); } catch { /* gone */ }
    cleanup(dir);
  });
  {
    const slow = startSlowOwner(dir, releaseFile);

    // The metadata is published the instant the directory is made, because a stale-lock takeover needs a
    // pid to check. What it says is that the owner is not serving yet. The wait is generous because it
    // covers another process's whole startup, and the window it opens does not close until we say so.
    let lock = null;
    for (let i = 0; i < 1500 && !lock; i++) { lock = readOwnerLock(dir); if (!lock) await sleep(20); }
    assert.ok(lock, 'the lock metadata must appear with the lock directory');
    assert.strictEqual(lock.pid, slow.child.pid);
    assert.strictEqual(pidAlive(lock.pid), true);
    assert.strictEqual(lock.listening, false, 'the owner holds the lock but has not reached listen');

    // A read does not dial a pipe nobody is serving: it says so on the ladder and answers from a copy.
    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const t0 = Date.now();
    const st = await reader.status.get({});
    const rung = st.rungs.find(r => r.rung === 'owner-alive');
    // What proves it did not wait on the starting owner is that it never dialled: a busy machine can
    // make any wall-clock bound lie, but a ping that was never sent has no milliseconds to report.
    assert.strictEqual(rung.detail.ping_ms, null, 'no ping is spent on an owner the lock says is still starting');
    assert.ok(Date.now() - t0 < 10000, `status.get must not wait on a starting owner, took ${Date.now() - t0} ms`);
    assert.strictEqual(rung.detail.pid_alive, true);
    assert.strictEqual(rung.detail.listening, false);
    assert.strictEqual(rung.established, false, 'an owner that has not listened is not an owner that answers');
    assert.notStrictEqual(st.established_by, 'owner');

    // A raw dial into the window fails fast rather than hanging on a pipe that does not exist yet.
    const t1 = Date.now();
    const c = new Client(dir, { elect: false, connectRetries: 1, dialTimeoutMs: 400 });
    await assert.rejects(c.connect(), e => { assert.strictEqual(e.code, 'E_NO_OWNER'); return true; });
    assert.ok(Date.now() - t1 < 5000, 'the dial must fail or time out, never hang');
    await c.close();

    // A writer that starts inside the window waits for the real owner instead of electing beside it.
    // It is started here, still inside the window, and the window is closed while it is retrying.
    const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const attaching = orch.run.attach({ adapter_pid: process.pid });
    await sleep(50);
    assert.strictEqual(readOwnerLock(dir).listening, false, 'the writer is retrying against an owner that is still starting');
    slow.release();
    const attached = await attaching;
    assert.strictEqual(attached.run.epoch, 1);
    assert.strictEqual(orch.isOwner(), false, 'the process holding the lock is the owner; the writer waited for it');

    const info = await slow.ready;
    assert.strictEqual(info.pid, slow.child.pid);
    assert.strictEqual(readOwnerLock(dir).listening, true, 'the marker flips only once listen has succeeded');
    assert.strictEqual((await reader.status.get({})).rungs.find(r => r.rung === 'owner-alive').established, true);

    await orch.shutdownOwner();
    await slow.exited;
    await orch.close();
    await reader.close();
  }
});

test('a read gives the owner 300 ms, and a search the owner must embed gives it the long vector bound', async (tcx) => {
  const dir = sandbox();
  const DELAY = 3000; // longer than the read budget (300 ms) by enough that a slow runner's copy read still beats it
  const conns = new Set();
  // An owner that answers everything, slowly. Not wedged: the difference between the two budgets is
  // only visible against a server that does eventually reply.
  const slow = net.createServer(s => {
    conns.add(s);
    s.on('close', () => conns.delete(s));
    let buf = '';
    s.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        const result = req.method === 'memory.search'
          ? { results: [{ id: 'answered-by-the-owner', score: 1 }], scanned: 1, model: 'slow', dim: 2 }
          : { pid: process.pid };
        // MF3-1: a ping is answered at once (a loading owner still answers its pipe); everything else is slow.
        const t = setTimeout(() => { if (!s.destroyed) s.write(JSON.stringify({ id: req.id, result }) + '\n'); }, req.method === 'ping' ? 0 : DELAY);
        t.unref();
      }
    });
  });
  try {
    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => o.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => o.close()));
    await o.memory.store({ namespace: 'ns', text: 'a row from before the slow owner', embedding: [1, 0], embedding_model: 'm', dim: 2 });
    await o.shutdownOwner();
    await o.close();

    await new Promise((res, rej) => { slow.once('error', rej); slow.listen(pipeName(dir), res); });
    fs.mkdirSync(path.join(dir, 'owner.lock'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid, pipe: pipeName(dir), listening: true, acquired_at: Date.now() }));

    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()));
    const t0 = Date.now();
    const listed = await reader.memory.list({ namespace: 'ns' });
    const listMs = Date.now() - t0;
    assert.strictEqual(listed.rows.length, 1, 'the read is answered, from the copy');
    assert.strictEqual(listed.rows[0].text, 'a row from before the slow owner');
    assert.ok(listMs < DELAY, `a plain read waits 300 ms for the owner, not ${listMs} ms`);

    // A text search has no fallback: a copy of the store carries no embedder, so there is nothing to
    // answer with except the owner, and, once it has answered a ping, it is given the long vector bound to load a model and reply.
    const t1 = Date.now();
    const found = await reader.memory.search({ namespace: 'ns', query: 'the owner has to embed this' });
    const searchMs = Date.now() - t1;
    assert.strictEqual(found.results[0].id, 'answered-by-the-owner', 'the answer came from the owner, not a copy');
    assert.ok(searchMs >= DELAY, `the search waited for the owner, ${searchMs} ms`);
    // A search that gave up at the read's 300 ms would not have been answered at all; this only rules out a hang.
    assert.ok(searchMs < 30000, `and answered long before the 100,000 ms vector bound, ${searchMs} ms`);
    await reader.close();
  } finally {
    try { fs.rmSync(path.join(dir, 'owner.lock'), { recursive: true, force: true }); } catch { /* gone */ }
    for (const s of conns) s.destroy();
    await new Promise(r => slow.close(r));
    await sleep(10);
    cleanup(dir);
  }
});

test('a stale lock is taken over by exactly one of several racing processes', async () => {
  const dir = sandbox();
  try {
    const lockDir = path.join(dir, 'owner.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), pipe: 'stale', acquired_at: Date.now() - 60000 }));
    assert.strictEqual(pidAlive(readOwnerLock(dir).pid), false, 'the fixture lock must name a dead pid');

    // Every racer's spawn, attempt and exit is logged, so a failure below carries the race's timeline.
    // The winner holds until this test writes `release`, which it does only once every racer has
    // printed its result or exited: no timer, so a racer whose node startup a loaded machine delays is
    // still racing a live owner, never the lock an owner that already left behind.
    const logPath = path.join(dir, 'race.ndjson');
    const { spawn } = require('node:child_process');
    let reported = 0;
    const releaseOnce = () => { if (++reported === 6) fs.writeFileSync(path.join(dir, 'release'), '1'); };
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(FIXTURES, 'lock-race.cjs'), dir, logPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', errText = '', printed = false;
      child.stdout.on('data', d => { out += d.toString(); if (!printed && out.includes('\n')) { printed = true; releaseOnce(); } });
      child.stderr.on('data', d => { errText += d.toString(); });
      child.on('error', reject);
      child.on('close', code => { if (!printed) { printed = true; releaseOnce(); } resolve({ code, stdout: out, stderr: errText }); });
    })));
    const lines = results.map(r => r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
    const parsed = lines.map(l => l[0]);
    const winners = parsed.filter(p => p && p.won);
    const exits = lines.map(l => l.find(e => e.exit)).filter(Boolean);
    let log = '';
    try { log = fs.readFileSync(logPath, 'utf8'); } catch { /* instrumentation only */ }
    const why = `${JSON.stringify(lines)}\n${log}`;
    assert.strictEqual(winners.length, 1, `exactly one process may take over a stale lock, got ${winners.length}: ${why}`);
    assert.deepStrictEqual(exits.map(e => e.robbed), [null], `the winner held its lock until released, never losing it: ${why}`);
    assert.strictEqual(exits[0].released, true, `the winner left on the release, not on its safety bound: ${why}`);
    assert.strictEqual(readOwnerLock(dir).pid, winners[0].pid, 'the lock names the process that actually won');
  } finally { cleanup(dir); }
});

test('a live lock is never taken over', async () => {
  const dir = sandbox();
  try {
    const mine = acquireLock(dir, { pipe: 'test' });
    assert.strictEqual(mine.won, true);
    fs.writeFileSync(path.join(dir, 'release'), '1'); // a wrongful winner leaves at once, not after 60 s
    const r = JSON.parse((await runFixture('lock-race.cjs', [dir])).stdout.trim().split('\n')[0]);
    assert.strictEqual(r.won, false, 'a lock held by a live pid is not stale');
    assert.strictEqual(readOwnerLock(dir).pid, process.pid);
  } finally {
    try { fs.rmSync(path.join(dir, 'owner.lock'), { recursive: true, force: true }); } catch { /* gone */ }
    cleanup(dir);
  }
});

test('a wedged owner times out instead of hanging, and a read falls back to the copy', async (tcx) => {
  const dir = sandbox();
  // Accept and answer nothing: the Windows wedged-pipe case, where a connect succeeds at the OS level
  // even though the server's code never runs. Connections are tracked so the fixture can be torn down;
  // server.close() alone waits forever on a socket the server never ends.
  const conns = new Set();
  const wedged = net.createServer(s => { conns.add(s); s.on('close', () => conns.delete(s)); });
  try {
    // Give the sandbox a real store first, so the copy fallback has rows to return.
    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => o.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => o.close()));
    await o.memory.store({ namespace: 'ns', text: 'row that predates the wedge', embedding: [1, 0], embedding_model: 'm', dim: 2 });
    await o.shutdownOwner();
    await o.close();

    await new Promise((res, rej) => { wedged.once('error', rej); wedged.listen(pipeName(dir), res); });
    // A lock naming this live process points every caller at the wedged pipe.
    fs.mkdirSync(path.join(dir, 'owner.lock'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid, pipe: pipeName(dir), acquired_at: Date.now() }));

    const c = new Client(dir, { elect: false, connectRetries: 1 });
    tcx.after(() => Promise.resolve().then(() => c.close()));
    await c.connect();
    const t0 = Date.now();
    await assert.rejects(c.call('ping', {}, { timeoutMs: 150 }), e => {
      assert.strictEqual(e.code, 'E_TIMEOUT', 'the prototype hung here forever');
      assert.strictEqual(e.detail.timeout_ms, 150);
      return true;
    });
    // The deadline is 150 ms; the bug is no deadline at all (a hang), so 10 s is far under it and clear of a slow runner.
    assert.ok(Date.now() - t0 < 10000, 'the deadline must fire, not the test runner');

    // api.md §6: a deadline says nothing about whether the owner ran the call. On a write the row may
    // already be committed, and these tables are append-only, so a blind retry would double it. The
    // message has to say so, because the message is what the caller acts on.
    await assert.rejects(c.call('worker.write', { id: 'w-wedged', state: 'starting' }, { timeoutMs: 150 }), e => {
      assert.strictEqual(e.code, 'E_TIMEOUT');
      assert.strictEqual(e.detail.may_have_committed, true);
      assert.match(e.message, /re-read before retrying/);
      return true;
    });
    await assert.rejects(c.call('memory.list', {}, { timeoutMs: 150 }), e => {
      assert.strictEqual(e.code, 'E_TIMEOUT');
      assert.strictEqual(e.detail.may_have_committed, false);
      assert.ok(!/re-read/.test(e.message), 'a read that timed out committed nothing, and must not imply it did');
      return true;
    });
    await c.close();

    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()));
    const rows = await reader.memory.list({ namespace: 'ns' });
    assert.strictEqual(rows.rows.length, 1, 'a timed-out owner falls back to copy-then-read, not to an error');
    const st = await reader.status.get({});
    const rung = st.rungs.find(r => r.rung === 'owner-alive');
    assert.strictEqual(rung.detail.pid_alive, true);
    assert.strictEqual(rung.detail.answered, false);
    assert.strictEqual(rung.established, false, 'a live pid whose pipe never answers is not an owner');
    await reader.close();
  } finally {
    for (const s of conns) s.destroy();
    await new Promise(r => wedged.close(r));
    await sleep(10);
    cleanup(dir);
  }
});
