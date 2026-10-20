'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// review-claim.test.cjs — `belay memory review` under a store-level claim, and its detached launcher (`--start`). The claim is what
// keeps a second review (the panel's button after a reload, or the same command by hand) from paying for a second Opus reviewer, and what
// lets the next review find and stop the child of a review whose process died. The process facts (pid check, creation time, kill,
// detach, signals) come through the stage seam; the built CLI runs once for real with the fake executable.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { setup } = require('../core/lifecycle-env.cjs');
const { cleanup, callerFor } = require('../core/helpers.cjs');
const { Store } = require('../../src/core/store.cjs');
const { Engine } = require('../../src/core/engine.cjs');
const { run } = require('../../src/cli/cmd-memory.cjs');
const { ROOT, CLI } = require('./stop-helpers.cjs');

const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const RUN = 'lc-apply';
const cmd = (T, argv, stageDeps) => run({ argv, cwd: T.dir, dataDir: T.dir, dataDirGiven: true, stageDeps });
async function planted(fn) {
  const T = await setup();
  await T.endOthers('apply'); // the review waits for any other live run (audit D35)
  try { return await fn(T); } finally { try { T.store.close(); } catch { /* closed by the test */ } cleanup(T.dir); }
}
async function holdOne(T) {
  const n = T.note('held by the scrubber', { reported_wrong: [T.report()] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader throws', cites: [T.cite] }], scope: [n], ...T.evidence });
  return n;
}
// A short-lived engine over the planted store, for the writes a test makes as another process would.
async function asEngine(T, fn) {
  const s = new Store(`${T.dir}/memory.db`, { stamp: true });
  try { return await fn(new Engine({ dataDir: T.dir, store: s, getEmbedder: null, owner: null, establishedBy: 'test' }), s); } finally { s.close(); }
}
const plantClaim = (T, a) => asEngine(T, (E) => E.handle('memory.reviewClaim', { caller: callerFor('operator', { run_id: RUN }), project: 'lc', image: 'node.exe', job: 'archreview-old', ...a }));
const claims = (T) => asEngine(T, (E, s) => s.p("SELECT id, ok, code, worker_id, message FROM memory_event WHERE kind = 'review_claim' ORDER BY seq").all().map((r) => ({ ...r, m: JSON.parse(r.message) })));
function fakeManager({ answer = JSON.stringify({ verdicts: [] }), hold = false } = {}) {
  const m = { spawned: [], stopped: [], stopModes: [], waits: 0 };
  m.spawn = async (a) => { m.spawned.push(a); m.rec = { lastAssistantText: answer, costUsd: 0.01, pid: 424242 }; return {}; };
  m.wait = hold ? () => new Promise((res) => { m.waits += 1; m.release = res; }) : async () => ({ event: 'turn_end', is_error: false, timed_out: false });
  m.stop = async ({ worker_id, mode }) => { m.stopped.push(worker_id); m.stopModes.push(mode || null); if (m.release) m.release({ event: 'stopped', is_error: true, timed_out: false }); };
  m._worker = () => m.rec;
  return m;
}
const never = () => assert.fail('no child may be spawned');
const base = ['review', '--run', RUN, '--worktree'];

test('a review takes the claim with this process\'s pid and creation time, runs, and releases it with the outcome; the next review is free', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const seam = { createdOf: async () => ({ created: 5555, image: 'node.exe' }), makeManager: async () => fakeManager({ answer: JSON.stringify({ verdicts: [] }) }) };
    const r = await cmd(T, [...base, T.repo, '--all'], seam);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.claim.pid, r.json.claim.released, r.json.claim.took_over], [process.pid, true, null]);
    assert.match(r.text, /claim: me-\S+ \(pid \d+, job archreview-lc-apply-\S+\) released/);
    const evs = await claims(T);
    assert.deepStrictEqual(evs.map((e) => [e.ok, e.m.phase]), [[1, 'claim'], [1, 'release']]);
    assert.deepStrictEqual([evs[0].m.pid, evs[0].m.created, evs[0].worker_id], [process.pid, 5555, r.json.job]);
    const again = await cmd(T, [...base, T.repo, '--all'], { ...seam, makeManager: async () => fakeManager() });
    assert.strictEqual(again.code, 0, again.text);
    assert.strictEqual((await claims(T)).length, 4);
  });
});

test('a failed review releases the claim with the code that failed it, so the panel can say what happened', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const r = await cmd(T, [...base, T.repo, '--all'], { createdOf: async () => null, makeManager: async () => fakeManager({ answer: 'not a hand-back at all' }) });
    assert.strictEqual(r.code, 1);
    const evs = await claims(T);
    assert.deepStrictEqual([evs[1].ok, evs[1].code], [0, 'E_ARGS']);
    assert.strictEqual(evs[0].m.created, null, 'an unreadable creation time is recorded as unknown, not guessed');
  });
});

