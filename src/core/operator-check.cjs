'use strict';
// operator-check.cjs — ADR 0045 decision 4: the operator is checked by its process, not believed. A `bound` owner also listens on
// loopback TCP (owner-tcp.cjs), because Node cannot learn the pid of a named-pipe client and can learn the pid of a TCP one: the
// operating system's connection table names the process that owns the client end of a loopback connection. For a connection that
// claims `operator` with no key, the owner
//   1. reads the peer's pid from that table (the connection's remote port is the client's local port),
//   2. walks the peer's ancestors in one process snapshot, and
//   3. accepts it only if (a) no process on the chain is one belay spawned for this store (a worker, or the headless
//      orchestrator), and (b) the chain is intact up to a root created before this owner started.
// Rule (b) is what refuses an orphan: a worker that starts a detached process and exits leaves a process whose parent is gone, and
// that process is a root created after the owner. A fresh terminal's chain ends at the desktop shell, which predates the owner.
// Fails closed: an unreadable table or snapshot, a peer not found, or a connection that is not loopback TCP is a refusal that names
// why. A verdict is kept per connection (a connection's peer cannot change); a refusal is never kept.
//
// What it is not: a boundary against a same-user process that spoofs its parent or reads the operator's memory (ADR 0045 "What
// this does not stop", items 3 and 4), and it does not look at the OS user of the peer.

const { execFile } = require('node:child_process');
const ID = require('./proc-identity.cjs');

const CHAIN_LIMIT = 64;
const NETSTAT_TIMEOUT_MS = 10000;
const SUPPORTED = process.platform === 'win32'; // the connection table and the snapshot are read with Windows tools

// "  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234" -> { lport, fport, laddr, faddr, state, pid }
function parseNetstat(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/i.exec(line);
    if (m) rows.push({ laddr: m[1], lport: Number(m[2]), faddr: m[3], fport: Number(m[4]), state: m[5], pid: Number(m[6]) });
  }
  return rows;
}

function netstat() {
  return new Promise((resolve) => {
    try {
      execFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: NETSTAT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => resolve(e ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

// The pid that owns the client end of `conn`: the row whose local port is the connection's remote port and whose foreign port is
// its local port. -> { pid } or { reason }.
async function peerPid(conn, table = netstat) {
  if (!Number.isInteger(conn.remotePort) || !Number.isInteger(conn.localPort)) return { reason: 'the connection names no ports' };
  const text = await table();
  if (text == null) return { reason: 'the connection table could not be read' };
  const rows = parseNetstat(text).filter((r) => r.lport === conn.remotePort && r.fport === conn.localPort && /^(127\.0\.0\.1|::1)$/.test(r.laddr));
  const pids = [...new Set(rows.map((r) => r.pid))];
  if (pids.length !== 1) return { reason: pids.length ? `the connection table names ${pids.length} owners for the peer` : 'the peer is not in the connection table' };
  return { pid: pids[0] };
}

// The chain from `pid` up to its root, in a snapshot. A link is valid when the parent is in the snapshot and was created at or
// before the child (a recycled parent pid names a process born later). -> { chain: [{pid, created, image}], root, intact } where
// `root` is the last process whose parent link is not valid, and `intact` is whether the chain ended at a missing parent rather than a loop or the limit.
function chainOf(pid, snap) {
  const chain = [];
  const seen = new Set();
  let cur = pid;
  for (let i = 0; i < CHAIN_LIMIT; i++) {
    const e = snap.get(cur);
    if (!e || seen.has(cur)) return { chain, root: chain[chain.length - 1] || null, intact: false };
    seen.add(cur);
    chain.push({ pid: cur, created: e.created, image: e.image });
    const parent = e.ppid != null && e.ppid !== cur ? snap.get(e.ppid) : null;
    if (!parent || parent.created == null || e.created == null || parent.created > e.created) return { chain, root: chain[chain.length - 1], intact: true };
    cur = e.ppid;
  }
  return { chain, root: null, intact: false };
}

// `spawned()` -> [{ pid, created }] of every process belay spawned that an operator cannot be: a worker's, a bound adapter's, the
// headless orchestrator's. A record with no creation time matches by pid alone (fail closed).
function spawnedMatch(chain, spawned) {
  for (const p of chain) {
    const hit = spawned.find((s) => s.pid === p.pid && (s.created == null || p.created == null || s.created === p.created));
    if (hit) return { ...p, kind: hit.kind || 'spawned' };
  }
  return null;
}

// -> async ({ conn, caller, method }) => { ok: true, via: 'peer', peer } | { ok: false, reason }
function create({ startedAt, spawned, deps = {} }) {
  return async function operatorCheck({ conn }) {
    if (conn.belayPeer) return { ok: true, via: 'peer', peer: conn.belayPeer };
    if (conn.belayTransport !== 'tcp') return { ok: false, reason: 'an operator claim is verified on the owner\'s loopback port, and this connection is a pipe' };
    if (!SUPPORTED && !deps.table) return { ok: false, reason: 'this platform has no peer check' };
    const [found, shot] = await Promise.all([peerPid(conn, deps.table || netstat), deps.snapshot ? deps.snapshot() : ID.snapshotShared({ kind: 'operator-check' }).then((r) => r.snap)]);
    if (found.reason) return { ok: false, reason: found.reason };
    if (!shot) return { ok: false, reason: 'the process snapshot could not be read' };
    if (!shot.get(found.pid)) return { ok: false, reason: `the peer (pid ${found.pid}) is not in the process snapshot` };
    const { chain, root, intact } = chainOf(found.pid, shot);
    if (!intact || !root) return { ok: false, reason: `the peer's process chain could not be followed to a root (pid ${found.pid})` };
    const bad = spawnedMatch(chain, spawned());
    if (bad) return { ok: false, reason: `the peer descends from a process belay spawned (${bad.kind} pid ${bad.pid}, ${bad.image || 'unknown image'})` };
    if (root.created == null || !(root.created < startedAt)) return { ok: false, reason: `the peer's chain ends at pid ${root.pid} (${root.image || 'unknown image'}), which was not running when this owner started: an orphan or a process started since is not the operator` };
    const peer = { pid: found.pid, created: chain[0].created, image: chain[0].image, root: { pid: root.pid, created: root.created, image: root.image } };
    conn.belayPeer = peer;
    return { ok: true, via: 'peer', peer };
  };
}

module.exports = { create, parseNetstat, peerPid, chainOf, spawnedMatch, SUPPORTED };
