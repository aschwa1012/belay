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
// dedupes by id in a file, so a replay after a mod reload costs nothing and a gap loses nothing. A claimed wake whose claim was
// released (sweepOwed) is still replayed, so the mod may submit it after worker_wait returned it: at least once, both naming its ref.

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { diffWorkers, wakeText } = require('./wake.cjs');
const { pipeName: ownerPipeName } = require('../core/lock.cjs');
const WR = require('./wake-ref.cjs');

const HEARTBEAT_MS = 5000;
const PLAN_CHECK_POLLS = 10; // ADR 0074 amendment 2: how often an unplanned run's store is asked whether a plan has arrived (about 10 s at the default poll)
const { DEATH_GRACE_MS } = require('./exit-hold.cjs'); // the same value headless uses (orchestrator.cjs)
const RETAIN_MAX = 200;
const RECEIPT_MAX = 2000;
const REF_TAIL_BYTES = 15; // ' (ref xxxxxxxx)': what wake-ref.cjs withRef adds to a claimed wake
const DELIVERY_BOUND_MS = 30000; // how long a claimed policy wake may wait for the mod's delivered-wakes file to name it

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
  core, runId, notes = false, budgetWake = null, dataDir = null, pipeName, pollMs = 1000, isHeld = () => false, onRelease = null, heartbeatMs = HEARTBEAT_MS, now = () => Date.now(), deliveredFile = null, deliveryBoundMs = DELIVERY_BOUND_MS,
}) {
  if (!core || !core.worker || typeof core.worker.list !== 'function') throw new Error('startWakePublisher: core.worker.list is required');
  if (!runId) throw new Error('startWakePublisher: runId is required');
  if (!pipeName) throw new Error('startWakePublisher: pipeName is required');
  const t0 = now();
  const clients = new Set();
  const retained = []; // published lines, oldest first
  const receipt = []; // wakeRecord entries of every published wake, in order
  const queue = []; // derived while held
  const dropped = []; // wakes found but never published because the publisher stopped first; stop() and a pass that ends after it record them
  const stats = { polls: 0, errors: 0, published: 0, held_max: 0, last_error: null, released: [] }; // released: claims given back undelivered, for the receipt
  let baseline = {};
  const deadPids = require('./dead-pids.cjs').createDeadPids({ graceMs: DEATH_GRACE_MS, adapterAlive: (pid) => !!pid && require('../core/lock.cjs').pidAlive(pid) });
  const evalSeen = new Map(); // ADR 0058: release evaluations already carried by a wake
  const planned = require('./planned.cjs').createPlanned({ core, runId }); // whether the run has a plan, from the store: the same rule as the headless run and the adapter
  const noteWatcher = require('./note-wake.cjs').createNoteWatcher({ core, runId, enabled: !!notes }); // wave 4: a refuted note
  const callWatcher = require('./call-wake.cjs').createCallWatcher({ core, runId }); // a still_running integrate or task_evaluate
  const policyWatcher = require('./policy-wakes.cjs').createPolicyWatcher({ core, runId }); // ADR 0073: the exceptions of a run under a plan
  let stallWatch = null; // stall-wake.cjs, made on the first poll
  const quiet = require('./digest-quiet.cjs').createQuiet(); // ADR 0074 amendment 2: when the steps no wake carried are published on their own
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
    if (!uid || (!(w.ev && w.ev.exception) && !planned.value())) return true; // a death is claimed only once a plan is in force
    let won = true;
    try { won = D.claimException({ dataDir, runId, uid }); } catch { won = true; } // a claim that cannot be made delivers: never lose a wake for want of a file
    if (won) owedRef.set(w.id, uid);
    if (won && deliveredFile) owed.set(uid, { id: w.id, at: now() }); // claimed at publish, not yet delivered: swept by sweepOwed
    if (!won) lost.set(uid, w); // kept: if worker_wait's claim is released (its reply was lost), this wake is published after all
    return won;
  };
  const owedRef = new Map(); // wake id -> delivery key, for the claims this publisher took
  const owed = new Map(); // uid -> { id, at }: wakes this publisher claimed that the mod's delivered file has not yet named
  // The claim is taken before the mod has the line, so it must not outlive a delivery that never happened (a failed submit or write, a hooks
  // module that did not load, a line pushed out of the retained set). A wake the delivered file does not name within the bound is released,
  // and worker_wait (ADR 0074 decision 4, the second read path) offers it. `all` is the final sweep at stop: nothing more can arrive.
  function sweepOwed(all = false) {
    if (!owed.size) return;
    const named = new Set();
    try {
      for (const l of fs.readFileSync(deliveredFile, 'utf8').split('\n')) {
        try { const o = JSON.parse(l); if (o && typeof o.id === 'string') named.add(o.id); } catch { /* torn or foreign line */ }
      }
    } catch { /* no file yet: nothing is named */ }
    const D = require('./run-digest.cjs');
    for (const [uid, o] of owed) {
      if (named.has(o.id)) { owed.delete(uid); continue; } // delivered: the claim stands for good
      if (!all && now() - o.at < deliveryBoundMs) continue;
      owed.delete(uid);
      stats.released.push({ uid, wake_id: o.id, after_ms: now() - o.at, at_stop: all });
      try { D.release({ dataDir, runId, uids: [uid] }); } catch { stats.errors += 1; stats.last_error = 'release'; }
    }
  }
  const lost = new Map(); // uid -> the wake another path's claim kept this one from publishing

  // `rider`: a digest folded into this wake's own line ({ text, n }), after the wake's text and its ref, which are never cut. -> true when published.
  function publish(w, rider = null) {
    if (!claimed(w)) return false;
    const ref = owedRef.get(w.id); // a claimed wake carries its delivery key, so a repeat after a release is recognisable (worker_wait names the same key)
    const text = (ref ? WR.withRef(w.text, WR.shortRef(ref)) : w.text) + (rider ? rider.text : '');
    if (receipt.length < RECEIPT_MAX) receipt.push(require('./wake-record.cjs').wakeRecord({ ...(w.ev || {}), event: w.event || (w.ev && w.ev.event), worker_id: w.worker_id, rider }, text, now() - t0, null)); // the run receipt's wakes[], as headless fills it
    const line = `${JSON.stringify({ id: w.id, text })}\n`;
    retained.push(line);
    if (retained.length > RETAIN_MAX) retained.shift();
    stats.published += 1;
    for (const c of clients) send(c, line);
    return true;
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
      if (!d) return true; // read, and nothing new
      const line = `${JSON.stringify({ id: d.id, text: d.text })}\n`;
      retained.push(line); if (retained.length > RETAIN_MAX) retained.shift();
      for (const c of clients) send(c, line);
      return true;
    } catch (e) { stats.errors += 1; stats.last_error = `digest: ${(e && (e.code || e.message)) || e}`; return false; }
  }

  // The digest as the tail of `carrier`'s line, in the room that wake leaves under the 221-byte cap (its text plus a ref, at most). null: no room
  // (nothing is claimed), nothing new, or the read failed (asked again on a later pass).
  async function foldDigest(carrier) {
    try {
      const room = WR.WAKE_TEXT_MAX - Math.min(WR.WAKE_TEXT_MAX, Buffer.byteLength(carrier.text, 'utf8') + REF_TAIL_BYTES);
      return await require('./run-digest.cjs').foldDigest({ core, dataDir, runId, cap: room, now });
    } catch (e) { stats.errors += 1; stats.last_error = `digest: ${(e && (e.code || e.message)) || e}`; return null; }
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
        if (dataDir && !planned.value() && stats.polls % PLAN_CHECK_POLLS === 1) await planned.check(); // amendment 2: the store's plan arms the watcher without waiting for a turn end; read-only, one check every PLAN_CHECK_POLLS polls until a yes
        if (planned.value()) evalSeen.policyArmed = true;
        for (const pw of await policyWatcher.poll(evalSeen)) queue.push({ id: wakeId(runId, pw), text: pw.text, worker_id: pw.worker_id, event: pw.event, paused_at: null, paused_by: null, ev: pw }); // after enrichWakes, which hands it this poll's task rows
        for (const sw of (stallWatch || (stallWatch = require('./stall-wake.cjs').createStallWatcher({ core, runId }))).poll(evalSeen, policyWatcher.snapshot())) queue.push({ id: wakeId(runId, sw), text: sw.text, worker_id: sw.worker_id, event: sw.event, paused_at: null, paused_by: null, ev: sw }); // ADR 0074 amendment 3: open work after a hand-back the plan took
        for (const ev of enriched) {
          const r = byId.get(ev.worker_id) || {};
          // paused_at and paused_by are the row's own pair at derivation: what a resume matches a park against (equality, no clocks)
          queue.push({ id: wakeId(runId, ev), text: wakeText(ev), worker_id: ev.worker_id, event: ev.event, paused_at: r.paused_at == null ? null : r.paused_at, paused_by: ev.paused_by || r.paused_by || null, ev });
        }
      }
      if (stopped) { dropQueued(); return; } // a pass that was awaiting the store when stop() ran: what it just derived goes into the record too
      if (budgetWake) for (const bw of budgetWake.takeWakes()) publish({ id: bw.id, text: bw.text, event: 'budget_pause', ev: bw }); // the budget pause's own wake is the one a hold does not keep back
      sweepOwed();
      if (lost.size) for (const [uid, w] of lost) if (!require('./run-digest.cjs').isClaimed({ dataDir, runId, uid })) { lost.delete(uid); queue.push(w); } // a released claim: publish what it had held back
      if (dataDir && queue.some((q) => q.event === 'death')) await planned.check(); // a death has a second delivery path once the store shows a plan
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
        const armed = dataDir && (evalSeen.policyArmed || planned.value() || !!policyWatcher.snapshot()); // the store's plan, not only a poll that saw a turn end
        const carrier = armed ? queue.filter((q) => require('./digest-wake.cjs').ridesDigest(q.ev || q)).pop() : null; // ADR 0074 amendment 4: the digest rides the last exception or done wake, in that wake's own line
        const rider = carrier ? await foldDigest(carrier) : null;
        while (queue.length) {
          const q = queue.shift();
          if (q !== carrier || !rider) { publish(q); continue; }
          if (!publish(q, rider)) { try { require('./run-digest.cjs').release({ dataDir, runId, digestN: rider.n }); } catch { stats.errors += 1; stats.last_error = 'release'; } } // not published: the steps stay for the next asker
        }
        if (!rider && armed && list) { const k = require('./digest-quiet.cjs').due(quiet, policyWatcher.snapshot(), list.workers || [], runId); if (k && await rideDigest()) require('./digest-quiet.cjs').mark(quiet, k); } // amendment 2: at a quiet moment the steps no wake carried (or no wake had room for) come on their own; a failed read is asked again
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

  // What is still queued (a run pause) or held for its release evaluation is not published once the publisher has stopped:
  // each is recorded with its reason, so no wake found is missing from the receipt. A queued death or exception the run wait already claimed
  // was delivered by that path (ADR 0074 decision 4), so it is left out rather than called unpublished.
  function dropQueued() {
    const D = dataDir ? require('./run-digest.cjs') : null;
    const elsewhere = (q) => { try { const uid = D && D.wakeUid({ ...(q.ev || {}), worker_id: q.worker_id }); return !!uid && D.isClaimed({ dataDir, runId, uid }); } catch { return false; } };
    for (const q of queue.splice(0)) if (!elsewhere(q)) dropped.push({ id: q.id, worker_id: q.worker_id, event: q.event, reason: 'the run ended while this wake was held' });
    for (const ev of require('./release-eval.cjs').drainHeld(evalSeen)) dropped.push({ id: wakeId(runId, ev), worker_id: ev.worker_id, event: ev.event, reason: 'the run ended while this turn end was held for its release evaluation' });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    sweepOwed(true);
    clearTimeout(pollTimer); clearInterval(hbTimer);
    dropQueued();
    for (const c of clients) { try { c.end(); c.destroy(); } catch { /* gone */ } }
    clients.clear();
    await new Promise((r) => { try { server.close(() => r()); } catch { r(); } setTimeout(r, 500).unref(); });
    if (process.platform !== 'win32') { try { fs.unlinkSync(pipeName); } catch { /* none */ } }
  }

  return { pipeName, listening, stop, receipt: () => receipt.slice(), stats: () => ({ ...stats, queued: queue.length, retained: retained.length, clients: clients.size, dropped: dropped.length }), droppedWakes: () => dropped.slice() };
}

module.exports = { startWakePublisher, wakePipeName, wakeId, HEARTBEAT_MS };
