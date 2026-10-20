'use strict';
// spawn-register.cjs — ADR 0045 decision 4, across stores. An owner's operator check refuses a peer that descends from a process belay
// spawned; its own store's worker rows name only that store's workers, so a worker of another run's store (or its headless
// orchestrator) was not recognised, and its children walked up to an older shell and passed. Every harness that spawns a worker or a
// headless orchestrator writes one small record here, keyed by pid, the moment the child exists, and removes it when the child
// exits. The directory is machine-wide (the temp directory), so every owner on the machine reads the same list.
//
// Trust: the records are written by the harness, the parent of the process they name (invariant 1), and only the harness's code
// adds one. A process that deletes a record is a same-user process that could do far more (ADR 0045 "What this does not stop").
// Fails closed: a directory that exists and cannot be read, or a record that cannot be parsed, is an error the operator check turns
// into a refusal; an absent directory means nothing was ever registered.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidAlive } = require('./lock.cjs');

const dir = () => process.env.BELAY_SPAWN_REGISTRY || path.join(os.tmpdir(), 'belay-spawned');
const fileOf = (pid) => path.join(dir(), `${Number(pid)}.json`);

// -> the record written. `created` is the process's creation time when known (it usually is not yet at spawn; `update` fills it).
function register({ pid, kind, dataDir = null, workerId = null, created = null }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`spawn register: not a pid: ${pid}`);
  fs.mkdirSync(dir(), { recursive: true });
  const rec = { pid, created: Number.isFinite(created) ? created : null, kind: kind || 'worker', data_dir: dataDir, worker_id: workerId, by_pid: process.pid, at: Date.now() };
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
  register({ pid, kind: rec.kind, dataDir: rec.data_dir, workerId: rec.worker_id, created });
  return true;
}

function unregister(pid) { try { fs.unlinkSync(fileOf(pid)); } catch { /* already gone */ } }

// -> [{ pid, created, kind, data_dir, worker_id }] of the records whose pid answers a pid check; a record whose pid is gone is
// removed. Throws when the directory or a record cannot be read.
function list() {
  let names;
  try { names = fs.readdirSync(dir()); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue; // a temp file being renamed into place, or something else
    const file = path.join(dir(), n);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') continue; throw new Error(`spawn register: ${n} cannot be read (${e.message})`); }
    if (!rec || !Number.isInteger(rec.pid)) throw new Error(`spawn register: ${n} names no pid`);
    if (!pidAlive(rec.pid)) { try { fs.unlinkSync(file); } catch { /* someone else removed it */ } continue; }
    out.push({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, kind: rec.kind || 'worker', data_dir: rec.data_dir || null, worker_id: rec.worker_id || null });
  }
  return out;
}

// What `belay run` tells its owner it spawned besides the workers: the headless orchestrator, once its pid is known. The interactive
// orchestrator is the human's own session (its plugin runs the CLI), so it is listed nowhere.
function runSpawned(interactive, orchestratorPid) {
  return !interactive && Number.isInteger(orchestratorPid) ? [{ pid: orchestratorPid, created: null, kind: 'orchestrator' }] : [];
}

module.exports = { register, registerProcess, update, unregister, list, dir, runSpawned };
