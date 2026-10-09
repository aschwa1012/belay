'use strict';
// process.cjs — build step 6b design item 1, rewritten by ADR 0039. Kill mechanics a CLI process can
// use without importing src/run (src/run/process.cjs re-exports these beside its own pidAlive,
// spawnWorker and gracefulStop). Kill is by exact pid (ADR 0008 §4), and now only with an identity.
//
// ADR 0039: a kill names the process it means. A target is one of
//   - a live child handle (exitCode === null && signalCode === null): identity { via: 'handle' };
//   - { pid, created, image? }: identity is the creation time read at spawn, which must match one CIM snapshot
//     EXACTLY (two snapshots of one process agree to the millisecond), and `image`, when given, must match too
//     ({ via: 'created' }). A null `created` (an older row) gets a single-pid kill only when the snapshot image
//     is one of `image` ({ via: 'image' }), and never a tree kill. `unverified: <why>` (the row's
//     pid_created_error) refuses outright;
//   - a bare pid number: REFUSED. Nothing in src/ kills a pid it cannot prove.
// A mismatch, or an identity that cannot be read, is refused: { ok: false, refused: 'identity', kind, detail }.
// `kind` is 'mismatch' or 'absent' when the process belay meant is provably not at that pid, and
// 'unverifiable' when nothing could be proved (the process may still be running).
// Never `taskkill /T`: a tree is one snapshot, filtered by creation order, killed leaves first, one
// pid at a time.

const { execFile } = require('node:child_process');
const { err } = require('./errors.cjs');
const { pidAlive } = require('./lock.cjs');
const ID = require('./proc-identity.cjs');
const KL = require('./kill-log.cjs');

const IS_WINDOWS = process.platform === 'win32';

function assertPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw err('E_ARGS', 'kill takes a positive integer pid, never a name or a command line', { pid });
  }
  return pid;
}

const isHandle = (t) => !!t && typeof t === 'object' && 'exitCode' in t && 'signalCode' in t;
const isDescriptor = (t) => !!t && typeof t === 'object' && !isHandle(t) && 'pid' in t;
const pidOf = (t) => (typeof t === 'number' ? t : t && t.pid);
const refusals = []; // the last few refusals, for a diagnostic; bounded
// A kill-time snapshot outside a caller's own (the fast close passes one) is taken once more if unreadable.
const KILL_SNAPSHOT_ATTEMPTS = 2;
const takeSnapshot = (opts) => (opts.snapshot ? opts.snapshot() : ID.snapshotRetry({ attempts: KILL_SNAPSHOT_ATTEMPTS }));

// What the operator can do by hand about a process belay will not kill because nothing proves what it is: the
// pid, the image belay expected, and the exact way to end it once they have confirmed that image themselves.
function manualStopHint(pid, image) {
  const img = (Array.isArray(image) ? image : [image]).filter(Boolean).join(' or ') || 'the program you expect';
  return `belay will not kill pid ${pid}: it cannot prove the process is the one it started. If pid ${pid} is still running and its image is ${img} (check Task Manager > Details, or Get-Process -Id ${pid}), end it by hand: Stop-Process -Id ${pid}`;
}
// `target` is the kill's target: a row's identity that could not be proved gets the manual hint.
function refusal(base, detail, kind = 'unverifiable', target = null) {
  refusals.push({ at: Date.now(), pid: base.pid, detail, kind });
  if (refusals.length > 50) refusals.shift();
  const manual = kind === 'unverifiable' && isDescriptor(target) ? { manual: manualStopHint(base.pid, target.image) } : {};
  return { ...base, ok: false, refused: 'identity', kind, detail, identity: null, ...manual };
}
// The kill lock (ADR 0039 review): belay stop's worker phase and the run's worker close run in one process and may
// overlap at a console close. Each takes the lock for its kill, so the second waits for the first; and any snapshot
// that started before the last signal sent here (`lastSignalAt`) may show a process that has since died, so a
// caller holding the lock re-takes it rather than kill a just-freed pid from it.
let killChain = Promise.resolve();
let lastSignal = 0;
function withKillLock(fn) {
  const run = killChain.then(() => fn());
  killChain = run.then(() => {}, () => {});
  return run;
}
const sendKill = (pid, signal, killer) => {
  try { (killer || process.kill)(pid, signal); lastSignal = Date.now(); return { signalled: true, error: null }; }
  catch (e) { return { signalled: false, error: e.code || String(e && e.message) }; }
};
const shape = (pid, signal) => ({ signalled: false, pid, signal, error: null });
const BARE = 'a bare pid proves nothing: pass the child handle or { pid, created }';

