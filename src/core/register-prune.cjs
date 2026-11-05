'use strict';
// register-prune.cjs — an owner's housekeeping of the spawn register's closed tombstones (spawn-register.cjs, spawn-provenance.cjs).
//
// A tombstone keeps an exited process's lifetime so a check can tell that process's orphans from the operator's tools. Only a check
// for a write ever dropped one, and the client asks for the check with a ping (a read) before its first write, so on a busy machine
// none was dropped: the exited directory grew by every process any harness spawned. A bound owner whose check finds many closed
// tombstones prunes them itself. What it may touch, and nothing else:
//   - spent tombstones only: a valid lifetime whose end (`until`) is set and more than the slack in the past, or an open one (a
//     recorded descendant, `until` null) from before the last boot, which the boot ended (the boot rule a check uses). Never a
//     register record (a live process's entry), never an open tombstone from this boot, never an unreadable file;
//   - before any closed tombstone goes, every live chain root it covers is recorded as a descendant, exactly as a check records one,
//     judged against a process snapshot taken after the tombstones were read;
//   - in two passes at least `gapMs` apart: the first records what the closed lifetimes cover and marks them; a later pass records
//     again from its own snapshot and only then drops what it marked. A check anywhere that lists the directory after the first pass
//     finds the recorded roots whether or not the lifetime is still there. Two owners pruning at once each drop what they marked, and
//     a file already gone is not an error. Nothing is created but the descendant tombstones, in the directory that holds them.
// Started by the owner after a check, on a later turn of its loop, never inside one: the check has answered before the pass lists a
// file, and the pass lists, stats and reads the directory asynchronously. A read
// command's own check still writes nothing; the prune is the owner's write (ADR 0045 amendment 8).
// Fails quiet: a pass that cannot take a snapshot or read the directory leaves everything for the next one.

const SP = require('./spawn-provenance.cjs');
const SR = require('./spawn-register.cjs');

const PRUNE_AT = 50; // closed tombstones a check found before the owner prunes
const PRUNE_GAP_MS = 60000; // at most one pass a minute per owner; a tombstone is dropped no sooner than one gap after it was marked

const keyOf = (t) => `${t.pid}-${t.created == null ? 0 : t.created}`;

// `snapshot()` -> a process snapshot (pid -> { ppid, created, image }) or null.
function createPruner({ snapshot, now = () => Date.now(), at = PRUNE_AT, gapMs = PRUNE_GAP_MS }) {
  let running = null;
  let last = null; // the last pass started, settled or not
  let lastAt = -Infinity;
  const marked = new Map(); // key -> when the pass that first marked the tombstone began
  const run = async () => {
    await new Promise((resolve) => setImmediate(resolve)); // a later turn of the loop: nothing of the pass runs before the check that asked for it has answered
    const { names, list } = await SR.tombstonesAsync(); // the reads come first, off the loop
    const began = now();
    const snap = await snapshot(); // then the snapshot, so every root a listed lifetime covers is in it or already recorded
    if (!snap) return { dropped: 0, saved: 0, marked: marked.size, skipped: 'no snapshot' };
    const boot = SR.bootMs(began);
    // spent: a closed lifetime whose end is past, or an open tombstone from before the last boot (the boot ended that process and
    // everything it could cover, by the boot rule a check uses)
    const closed = list.filter((t) => (t.until != null && t.until + SP.SLACK_MS < began) || (t.until == null && SP.beforeBoot(t, boot)));
    const known = new Set(names.map((n) => n.replace(/[.]json$/, ''))); // every tombstone by its name, read or not
    const windows = closed.filter((t) => t.until != null).map((t) => ({ ...t, window: t.via == null && !t.ppid_only }));
    let saved = 0;
    for (const [pid, e] of snap) {
      if (e.created == null || !SP.isRoot(pid, e, snap) || known.has(`${pid}-${e.created}`)) continue;
      const hit = windows.find((w) => SP.covers(w, pid, e));
      if (!hit) continue;
      const t = { pid, created: e.created, from: e.created, until: null, kind: 'descendant', via: `${hit.kind} pid ${hit.pid}`, via_from: hit.from };
      SR.saveTombstone(t);
      known.add(keyOf(t));
      saved += 1;
    }
    const keys = new Set(closed.map(keyOf));
    for (const k of [...marked.keys()]) if (!keys.has(k)) marked.delete(k); // gone already (another owner dropped it)
    const ripe = [];
    for (const t of closed) {
      const k = keyOf(t);
      if (!marked.has(k)) marked.set(k, began);
      else if (began - marked.get(k) >= gapMs) ripe.push(t);
    }
    for (const t of ripe) { await SR.dropTombstoneAsync(t); marked.delete(keyOf(t)); }
    return { dropped: ripe.length, saved, marked: marked.size };
  };
  return {
    // A check found `closed` closed tombstones. -> the pass in flight (started now or earlier), or null.
    note(closed) {
      if (running || !(closed >= at) || now() - lastAt < gapMs) return running;
      lastAt = now();
      running = last = run().catch((e) => ({ dropped: 0, error: (e && e.message) || String(e) })).finally(() => { running = null; });
      return running;
    },
    get running() { return running; },
    get last() { return last; },
  };
}

module.exports = { createPruner, PRUNE_AT, PRUNE_GAP_MS };