test('a live claim refuses a second review: nothing is spawned, the holder is named, and the claim stays', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    for (const [name, created, seamCreated] of [['identity matches', 777, async () => ({ created: 777 })], ['no creation time on the claim', null, async () => ({ created: 1 })], ['the snapshot cannot read it', 777, async () => null]]) {
      const c = (await plantClaim(T, { pid: 424299, created, job: `archreview-live-${created}` })).claim;
      const r = await cmd(T, [...base, T.repo, '--all'], { pidAlive: () => true, createdOf: seamCreated, makeManager: never });
      assert.strictEqual(r.code, 1, name);
      assert.deepStrictEqual([r.json.error.code, r.json.error.claim.id], ['E_BUSY', c.id], name);
      assert.match(r.text, /already running \(pid 424299/);
      await asEngine(T, (E) => E.handle('memory.reviewRelease', { caller: callerFor('operator', { run_id: RUN }), project: 'lc', claim_id: c.id, ok: true }));
    }
  });
});

test('a dead claim (no pid, or the pid reused by another process) is taken over and recorded, and its orphaned child is killed by exact identity', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    for (const [name, seam] of [['pid gone', { pidAlive: (p) => p === process.pid }], ['pid reused', { pidAlive: () => true, createdOf: async (p) => (p === process.pid ? { created: 9 } : { created: 200 }) }]]) {
      const old = (await plantClaim(T, { pid: 424301, created: 100, job: `archreview-orphan-${name.replace(' ', '-')}` })).claim;
      await asEngine(T, (E) => E.handle('worker.write', { caller: callerFor('orchestrator', { run_id: RUN }), id: old.job, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-orphan', last_event_at: Date.now() }));
      const killed = [];
      const r = await cmd(T, [...base, T.repo, '--all'], { ...seam, createdOf: seam.createdOf || (async () => ({ created: 9 })), killMany: async (targets) => { killed.push(...targets); return targets.map((t) => ({ pid: t.pid, killed: true })); }, makeManager: async () => fakeManager() });
      assert.strictEqual(r.code, 0, `${name}: ${r.text}`);
      assert.deepStrictEqual(killed.map((t) => t.pid), [process.pid], `${name}: the orphan child is killed by the pid and identity on its worker row`);
      assert.strictEqual(r.json.claim.took_over, old.id, name);
      assert.match(r.json.notes[0], /took over the dead claim .*killed orphan pid [0-9]+/);
      const evs = (await claims(T)).filter((e) => e.m.phase === 'claim');
      assert.strictEqual(evs[evs.length - 1].m.replaced.id, old.id, `${name}: the takeover names what it replaced`);
    }
  });
});

test('a dead claim whose child could not be killed is not taken over: no second reviewer starts, the command exits 1, and the dead claim stays', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const old = (await plantClaim(T, { pid: 424301, created: 100, job: 'archreview-stuck' })).claim;
    await asEngine(T, (E) => E.handle('worker.write', { caller: callerFor('orchestrator', { run_id: RUN }), id: old.job, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-stuck', last_event_at: Date.now() }));
    // The claimant is gone (only this process answers a pid check) but the child, which is this process, cannot be stopped.
    const seam = { pidAlive: (p) => p === process.pid, createdOf: async () => ({ created: 9 }), killMany: async (targets) => targets.map((t) => ({ pid: t.pid, killed: false, detail: 'refused: unverifiable' })), makeManager: never };
    const r = await cmd(T, [...base, T.repo, '--all'], seam);
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(r.json.error.code, 'E_BUSY');
    assert.match(r.text, /still alive and could not be stopped \(orphan pid \d+ of job archreview-stuck was not killed: refused: unverifiable\)/);
    const evs = await claims(T);
    assert.deepStrictEqual(evs.map((e) => [e.id, e.m.phase]), [[old.id, 'claim']], 'no claim or release was written; the dead claim is still the newest');
  });
});

test('a signal during the review fast-closes it: the child is killed, the claim is released as failed E_ABORTED, and the handlers are removed', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const signals = new EventEmitter();
    const m = fakeManager({ hold: true });
    const p = cmd(T, [...base, T.repo, '--all'], { createdOf: async () => null, signals, makeManager: async () => m });
    while (!m.waits) await new Promise((res) => setImmediate(res)); // the real event: the child is running and waited on
    assert.deepStrictEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].map((s) => signals.listenerCount(s)), [1, 1, 1, 1]);
    signals.emit('SIGTERM');
    const r = await p;
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(r.json.error.code, 'E_ABORTED');
    assert.ok(m.stopModes.includes('kill'), 'the child was killed (by the manager, which holds its exact pid)');
    const evs = await claims(T);
    assert.deepStrictEqual([evs[1].ok, evs[1].code], [0, 'E_ABORTED']);
    assert.deepStrictEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].map((s) => signals.listenerCount(s)), [0, 0, 0, 0]);
  });
});