// Kill exactly one pid. Liveness is still derived from the exit event and the pid poll, never from this
// return value (invariant 4). Synchronous for a handle; a Promise for { pid, created } (it reads a
// snapshot), so callers `await` it.
function killPid(target, signal = 'SIGKILL', opts = {}) {
  const rec = KL.begin('killPid', target);
  if (!rec) return killPidRaw(target, signal, opts);
  let r;
  try { r = killPidRaw(target, signal, opts); } catch (e) { rec({ ok: false, kind: 'args', detail: e.message }); throw e; }
  return r && typeof r.then === 'function' ? r.then(rec) : rec(r);
}
function killPidRaw(target, signal, opts) {
  const pid = assertPid(pidOf(target));
  const base = shape(pid, signal);
  const no = (detail, kind) => refusal({ ...base, error: 'EIDENTITY' }, detail, kind, target);
  if (typeof target === 'number') return no(`refused to kill pid ${pid}: ${BARE}`, 'unverifiable');
  if (isHandle(target)) {
    if (!ID.handleLive(target)) return no(`the child handle for pid ${pid} has already exited`, 'absent');
    return { ...base, ...sendKill(pid, signal, opts.kill), ok: true, identity: { via: 'handle' } };
  }
  if (!isDescriptor(target)) throw err('E_ARGS', 'kill takes a child handle or { pid, created }', { target: typeof target });
  if (target.unverified) return no(`pid ${pid} was never verified at spawn: ${target.unverified}`, 'unverifiable');
  return (async () => {
    const snap = await takeSnapshot(opts);
    if (target.created == null) {
      if (!snap) return no(`process snapshot unreadable; cannot establish the identity of pid ${pid}`, 'unverifiable');
      const e = snap.get(pid);
      if (!e) return no(`pid ${pid} is not running`, 'absent');
      if (target.image == null || !ID.imageIn(e.image, target.image)) return no(`no recorded creation time for pid ${pid} and its image ${e.image} is not the expected one`, 'unverifiable');
      return { ...base, ...sendKill(pid, signal, opts.kill), ok: true, identity: { via: 'image', image: e.image } };
    }
    const c = ID.checkIdentity(pid, { created: target.created, image: target.image }, snap);
    if (!c.ok) return no(c.detail, c.kind);
    return { ...base, ...sendKill(pid, signal, opts.kill), ok: true, identity: c.identity };
  })();
}

// Kill a process and its verified descendants. Always a Promise. See the header for what a target is.
function killTree(target, opts = {}) {
  const rec = KL.begin('killTree', target);
  if (!rec) return killTreeRaw(target, opts);
  const fail = (e) => { rec({ ok: false, kind: 'args', detail: e.message }); throw e; };
  try { return killTreeRaw(target, opts).then(rec, fail); } catch (e) { return fail(e); }
}
function killTreeRaw(target, opts = {}) {
  const t0 = Date.now();
  const pid = assertPid(pidOf(target));
  const done = (r) => ({ tool: 'process.kill', method: 'snapshot-tree', pid, exit_code: r.ok ? 0 : 1, terminated: 0, killed: [], skipped: [], ms: Date.now() - t0, output: '', stdout: '', stderr: '', ...r });
  const fail = (detail, kind) => done(refusal({ pid }, detail, kind, target));
  return (async () => {
    if (typeof target === 'number') return fail(`refused a tree kill of pid ${pid}: ${BARE}`);
    const handle = isHandle(target);
    if (!handle && !isDescriptor(target)) throw err('E_ARGS', 'kill takes a child handle or { pid, created }', { target: typeof target });
    if (handle && !ID.handleLive(target)) return fail(`the child handle for pid ${pid} has already exited`, 'absent');
    if (!handle && target.unverified) return fail(`pid ${pid} was never verified at spawn: ${target.unverified}`);
    if (!handle && target.created == null) return fail(`no recorded creation time for pid ${pid}: a tree is never killed without one`);
    if (handle && !IS_WINDOWS && !opts.snapshot) {
      const k = sendKill(-pid, 'SIGKILL', opts.kill);
      return done({ method: 'process-group', ok: k.signalled, terminated: k.signalled ? 1 : 0, killed: k.signalled ? [pid] : [], output: k.error || '', identity: { via: 'handle' } });
    }
    const snap = await takeSnapshot(opts);
    let identity = { via: 'handle' }; let tree = { leavesFirst: [], skipped: [] }; let treeNote = null;
    if (!snap) {
      if (!handle) return fail(`process snapshot unreadable; cannot establish the identity of pid ${pid}`);
      treeNote = 'process snapshot unreadable: descendants not killed'; // the handle still proves the root
    } else if (!handle) {
      const c = ID.checkIdentity(pid, { created: target.created, image: target.image }, snap);
      if (!c.ok) return fail(c.detail, c.kind);
      identity = c.identity;
    }
    if (snap) tree = ID.descendantsOf(pid, snap);
    const killed = []; const errors = [];
    const one = (p) => { const k = sendKill(p, 'SIGKILL', opts.kill); if (k.signalled) killed.push(p); else if (k.error !== 'ESRCH') errors.push(`${p}:${k.error}`); };
    for (const d of tree.leavesFirst) one(d.pid);
    if (handle && !ID.handleLive(target)) errors.push(`${pid}:exited meanwhile`); else one(pid);
    const ok = errors.length === 0;
    return done({ ok, terminated: killed.length, killed, skipped: tree.skipped, identity, output: [treeNote, ...errors].filter(Boolean).join('; ').slice(0, 400), ...(treeNote ? { tree_refused: treeNote } : {}) });
  })();
}

