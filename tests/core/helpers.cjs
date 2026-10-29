'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// helpers.cjs — shared test scaffolding. Not a *.test.cjs file, so the runner does not execute it.
// Every test runs against a sandbox directory made with fs.mkdtempSync under the OS temp dir; nothing
// here ever touches the repository's own store.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'src', 'core');
const core = name => require(path.join(CORE, name));
const FIXTURES = path.join(__dirname, 'fixtures');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-core-test-')).replace(/\\/g, '/');
}

// Windows can hold a handle for a moment after a store closes, so retry; but a directory that truly
// will not go must be reported, not swallowed, or %TEMP% fills with belay-core-test-* with no signal.
function cleanup(dir) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

// A process root older than any spawn-register lifetime a concurrent test could have recorded (2020-01-01). An operator-check fixture that
// invents a shell as the root of its fake chain gives it this creation time, so a fake orchestrator registered by anyone cannot cover it.
const OLD_ROOT_CREATED = Date.UTC(2020, 0, 1);

// The spawn register this test file alone uses, made now and removed when the process exits; the variable is restored on removal.
// tests/helpers/tmp.cjs already gives each test-file process its own, so this is the explicit form for a file whose fixture depends on it.
function ownSpawnRegistry() {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawned-file-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the tmp helper retries at exit */ } if (keep === undefined) delete process.env.BELAY_SPAWN_REGISTRY; else process.env.BELAY_SPAWN_REGISTRY = keep; };
  process.once('exit', remove);
  return { dir, remove };
}

const callerFor = (role, extra = {}) => ({ role, run_id: 'test-run', pid: process.pid, ...extra });

// A pid no process holds and none will be handed (tests/helpers/dead-pid.cjs). Not the pid of an exited child: Windows reuses those within seconds.
const { deadPid } = require('../helpers/dead-pid.cjs');

function listDataDir(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Starts src/core/owner.cjs in its own process so a test can exercise the pipe rather than the
// in-process path. Stop it with core.shutdownOwner(), never a signal (ADR 0002 §5).
//
// The `exited` promise is created here, at spawn, and never by the caller after the fact. `exit` fires
// once: a test that stops the owner and only then attaches a listener races the process it just asked
// to die, and loses that race whenever the machine is busy enough for the owner to go first. The wait
// then never ends, which is a hung test file rather than a failing assertion.
function startOwnerProcess(dataDir) {
  const { spawn } = require('node:child_process');
  const child = trackOwnerChild(spawn(process.execPath, [path.join(FIXTURES, 'owner-proc.cjs'), dataDir], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const exited = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  return new Promise((resolve, reject) => {
    let buf = '', errBuf = '';
    const timer = setTimeout(() => reject(new Error('owner process did not report ready: ' + errBuf)), 15000);
    child.stderr.on('data', d => { errBuf += d.toString(); });
    child.stdout.on('data', d => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      const info = JSON.parse(buf.slice(0, i));
      if (info.ready) resolve({ child, info, exited });
      else reject(new Error('owner failed to start: ' + JSON.stringify(info)));
    });
    child.once('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Every owner process a test starts is registered the moment it is spawned, before anything can fail, so
// teardown never depends on the start having succeeded. A stray owner child holds the test runner's own
// process open and prints nothing, so one red test would stall the whole suite in silence rather than
// failing it — which is exactly what it did.
const OWNER_CHILDREN = new Set();
function trackOwnerChild(child) {
  OWNER_CHILDREN.add(child);
  child.once('exit', () => OWNER_CHILDREN.delete(child));
  return child;
}

// Unconditional teardown, and a receipt for each child. The sanctioned stop is tried first: its own
// shutdown call over the pipe, never a signal (ADR 0002 §5). An owner that never reached `listen` has no
// pipe to be asked, and that is the case the backstop exists for — one `process.kill` on the exact pid
// this test spawned, never a name or a command line, and only after the pid check says it is still there.
async function stopOwnerProcesses(dataDir) {
  const { openCore } = core('index.cjs');
  const { pidAlive, readOwnerLock } = core('lock.cjs');
  const receipts = [];
  for (const child of [...OWNER_CHILDREN]) {
    const pid = child.pid;
    try {
      // It cannot be asked to stop before it is serving, so give it a bounded chance to get there.
      for (let i = 0; i < 200 && pidAlive(pid); i++) {
        const lock = readOwnerLock(dataDir);
        if (lock && lock.listening !== false) break;
        await sleep(25);
      }
      if (pidAlive(pid)) {
        const c = await openCore({ dataDir, caller: callerFor('operator'), embed: false });
        await c.shutdownOwner();
        await c.close();
      }
    } catch { /* it may never have got far enough to answer */ }
    for (let i = 0; i < 80 && pidAlive(pid); i++) await sleep(25);
    let killed = false;
    if (pidAlive(pid)) { try { process.kill(pid); killed = true; } catch { /* it raced us to the exit */ } }
    OWNER_CHILDREN.delete(child);
    receipts.push({ pid, killed });
  }
  return receipts;
}

function runFixture(file, args) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(FIXTURES, file), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errText = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { errText += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: out, stderr: errText }));
  });
}

// Review 3, finding F: `node scripts/test.cjs` runs phase 1 with an EMPTY model cache (and this marker)
// so the run path's turn-text writes never load the 243 MB model. A file that needs the model calls this
// first: it points BELAY_MODEL_CACHE back at the real default root, but only under that marker, so a
// caller who names a cache (an empty one to see the skips, say) is honoured.
function optInModel() {
  if (process.env.BELAY_PHASE_EMPTY_CACHE === '1') process.env.BELAY_MODEL_CACHE = core('model-cache.cjs').defaultCacheRoot();
}

// A review's brief is captured when it is rendered and verdicts are checked against that capture (note-brief-capture.cjs). A test that drives
// memory.noteVerdicts without rendering a brief gets the capture a real run would have made: the brief as it stands now, taken just before.
// `call` is (method, caller, args) => Promise; `orch` reads the brief; `harness` is the run manager's caller.
async function captureBrief(call, orch, harness, route) {
  const T = require('../../src/run/note-review-text.cjs');
  const { shownHash } = core('note-shown.cjs');
  const brief = await call('memory.reviewBrief', orch, route.review_task_id !== undefined ? { task_id: route.review_task_id } : { reviewed_task_id: route.job.reviewed_task_id });
  const listed = route.review_task_id !== undefined ? T.listedNotes(brief) : brief.notes;
  return call('memory.noteBriefCapture', harness, { ...route, notes: listed.map((n) => ({ id: n.id, hash: shownHash(n) })) });
}
function capturingCall(call, orch, harness) {
  return async (method, caller, args = {}) => {
    if (method === 'memory.noteVerdicts' && caller === harness) {
      const route = args.review_task_id !== undefined ? { review_task_id: args.review_task_id } : args.job ? { job: args.job } : null;
      if (route) { try { await captureBrief(call, orch, harness, route); } catch { /* the verdict call reports a bad route itself */ } }
    }
    return call(method, caller, args);
  };
}

module.exports = { OLD_ROOT_CREATED, ownSpawnRegistry, captureBrief, capturingCall, optInModel, ROOT, CORE, FIXTURES, core, sandbox, cleanup, callerFor, deadPid, listDataDir, sleep, startOwnerProcess, trackOwnerChild, stopOwnerProcesses, runFixture };