test('--start checks, launches the same command detached with the run and data dir, waits for the claim as proof, and exits', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    let spawned = null;
    const seam = {
      spawnDetached: (a) => { spawned = a; setTimeout(() => { void plantClaim(T, { pid: 424310, created: 1, job: 'archreview-detached' }); }, 30); return { pid: 424310, exited: () => undefined }; },
      makeManager: never,
    };
    const r = await cmd(T, ['review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start'], seam);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.started, r.json.pid, r.json.job, r.json.project], [true, 424310, 'archreview-detached', 'lc']);
    assert.match(r.text, /archive review of lc started: pid 424310, job archreview-detached, claim me-/);
    const a = spawned.args;
    assert.deepStrictEqual(a.slice(1, 8), ['memory', 'review', '--project', 'lc', '--run', RUN, '--data']);
    assert.ok(a.includes('--worktree') && !a.includes('--start'), 'the detached command is the review itself, not another launcher');
    // The launcher holds no store: no owner lock outlives it.
    assert.ok(!fs.existsSync(`${T.dir}/owner.lock`));
  });
});

test('--start: a launch that exits before claiming, or never claims in time, or finds a live claim, is exit 1 with the cause', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const early = await cmd(T, ['review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start'], { spawnDetached: () => ({ pid: 424320, exited: () => 3 }) });
    assert.strictEqual(early.code, 1);
    assert.match(early.text, /exited \(3\) before it took the claim/);
    const slow = await cmd(T, ['review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start'], { spawnDetached: () => ({ pid: 424321, exited: () => undefined }), startWaitMs: 300 });
    assert.deepStrictEqual([slow.code, slow.json.error.code], [1, 'E_TIMEOUT']);
    const live = (await plantClaim(T, { pid: process.pid, created: 1, job: 'archreview-running' })).claim;
    const busy = await cmd(T, ['review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start'], { createdOf: async () => ({ created: 1 }), spawnDetached: () => assert.fail('a live review is never started over') });
    assert.deepStrictEqual([busy.code, busy.json.error.code, busy.json.error.claim.id], [1, 'E_BUSY', live.id]);
    const none = await cmd(T, ['review', '--project', 'no-such', '--start'], { spawnDetached: () => assert.fail('no run') });
    assert.strictEqual(none.code, 1);
    assert.match(none.text, /no ended run with notes on exists/);
  });
});

