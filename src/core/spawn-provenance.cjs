'use strict';
// spawn-provenance.cjs — ADR 0045 decision 4, the orphan of a process belay spawned. The operator check refuses a peer whose process
// chain passes through a process belay spawned (spawn-register.cjs). A spawned process can leave one behind: it starts a helper, the
// helper's parent exits (a `start /b` in a shell does this), and the helper is a root of its own chain. Once the spawned process has
// exited its register record is gone too, so an owner started later saw a root older than itself and took it for the operator's.
//
// Creation time is the one fact that links the helper to the spawn: the helper was created while the spawned process was running,
// and nothing but a process that is part of that tree (or an unrelated detached process started at that moment) is a root created
// then. So the register keeps a tombstone of an exited process (its lifetime), and `refresh`, given a process snapshot:
//   1. marks the descendants it has recorded as dead when their process is gone,
//   2. finds every root of a chain (a process whose parent is missing or younger than itself) that was created while a spawned
//      process was running, live or exited, or whose parent pid is a process it has recorded, and records it as a descendant,
//   3. drops the tombstones of exited processes, because everything alive that they could reach is now recorded, and
//   4. returns the descendants that are alive, which the operator check treats as spawned processes.
// A process that belay did not spawn but that was created in the same interval with no live parent (a tool the operator detached
// at that moment) is refused too; the refusal names the spawned process it was taken for. That is the price of not trusting a
// chain that ends at itself, and it ends when the spawned process's tree is gone.
//
// Not covered: a line of descent that is only reachable through two intermediate processes that both died between two refreshes,
// and a process reparented by another tool to one that was never recorded. A same-user process that spoofs its parent is outside the
// check (ADR 0045 "What this does not stop").
//
// Every file call can throw; a refresh that throws is a refusal in the operator check (fail closed). One file that cannot be read is
// not a throw: spawn-register.cjs judges it unproven, a live one refuses what it could cover, and a gone one is moved aside.

const SR = require('./spawn-register.cjs');

const SLACK_MS = 2000; // a process can be created up to this long after the exit time that was read for its parent (two clocks, and the harness hears of an exit late)

const keyOf = (t) => `${t.pid}-${t.created == null ? 0 : t.created}`;
const present = (t, snap) => { const e = snap.get(t.pid); return !!e && (t.created == null || e.created == null || e.created === t.created); };

// A root of a chain, as operator-check.cjs's chainOf ends it: the parent is not in the snapshot, or was created after the child.
function isRoot(pid, e, snap) {
  const p = e.ppid != null && e.ppid !== pid ? snap.get(e.ppid) : null;
  return !p || p.created == null || p.created > e.created;
}

// Was root `e` (pid `pid`) made by, or while, the process `w` ran? `w.window` says whether its whole lifetime counts.
function covers(w, pid, e) {
  if (w.pid === pid && (w.created == null || w.created === e.created)) return false; // the process itself
  if (w.window && e.created >= w.from && (w.until == null || e.created <= w.until + SLACK_MS)) return true;
  // its parent pid is the recorded process: created after it began and, once it has exited, no later than its exit (plus the slack).
  // A pid is reused after an exit, so a root created after the lifetime that names the same pid as its parent has an unrelated parent.
  return e.ppid === w.pid && e.created >= (w.created == null ? w.from : w.created) && (w.until == null || e.created <= w.until + SLACK_MS);
}

// A lifetime that began before the current boot ended with it, and whatever began at the boot is not its child.
function beforeBoot(t, boot) {
  if (t.via == null) return t.from + SR.BOOT_SLACK_MS < boot;
  if (t.via_from != null) return t.via_from + SR.BOOT_SLACK_MS < boot;
  return true; // a descendant tombstone with no via_from is old-code output (operator ruling 2026-10-30): the processes a boot starts were recorded under a worker from before it
}

// -> { alive: [{ pid, created, kind }] } the recorded descendants whose process is alive. The decision is computed from the register's
// files and `snap` and nothing else; with `persist` false (a read command's operator check) nothing is written, and the same files give
// the same answer next time. With it (a writer's check) the retired records, the new descendants and the dropped lifetimes are saved.
function refresh(snap, { now = Date.now(), boot = SR.bootMs(now), persist = true, afterScan = null } = {}) {
  const scan = SR.scan({ snap, now, boot }); // first: the records whose process is gone have lifetimes, read below with the tombstones
  if (afterScan) afterScan(); // test seam: the interleaving between the scan and the settle
  const known = new Map();
  const tombs = SR.tombstoneScan({ snap, now, boot }); // an unproven one is judged against the same snapshot (spawn-register.cjs)
  for (const t of tombs.list) known.set(keyOf(t), t);
  for (const d of scan.dead) if (d.tomb) known.set(keyOf(d.tomb), d.tomb);
  // A dead file that cannot be read still gives a bounded lifetime for this check (its orphans are found below); then it is moved aside.
  for (const u of [...scan.dead.filter((d) => d.unproven).map((d) => d.unproven), ...tombs.dead]) {
    const life = SR.unprovenLife(u, now, boot);
    if (life && !known.has(keyOf(life))) known.set(keyOf(life), life);
  }
  const saves = new Map(); const drops = [];
  for (const [k, t] of [...known]) if (beforeBoot(t, boot)) { known.delete(k); drops.push(t); }
  for (const t of known.values()) if (t.until == null && !present(t, snap)) { t.until = now; saves.set(keyOf(t), t); }
  const lifetimes = [
    ...scan.live.map((r) => ({ pid: r.pid, created: Number.isFinite(r.created) ? r.created : null, from: SR.startOf(r), until: null, kind: r.kind || 'worker', window: true })),
    ...[...known.values()].map((t) => ({ ...t, window: t.via == null && !t.ppid_only })),
  ];
  for (const [pid, e] of snap) {
    if (e.created == null || !isRoot(pid, e, snap) || known.has(`${pid}-${e.created}`)) continue;
    const hit = lifetimes.find((w) => covers(w, pid, e));
    if (!hit) continue;
    const t = { pid, created: e.created, from: e.created, until: null, kind: 'descendant', via: `${hit.kind} pid ${hit.pid}`, via_from: hit.from };
    saves.set(keyOf(t), t);
    known.set(keyOf(t), t);
  }
  const alive = [];
  for (const t of known.values()) {
    if (t.until != null) drops.push(t); // everything alive that it could reach is recorded above
    else alive.push({ pid: t.pid, created: t.created, kind: `descendant of ${t.via}` });
  }
  if (persist) {
    SR.settle(scan.dead, { tombstones: false }); // their lifetimes were used above and are dropped below
    for (const t of saves.values()) if (t.until == null) SR.saveTombstone(t);
    for (const t of drops) SR.dropTombstone(t);
    for (const u of tombs.dead) SR.moveAside(u); // an unproven tombstone whose process is gone: moved aside, never deleted
  }
  return { alive };
}

module.exports = { refresh, isRoot, covers, SLACK_MS };