// What a stored worker/run row says about its process, as a kill target (ADR 0039 decision 2). `pid_image` is
// the executable the spawner actually launched, recorded on the row at spawn (node.exe only when the launch
// was a script run by node, as the test fakes are); a row from before the column falls back to the
// substrate's own executable. The image is the only thing a null `pid_created` can be checked against. A row
// whose creation-time read failed (`pid_created_error`) is `unverified`: it is never killed by a guess.
const SUBSTRATE_IMAGES = { 'claude-code': ['claude.exe'], codex: ['codex.exe'] };
function rowTarget(row, pidField = 'pid', createdField = 'pid_created') {
  const t = {
    pid: row[pidField], created: Number.isFinite(row[createdField]) ? row[createdField] : null,
    image: row.pid_image ? [row.pid_image] : (SUBSTRATE_IMAGES[row.substrate] || []),
  };
  if (row.pid_created_error) t.unverified = row.pid_created_error;
  return t;
}

// The sequence every kill site ran (tree kill, then a single-pid signal), now with identity: the tree
// kill takes the root last, so the single-pid signal only runs where the tree kill was refused for want
// of a creation time (an older row), and then only if the image matches. -> { tree, pidKill, identity,
// refused, descendants_not_killed } where `pidKill` keeps the old { signalled, error } shape. A single-pid
// kill never takes the root's descendants, and the result says so. `refused.kind` is the refusal's kind.
// The kill log (BELAY_KILL_LOG) gets one line for the whole sequence, not one per step.
function killProcess(target, opts = {}) {
  const rec = KL.begin('killProcess', target);
  const p = killProcessRaw(target, opts);
  return rec ? p.then((r) => { rec({ ok: !r.refused, identity: r.identity, kind: r.refused && r.refused.kind, detail: r.refused && r.refused.detail }); return r; },
    (e) => { rec({ ok: false, kind: 'args', detail: e.message }); throw e; }) : p;
}
async function killProcessRaw(target, opts) {
  const tree = await killTreeRaw(target, opts);
  if (!tree.refused) {
    const pidKill = { signalled: false, pid: tree.pid, signal: 'SIGKILL', error: 'ESRCH', ok: true, identity: tree.identity, note: 'the root was ended by the tree kill' };
    return { tree, pidKill, identity: tree.identity, refused: null, descendants_not_killed: tree.tree_refused || null };
  }
  const single = isDescriptor(target) && target.created == null && !target.unverified ? await killPidRaw(target, 'SIGKILL', opts) : null;
  const pidKill = single || { signalled: false, pid: tree.pid, signal: 'SIGKILL', error: 'EIDENTITY', ok: false, refused: 'identity', kind: tree.kind, detail: tree.detail, identity: null, ...(tree.manual ? { manual: tree.manual } : {}) };
  const landed = !!(single && single.ok);
  return {
    tree, pidKill, identity: pidKill.identity || null,
    refused: pidKill.refused ? { refused: 'identity', kind: pidKill.kind || tree.kind, detail: pidKill.detail || tree.detail, ...((pidKill.manual || tree.manual) ? { manual: pidKill.manual || tree.manual } : {}) } : null,
    descendants_not_killed: landed ? `descendants not killed: ${tree.detail}` : null,
  };
}