test('the built CLI: --start launches a real detached review that outlives the launcher, owns its child, and releases the claim with the outcome', async () => {
  await planted(async (T) => {
    const n = await holdOne(T);
    T.store.close();
    const env = { ...process.env, BELAY_TEST_MODE: '1', BELAY_CLAUDE_EXE: FAKE, BELAY_TEST_SKIP_EMBEDDER_WARMUP: '1' };
    const r = spawnSync(process.execPath, [CLI, 'memory', 'review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start', '--data', T.dir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env, timeout: 120000 });
    const j = JSON.parse(r.stdout || r.stderr);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(j.started === true || j.ended, JSON.stringify(j));
    assert.notStrictEqual(j.pid, process.pid);
    // The launcher is gone; the detached CLI releases the claim when its review ends. Wait for that real event.
    const t0 = Date.now();
    let release = null;
    while (!release && Date.now() - t0 < 100000) {
      release = (await claims(T)).find((e) => e.m.phase === 'release');
      if (!release) await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(release, 'the detached review released its claim');
    assert.strictEqual(release.worker_id, j.job);
    assert.deepStrictEqual([release.ok, release.code], [0, 'E_ARGS'], 'the fake executable echoes, which is not a hand-back: the failure is the recorded outcome');
    const evs = await claims(T);
    assert.strictEqual(evs[0].m.pid, j.pid, 'the claim is the detached CLI\'s own pid');
    await asEngine(T, (E, s) => {
      const w = s.p("SELECT id, state FROM worker WHERE id = ? ORDER BY seq DESC").all(j.job);
      assert.ok(w.length && ['stopped', 'dead'].includes(w[0].state), `the child the detached CLI spawned ended: ${JSON.stringify(w[0])}`);
      assert.strictEqual(s.p('SELECT json_extract(body, \'$.state\') AS st FROM memory_entries WHERE id = (SELECT id FROM memory_entries WHERE type = \'held\' AND json_extract(body, \'$.note_id\') = ?)').get(n).st, 'held', 'a failed review leaves the hold');
    });
    // The owner is shut down by the detached CLI before it exits; give it its moment, then nothing holds the store.
    const t1 = Date.now();
    while (fs.existsSync(`${T.dir}/owner.lock`) && Date.now() - t1 < 15000) await new Promise((res) => setTimeout(res, 100));
    assert.ok(!fs.existsSync(`${T.dir}/owner.lock`), 'no owner outlives the detached review');
  });
});

test('belay notices reads the claim back: a running review, an interrupted one (its pid gone) and an ended one for 24 hours', async () => {
  const N = require('../../src/cli/cmd-notices.cjs');
  const now = Date.now();
  const claim = { id: 'me-1', pid: 77, job: 'archreview-r-1', at: now - 5000 };
  const mk = (st) => N.reviewEvents({ reviews: { acme: st } }, 'r-1', now);
  const run1 = mk({ state: 'running', claim, pid_alive: true, established_by: 'x' });
  assert.deepStrictEqual([run1[0].kind, run1[0].project, run1[0].pid, run1[0].pid_alive], ['review_running', 'acme', 77, true]);
  assert.match(N.renderText(run1), /archive review of acme running: pid 77, job archreview-r-1/);
  assert.match(N.renderText(mk({ state: 'running', claim, pid_alive: false })), /INTERRUPTED/);
  const done = mk({ state: 'ended', claim, release: { at: now - 1000, ok: false, code: 'E_TIMEOUT', summary: 'did not finish', job: 'archreview-r-1' } });
  assert.deepStrictEqual([done[0].kind, done[0].ok, done[0].code], ['review_ended', false, 'E_TIMEOUT']);
  assert.match(N.renderText(done), /archive review of acme FAILED E_TIMEOUT: did not finish/);
  assert.deepStrictEqual(mk({ state: 'ended', claim, release: { at: now - 25 * 3600 * 1000, ok: true } }), [], 'an old outcome is not shown');
  assert.deepStrictEqual(N.reviewEvents(null, 'r-1'), []);
  await planted(async (T) => {
    T.store.close();
    await plantClaim(T, { pid: 424399, created: 1, job: 'archreview-planted' });
    const r = await N.run({ argv: [RUN], cwd: T.dir, dataDir: T.dir, dataDirGiven: true });
    assert.strictEqual(r.code, 0, r.text);
    const ev = r.json.events.find((e) => e.kind === 'review_running');
    assert.deepStrictEqual([ev.project, ev.pid, ev.job, ev.pid_alive], ['lc', 424399, 'archreview-planted', false]);
    assert.match(r.text, /INTERRUPTED/);
  });
});

test('notices and status count unsupported notes apart from the holds that carry a warning', () => {
  const N = require('../../src/cli/cmd-notices.cjs');
  const ev = N.heldEvents({ total: 8, unsupported: 3, by_project: { acme: 8 }, oldest_age_runs: 2, newest_at: 1 }, 'r-1');
  assert.deepStrictEqual([ev[0].count, ev[0].unsupported], [8, 3]);
  assert.match(N.renderText(ev).split(/\s+/).join(' '), /5 held as wrong or duplicate · 3 unsupported awaiting review, oldest 2 runs/);
  assert.match(require('../../src/cli/panel-common.cjs').heldText({ total: 3, unsupported: 3, by_project: { acme: 3 }, oldest_age_runs: 1 }), /^3 unsupported awaiting review, oldest 1 run:/);
});

test('--start judges a running claim by pid AND creation time: a reused pid does not block the launcher, an unprovable one does', async () => {
  await planted(async (T) => {
    await holdOne(T);
    T.store.close();
    const old = (await plantClaim(T, { pid: process.pid, created: 100, job: 'archreview-reused' })).claim; // the pid answers, but it is another process now
    const args = ['review', '--project', 'lc', '--run', RUN, '--worktree', T.repo, '--start'];
    const unprovable = await cmd(T, args, { createdOf: async () => null, spawnDetached: () => assert.fail('an unprovable claim is never taken over') });
    assert.deepStrictEqual([unprovable.code, unprovable.json.error.code], [1, 'E_BUSY']);
    const sameImageOther = await cmd(T, args, { createdOf: async () => ({ created: 100, image: 'other.exe' }), spawnDetached: () => assert.fail('same creation time, another image: not proven dead') });
    assert.strictEqual(sameImageOther.code, 1);
    assert.match(sameImageOther.text, /its image is other\.exe/);
    const reused = await cmd(T, args, {
      createdOf: async () => ({ created: 999, image: 'node.exe' }),
      spawnDetached: () => { setTimeout(() => { void plantClaim(T, { pid: 424330, created: 1, job: 'archreview-new', replaces: old.id }); }, 30); return { pid: 424330, exited: () => undefined }; },
    });
    assert.strictEqual(reused.code, 0, reused.text);
    assert.strictEqual(reused.json.pid, 424330);
  });
});
