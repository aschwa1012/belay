'use strict';
// wake-pipe.cjs — ADR 0037 amendment 5 decision 1. The interactive launcher's wake publisher.
//
// An interactive orchestrator has no stdin we own, so the wake cannot be written to it as headless does.
// The launcher instead derives the same wakes (`diffWorkers` and `wakeText`, src/run/wake.cjs, unchanged)
// from the store's own worker rows, and publishes each as one JSON line, `{ id, text }`, on a named pipe
// that belay owns for the run. `belay wake-stream` (the client) reads it; the belay mod spawns that client.
//
// The pipe carries data only (invariant 8): it accepts no input, and a connection that sends any is cut.
// A heartbeat line `{ "hb": <ms> }` goes out every 5 s so a client can tell a live publisher from a wedged
// one (invariant 7). While `isHeld()` is true wakes are derived and queued but not published; they are
// released in order when it turns false (a run pause holds wakes, ADR 0037 amendment 5 decision 6).
// Every published wake is retained (bounded) and replayed to a client that connects later: the mod
// dedupes by id in a file, so a replay after a mod reload costs nothing and a gap loses nothing.

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { diffWorkers, wakeText } = require('./wake.cjs');
const { pipeName: ownerPipeName } = require('../core/lock.cjs');

const HEARTBEAT_MS = 5000;
const { DEATH_GRACE_MS } = require('./exit-hold.cjs'); // the same value headless uses (orchestrator.cjs)
const RETAIN_MAX = 200;
const RECEIPT_MAX = 2000;

// The run's wake pipe: the store owner's pipe name for this data dir, plus a short hash of the run id and a
// nonce the launcher generates at spawn (ADR 0037 amendment 5: the name is not predictable from the run id, so a
// process that does not know the nonce cannot squat the name before the launcher listens).
function wakePipeName(dataDir, runId, nonce) {
  const base = ownerPipeName(dataDir);
  const h = crypto.createHash('sha1').update(`${runId}\0${nonce || ''}`).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `${base}-wake-${h}` : base.replace(/\.sock$/, `-wake-${h}.sock`);
}

// An id that is a pure function of the row event: a restart of the publisher re-derives the same ids.
const wakeId = (runId, ev) => `${runId}:${ev.worker_id}:${ev.event}:${ev.turn}:${ev.seq}`;