// The verified descendants of a pid as kill targets, from one snapshot: [{ pid, created, image }], leaves
// first; [] when the snapshot is unreadable. For a caller that must kill them after something else ends the
// parent (pause.cjs): the identity is taken before, and checked again by killMany after.
async function descendantTargets(pid, opts = {}) {
  const snap = await takeSnapshot(opts);
  return snap ? ID.descendantsOf(assertPid(pid), snap).leavesFirst : [];
}

// Kill each target ({ pid, created, image }) that still has its identity, from one snapshot, in the order
// given. -> [{ pid, killed, identity | refused, detail }]. A target already gone is `killed: false` with
// `gone: true`, and costs no snapshot when none is left alive.
async function killMany(targets, opts = {}) {
  const alive = targets.filter((t) => pidAlive(t.pid));
  const recs = new Map(alive.map((t) => [t, KL.begin('killMany', t)]));
  const log = (t, r) => { const rec = recs.get(t); if (rec) rec(r); };
  const out = targets.filter((t) => !alive.includes(t)).map((t) => ({ pid: t.pid, killed: false, gone: true }));
  if (!alive.length) return out;
  const snap = await takeSnapshot(opts);
  for (const t of alive) {
    if (!snap) { log(t, { ok: false, kind: 'unverifiable', detail: 'process snapshot unreadable' }); out.push({ pid: t.pid, killed: false, refused: 'identity', kind: 'unverifiable', detail: 'process snapshot unreadable', manual: manualStopHint(t.pid, t.image) }); continue; }
    const c = ID.checkIdentity(t.pid, t, snap);
    if (!c.ok) { log(t, { ok: false, kind: c.kind, detail: c.detail }); refusals.push({ at: Date.now(), pid: t.pid, detail: c.detail }); out.push({ pid: t.pid, killed: false, refused: 'identity', kind: c.kind, detail: c.detail, ...(c.kind === 'unverifiable' ? { manual: manualStopHint(t.pid, t.image) } : {}) }); continue; }
    const k = sendKill(t.pid, 'SIGKILL', opts.kill);
    log(t, { ok: true, identity: c.identity });
    out.push({ pid: t.pid, killed: k.signalled, identity: c.identity, ...(k.signalled ? {} : { error: k.error }) });
  }
  return out;
}

// Descendant pids of a pid, from the OS, for measurement and for verifying a subtree is gone.
// Windows: one WMIC-free query through PowerShell's CIM provider.
function childPids(pid) {
  assertPid(pid);
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve([]);
    const ps =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (e, stdout) => {
        if (e) return resolve([]);
        let rows;
        try {
          rows = JSON.parse(String(stdout));
        } catch {
          return resolve([]);
        }
        if (!Array.isArray(rows)) rows = [rows];
        const byParent = new Map();
        for (const r of rows) {
          const p = Number(r.ParentProcessId);
          if (!byParent.has(p)) byParent.set(p, []);
          byParent.get(p).push(Number(r.ProcessId));
        }
        const out = [];
        const stack = [pid];
        const seen = new Set([pid]);
        while (stack.length) {
          for (const c of byParent.get(stack.pop()) || []) {
            if (seen.has(c)) continue;
            seen.add(c);
            out.push(c);
            stack.push(c);
          }
        }
        resolve(out);
      }
    );
  });
}

// Wait for a pid to disappear, polling. Returns ms until gone, or null at the deadline.
async function waitPidGone(pid, { timeoutMs = 15000, intervalMs = 25 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

module.exports = {
  IS_WINDOWS, assertPid, killPid, killTree, killProcess, rowTarget, manualStopHint, KILL_SNAPSHOT_ATTEMPTS, withKillLock, lastSignalAt: () => lastSignal, descendantTargets, killMany, childPids, waitPidGone, isHandle,
  processSnapshot: ID.processSnapshot, createdOf: ID.createdOf, recentRefusals: () => refusals.slice(),
};
