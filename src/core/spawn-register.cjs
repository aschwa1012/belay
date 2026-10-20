'use strict';
// spawn-register.cjs — ADR 0045 decision 4, across stores. An owner's operator check refuses a peer that descends from a process belay
// spawned; its own store's worker rows name only that store's workers, so a worker of another run's store (or its headless
// orchestrator) was not recognised, and its children walked up to an older shell and passed. Every harness that spawns a worker or a
// headless orchestrator writes one small record here, keyed by pid, the moment the child exists, and removes it when the child
// exits. The directory is machine-wide (the temp directory), so every owner on the machine reads the same list.
//
// Trust: the records are written by the harness, the parent of the process they name (invariant 1), and only the harness's code
// adds one. A process that deletes a record is a same-user process that could do far more (ADR 0045 "What this does not stop").
// A record is not simply deleted when its process is gone: it becomes a tombstone under `exited/` that keeps the process's lifetime
// (spawn-provenance.cjs reads it), because a process it left behind has a chain that ends at itself and, without the tombstone, looks
// like an operator's detached tool to an owner started later.
// Fails closed: a directory that exists and cannot be read, or a record that cannot be parsed, is an error the operator check turns
// into a refusal; an absent directory means nothing was ever registered.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidAlive } = require('./lock.cjs');

const dir = () => process.env.BELAY_SPAWN_REGISTRY || path.join(os.tmpdir(), 'belay-spawned');
const fileOf = (pid) => path.join(dir(), `${Number(pid)}.json`);
const exitedDir = () => path.join(dir(), 'exited');
const tombFile = (t) => path.join(exitedDir(), `${Number(t.pid)}-${Number.isFinite(t.created) ? t.created : 0}.json`);
const UNKNOWN_START_SLACK_MS = 2000; // a record with no creation time and no spawn time: it was made this long after the process started, at most

// -> the record written. `created` is the process's creation time when known (it usually is not yet at spawn; `update` fills it).
function register({ pid, kind, dataDir = null, workerId = null, created = null, spawnedAt = null }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`spawn register: not a pid: ${pid}`);
  fs.mkdirSync(dir(), { recursive: true });
  const rec = { pid, created: Number.isFinite(created) ? created : null, kind: kind || 'worker', data_dir: dataDir, worker_id: workerId, spawned_at: Number.isFinite(spawnedAt) ? spawnedAt : null, by_pid: process.pid, at: Date.now() };
  const tmp = `${fileOf(pid)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, fileOf(pid));
  return rec;
}

// register, for a caller that must not go on without the record: the error names what could not be recorded.
function registerProcess(rec, what) {
  try { return register(rec); }
  catch (e) { throw new Error(`${what} (pid ${rec.pid}) could not be recorded in the spawn register (${(e && e.message) || e}); another store on this machine could not tell its children from an operator`); }
}

function update(pid, created) {
  if (!Number.isFinite(created)) return false;
  let rec;
  try { rec = JSON.parse(fs.readFileSync(fileOf(pid), 'utf8')); } catch { return false; }
  if (rec.created === created) return true;
  register({ pid, kind: rec.kind, dataDir: rec.data_dir, workerId: rec.worker_id, created, spawnedAt: rec.spawned_at });
  return true;
}

// The earliest moment the record's process can have existed: its creation time, else the time before the spawn call, else the time of the record less a slack.
const startOf = (rec) => Number.isFinite(rec.created) ? rec.created : Number.isFinite(rec.spawned_at) ? rec.spawned_at : (Number(rec.at) || Date.now()) - UNKNOWN_START_SLACK_MS;

function saveTombstone(t) {
  fs.mkdirSync(exitedDir(), { recursive: true });
  const tmp = `${tombFile(t)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t));
  fs.renameSync(tmp, tombFile(t));
  return t;
}
function dropTombstone(t) { try { fs.unlinkSync(tombFile(t)); } catch { /* already gone */ } }

// Turn a record into its tombstone: { pid, created, from, until, kind, via }. `until` null means the process may still be alive.
const tombstoneOf = (rec, until) => ({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, from: startOf(rec), until, kind: rec.kind || 'worker', via: null });

// Retire a record whose process has exited. The tombstone is written first: when it cannot be, the record stays, so the next read
// retires it again (and throws, which the operator check turns into a refusal) rather than forgetting the process.
function unregister(pid) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(fileOf(pid), 'utf8')); } catch { return; }
  try { saveTombstone(tombstoneOf(rec, Date.now())); } catch { return; }
  try { fs.unlinkSync(fileOf(pid)); } catch { /* someone else removed it */ }
}

// -> the raw records whose pid answers a pid check; a record whose pid is gone is retired. Throws when the directory, a record or a
// tombstone cannot be read or written.
function live() {
  let names;
  try { names = fs.readdirSync(dir()); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue; // a temp file being renamed into place, the exited directory, or something else
    const file = path.join(dir(), n);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') continue; throw new Error(`spawn register: ${n} cannot be read (${e.message})`); }
    if (!rec || !Number.isInteger(rec.pid)) throw new Error(`spawn register: ${n} names no pid`);
    if (!pidAlive(rec.pid)) { saveTombstone(tombstoneOf(rec, Date.now())); try { fs.unlinkSync(file); } catch { /* someone else removed it */ } continue; }
    out.push(rec);
  }
  return out;
}

// -> [{ pid, created, kind, data_dir, worker_id }] of the records whose pid answers a pid check.
function list() {
  return live().map((rec) => ({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, kind: rec.kind || 'worker', data_dir: rec.data_dir || null, worker_id: rec.worker_id || null }));
}

// -> the tombstones of exited processes (and of the descendants spawn-provenance.cjs has recorded). Throws when one cannot be read.
function tombstones() {
  let names;
  try { names = fs.readdirSync(exitedDir()); } catch (e) { if (e && (e.code === 'ENOENT')) return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!/^\d+-\d+\.json$/.test(n)) continue;
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(exitedDir(), n), 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') continue; throw new Error(`spawn register: exited/${n} cannot be read (${e.message})`); }
    if (!t || !Number.isInteger(t.pid) || !Number.isFinite(t.from)) throw new Error(`spawn register: exited/${n} names no pid or start`);
    out.push({ pid: t.pid, created: Number.isFinite(t.created) ? t.created : null, from: t.from, until: Number.isFinite(t.until) ? t.until : null, kind: t.kind || 'worker', via: t.via == null ? null : t.via });
  }
  return out;
}

// What `belay run` tells its owner it spawned besides the workers: the headless orchestrator, once its pid is known. The interactive
// orchestrator is the human's own session (its plugin runs the CLI), so it is listed nowhere.
function runSpawned(interactive, orchestratorPid) {
  return !interactive && Number.isInteger(orchestratorPid) ? [{ pid: orchestratorPid, created: null, kind: 'orchestrator' }] : [];
}

module.exports = { register, registerProcess, update, unregister, list, live, startOf, tombstones, saveTombstone, dropTombstone, dir, runSpawned };