function startWakePublisher({
  core, runId, notes = false, budgetWake = null, dataDir = null, pipeName, pollMs = 1000, isHeld = () => false, onRelease = null, heartbeatMs = HEARTBEAT_MS, now = () => Date.now(),
}) {
  if (!core || !core.worker || typeof core.worker.list !== 'function') throw new Error('startWakePublisher: core.worker.list is required');
  if (!runId) throw new Error('startWakePublisher: runId is required');
  if (!pipeName) throw new Error('startWakePublisher: pipeName is required');
  const t0 = now();
  const clients = new Set();
  const retained = []; // published lines, oldest first
  const receipt = []; // wakeRecord entries of every published wake, in order
  const queue = []; // derived while held
  const stats = { polls: 0, errors: 0, published: 0, held_max: 0, last_error: null };
  let baseline = {};
  const deadPids = require('./dead-pids.cjs').createDeadPids({ graceMs: DEATH_GRACE_MS, adapterAlive: (pid) => !!pid && require('../core/lock.cjs').pidAlive(pid) });
  const evalSeen = new Map(); // ADR 0058: release evaluations already carried by a wake
  const noteWatcher = require('./note-wake.cjs').createNoteWatcher({ core, runId, enabled: !!notes }); // wave 4: a refuted note
  const callWatcher = require('./call-wake.cjs').createCallWatcher({ core, runId }); // a still_running integrate or task_evaluate
  const policyWatcher = require('./policy-wakes.cjs').createPolicyWatcher({ core, runId }); // ADR 0073: the exceptions of a run under a plan
  let wasHeld = false;
  let stopped = false;
  let inFlight = false;
  let pollTimer = null;
  let hbTimer = null;

  const send = (sock, line) => { try { sock.write(line); } catch { clients.delete(sock); } };

  // ADR 0074 decision 4: a policy exception the run wait (worker_wait) already returned is not published again, and the reverse: the claim
  // (run-digest.cjs claimException) is taken at the instant of publishing. Without a data dir there is no wait to share it with.
  const claimed = (w) => {
    const D = dataDir ? require('./run-digest.cjs') : null;
    const uid = D ? D.wakeUid({ ...(w.ev || {}), worker_id: w.worker_id }) : null;
    if (!uid || (!(w.ev && w.ev.exception) && !evalSeen.policyArmed)) return true; // a death is claimed only once a plan is in force
    try { return D.claimException({ dataDir, runId, uid }); } catch { return true; } // a claim that cannot be made delivers: never lose a wake for want of a file
  };

  function publish(w) {
    if (!claimed(w)) return;
    if (receipt.length < RECEIPT_MAX) receipt.push(require('./wake-record.cjs').wakeRecord({ ...(w.ev || {}), event: w.event || (w.ev && w.ev.event), worker_id: w.worker_id }, w.text, now() - t0, null)); // the run receipt's wakes[], as headless fills it
    const line = `${JSON.stringify({ id: w.id, text: w.text })}\n`;
    retained.push(line);
    if (retained.length > RETAIN_MAX) retained.shift();
    stats.published += 1;
    for (const c of clients) send(c, line);
  }

  const server = net.createServer((sock) => {
    sock.on('error', () => { clients.delete(sock); });
    sock.on('close', () => { clients.delete(sock); });
    sock.on('data', () => { sock.destroy(); }); // no input is accepted, ever
    for (const line of retained) send(sock, line);
    clients.add(sock);
    send(sock, `${JSON.stringify({ hb: now() })}\n`);
  });
  server.on('error', (e) => { stats.errors += 1; stats.last_error = `server: ${(e && e.code) || e}`; });

  // The digest rides the next wake as one more wake line (run-digest.cjs): claimed, so the run wait never returns a step this line showed.
  async function rideDigest() {
    try {
      const d = await require('./run-digest.cjs').wakeDigest({ core, dataDir, runId, now });
      if (!d) return;
      const line = `${JSON.stringify({ id: d.id, text: d.text })}\n`;
      retained.push(line); if (retained.length > RETAIN_MAX) retained.shift();
      for (const c of clients) send(c, line);
    } catch (e) { stats.errors += 1; stats.last_error = `digest: ${(e && (e.code || e.message)) || e}`; }
  }

  async function pollOnce() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      let list = null;
      try { list = await core.worker.list({}); } catch (e) { stats.errors += 1; stats.last_error = (e && (e.code || e.message)) || String(e); }
      stats.polls += 1;
      if (stopped) return;
      if (list) {
        list = { ...list, workers: deadPids.apply(list.workers || []) }; // a pid seen dead stays dead (dead-pids.cjs)
        const { events, next } = diffWorkers({ prev: baseline, rows: list.workers || [], runId, nowMs: now() - t0, graceMs: DEATH_GRACE_MS, sinceAt: t0 });
        baseline = next;
        const byId = new Map((list.workers || []).map((w) => [w.id, w]));
        for (const nw of await noteWatcher.poll()) queue.push({ id: nw.id, text: nw.text, worker_id: nw.worker_id, event: nw.event, paused_at: null, paused_by: null, ev: nw });
        for (const cw of await callWatcher.poll()) queue.push({ id: wakeId(runId, cw), text: cw.text, worker_id: cw.worker_id, event: cw.event, paused_at: null, paused_by: null, ev: cw });
        const enriched = await require('./release-eval.cjs').enrichWakes(core, runId, events.filter((e) => !require('./job-prefixes.cjs').isJobId(String(e.worker_id))), evalSeen, { holdMs: require('./release-eval.cjs').holdMs(), now, workers: list.workers || [] }); // ADR 0058 amendment 4: held for its evaluation
        for (const pw of await policyWatcher.poll(evalSeen)) queue.push({ id: wakeId(runId, pw), text: pw.text, worker_id: pw.worker_id, event: pw.event, paused_at: null, paused_by: null, ev: pw }); // after enrichWakes, which hands it this poll's task rows
        for (const ev of enriched) {
          const r = byId.get(ev.worker_id) || {};
          // paused_at and paused_by are the row's own pair at derivation: what a resume matches a park against (equality, no clocks)
          queue.push({ id: wakeId(runId, ev), text: wakeText(ev), worker_id: ev.worker_id, event: ev.event, paused_at: r.paused_at == null ? null : r.paused_at, paused_by: ev.paused_by || r.paused_by || null, ev });
        }
      }
      if (budgetWake) for (const bw of budgetWake.takeWakes()) publish({ id: bw.id, text: bw.text, event: 'budget_pause', ev: bw }); // the budget pause's own wake is the one a hold does not keep back
      stats.held_max = Math.max(stats.held_max, queue.length);
      let held = false;
      try { held = !!isHeld(); } catch { held = true; } // an unreadable hold keeps wakes back, never releases them
      if (held) wasHeld = true;
      else {
        // A hold that ends with a resume (ADR 0037 amendment 5 decision 6): the held `paused` wakes of the workers the
        // resume relaunched describe the pause, not the present, so they are dropped, and one wake of belay's own
        // names the resume and says how many held events follow.
        if (wasHeld) {
          wasHeld = false;
          let info = null;
          try { info = onRelease ? onRelease() : null; } catch { info = null; }
          if (info) {
            // Only the pause's own park wakes go: a `paused` wake whose (paused_at, paused_by) equals the park pair this pause
            // recorded for a worker it relaunched. A later hand pause, a death and every other wake stay.
            const parks = info.parks || [];
            for (let i = queue.length - 1; i >= 0; i -= 1) {
              const q = queue[i];
              if (q.event === 'paused' && parks.some((p) => p.worker_id === q.worker_id && p.paused_at === q.paused_at && p.paused_by === q.paused_by)) queue.splice(i, 1);
            }
            publish({ id: info.id, text: info.text(queue.length) });
          }
        }
        let out = 0;
        while (queue.length) { publish(queue.shift()); out += 1; }
        if (out && dataDir && evalSeen.policyArmed) await rideDigest(); // ADR 0074 decision 4: the steps belay took since the last wake follow the wake
      }
    } finally {
      inFlight = false;
      if (!stopped) { pollTimer = setTimeout(pollOnce, pollMs); pollTimer.unref(); }
    }
  }

  const listening = new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { try { fs.unlinkSync(pipeName); } catch { /* none */ } }
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.off('error', reject);
      server.unref();
      hbTimer = setInterval(() => { const line = `${JSON.stringify({ hb: now() })}\n`; for (const c of clients) send(c, line); }, heartbeatMs);
      hbTimer.unref();
      pollTimer = setTimeout(pollOnce, 0);
      pollTimer.unref();
      resolve();
    });
  });

  listening.catch(() => {}); // the caller reads the failure from `listening`; an unread one must not crash the process

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer); clearInterval(hbTimer);
    for (const c of clients) { try { c.end(); c.destroy(); } catch { /* gone */ } }
    clients.clear();
    await new Promise((r) => { try { server.close(() => r()); } catch { r(); } setTimeout(r, 500).unref(); });
    if (process.platform !== 'win32') { try { fs.unlinkSync(pipeName); } catch { /* none */ } }
  }

  return { pipeName, listening, stop, receipt: () => receipt.slice(), stats: () => ({ ...stats, queued: queue.length, retained: retained.length, clients: clients.size }) };
}

module.exports = { startWakePublisher, wakePipeName, wakeId, HEARTBEAT_MS };
