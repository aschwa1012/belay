'use strict';
// continuity.cjs — checkpoints and the two derived briefing artefacts (api.md §3, ADR 0007 §1, §2).
//
// Everything here is derived from rows. Nothing is carried across runs, nothing is hand-written, and
// what a worker said is always labelled as what a worker said: AC-3 measured a fresh worker treating a
// planted resume line as authoritative, including a wrong count in it, so the label is the safeguard.
//
// Sizes are hard limits measured with Buffer.byteLength, not string length: 400 bytes for the line
// (ADR 0007 §2 and §7, the per-hook injection budget) and 4,096 for the document. Content is truncated
// to fit; the limits are never exceeded.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { heldLease } = require('./methods-task.cjs');

const LINE_MAX = 400;
const DOC_MAX = 4096;

function truncBytes(s, max) {
  const str = String(s);
  if (Buffer.byteLength(str, 'utf8') <= max) return str;
  if (max <= 0) return '';
  let out = Buffer.from(str, 'utf8').subarray(0, max).toString('utf8');
  // A split multi-byte sequence decodes as a trailing replacement character; drop it rather than ship it.
  while (out.length && out.charCodeAt(out.length - 1) === 0xFFFD) out = out.slice(0, -1);
  return out;
}

async function checkpoint(E, caller, args) {
  if (!args.task_id) throw err('E_ARGS', 'continuity.checkpoint needs a task_id');
  const task = rows.current(E.store, 'task', args.task_id);
  if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });

  const t = Date.now();
  const isWorker = caller.role === 'worker';
  let workerId, source, stated = null, toolDigest = null;

  if (isWorker) {
    workerId = caller.worker_id; // forced to the caller; args.worker_id is never consulted
    source = 'worker';
    if (!heldLease(E, args.task_id, workerId)) {
      throw err('E_NO_LEASE', `worker ${workerId} does not hold the current unexpired lease on task ${args.task_id}, so it cannot write a checkpoint against it`, { task_id: args.task_id, worker_id: workerId });
    }
    stated = {
      summary: args.summary == null ? null : String(args.summary),
      next_step: args.next_step == null ? null : String(args.next_step),
      open_questions: Array.isArray(args.open_questions) ? args.open_questions.map(String) : [],
    };
    // tool_digest is derived from the stream by the run manager; a worker's own version is discarded.
  } else {
    workerId = args.worker_id == null ? null : String(args.worker_id);
    source = 'harness';
    toolDigest = Array.isArray(args.tool_digest) ? args.tool_digest.slice(-20) : null;
    // `stated` is only ever what a worker said, so a harness checkpoint carries none.
  }

  const row = rows.append(E.store, 'checkpoint', {
    id: rows.newId(), task_id: args.task_id, worker_id: workerId, run_id: caller.run_id,
    turn: args.turn == null ? null : Number(args.turn),
    files_touched: Array.isArray(args.files_touched) ? args.files_touched : null,
    tool_digest: toolDigest, stated, source,
  }, E.writtenBy(caller), t);
  E.noteWrite();
  return row;
}

// `{ worker_id }` or `{ task_id }`. A worker id resolves through its current row's task_id, and failing
// that through whichever task's current unreleased lease it holds.
function resolveTask(E, args) {
  if (args.task_id) {
    const t = rows.current(E.store, 'task', args.task_id);
    if (!t) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
    return t;
  }
  if (args.worker_id) {
    const w = rows.current(E.store, 'worker', args.worker_id);
    if (w && w.task_id) {
      const t = rows.current(E.store, 'task', w.task_id);
      if (t) return t;
    }
    for (const t of rows.currentAll(E.store, 'task')) {
      const l = rows.currentLeaseForTask(E.store, t.id);
      if (l && !l.released_at && l.holder === args.worker_id) return t;
    }
    throw err('E_NOT_FOUND', `worker ${args.worker_id} has no task on its current row and holds no unreleased lease`, { worker_id: args.worker_id });
  }
  throw err('E_ARGS', 'a briefing needs either a worker_id or a task_id');
}

function leaseAndCheckpoints(E, taskId) {
  const lease = rows.currentLeaseForTask(E.store, taskId);
  return {
    lease: lease && !lease.released_at ? lease : null,
    released: lease && lease.released_at ? lease : null,
    harness: rows.lastCheckpoint(E.store, taskId, 'harness'),
    worker: rows.lastCheckpoint(E.store, taskId, 'worker'),
    any: rows.lastCheckpoint(E.store, taskId),
  };
}

async function resumeLine(E, caller, args) {
  const task = resolveTask(E, args);
  const c = leaseAndCheckpoints(E, task.id);
  const leaseId = c.lease ? c.lease.id : (c.released ? c.released.id : null);
  const next = c.worker && c.worker.stated ? c.worker.stated.next_step : null;

  const head = `task ${task.id} state=${task.state} lease=${leaseId || 'none'}.`;
  const tail = ` Recover context: memory_search "${task.id}".`;
  const fixed = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  let mid;
  if (next && String(next).trim()) {
    const prefix = ' Next step (stated by the worker, unverified): ';
    const room = LINE_MAX - fixed - Buffer.byteLength(prefix, 'utf8') - 1;
    mid = room > 8 ? prefix + truncBytes(String(next).replace(/\s+/g, ' ').trim(), room) : '';
  } else {
    const none = ' No worker-stated next step on record.';
    mid = fixed + Buffer.byteLength(none, 'utf8') <= LINE_MAX ? none : '';
  }
  let text = head + mid + tail;
  if (Buffer.byteLength(text, 'utf8') > LINE_MAX) text = truncBytes(text, LINE_MAX);

  return {
    text, bytes: Buffer.byteLength(text, 'utf8'), task_id: task.id, task_state: task.state,
    lease_id: leaseId, checkpoint_id: c.worker ? c.worker.id : (c.any ? c.any.id : null),
  };
}

// The newest checkpoint for a task in one run, optionally of one worker and one source: one indexed row, never the
// table. Task ids repeat across runs, so the run is part of the key: `run_id`, else the caller's.
// `{ task_id, run_id?, worker_id?, source? }` -> `{ checkpoint: row | null }`. A read; it writes nothing.
async function lastCheckpoint(E, caller, args) {
  if (!args.task_id) throw err('E_ARGS', 'continuity.lastCheckpoint needs a task_id');
  if (args.source != null && args.source !== 'worker' && args.source !== 'harness') throw err('E_ARGS', 'source must be worker or harness');
  const runId = args.run_id != null ? String(args.run_id) : caller.run_id;
  if (!runId) throw err('E_ARGS', 'continuity.lastCheckpoint needs a run: pass run_id or call with a run');
  const where = ['task_id = ?', 'run_id = ?']; const params = [args.task_id, runId];
  if (args.worker_id != null) { where.push('worker_id = ?'); params.push(String(args.worker_id)); }
  if (args.source != null) { where.push('source = ?'); params.push(args.source); }
  const row = E.store.p(`SELECT * FROM checkpoint WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT 1`).get(...params);
  return { checkpoint: rows.parseRow('checkpoint', row) || null };
}

function block(name, body) { return { name, text: `## ${name}\n${body}\n\n` }; }

async function resumeDoc(E, caller, args) {
  const task = resolveTask(E, args);
  const c = leaseAndCheckpoints(E, task.id);
  const ns = require('./methods-memory.cjs').resolveNamespace(E, caller, args.namespace) || `run/${caller.run_id}`;

  const candidates = [];
  candidates.push(block('spec', String(task.spec || '(no spec recorded)')));
  candidates.push(block('acceptance', task.acceptance ? JSON.stringify(task.acceptance, null, 1) : '(none recorded; this task cannot be marked done by task.evaluate)'));
  candidates.push(block('files owned', Array.isArray(task.files_owned) && task.files_owned.length ? task.files_owned.map(f => `- ${f}`).join('\n') : '(none recorded)'));
  candidates.push(block('lease', c.lease
    ? `id ${c.lease.id}, held by ${c.lease.holder_role} ${c.lease.holder}, expires_at ${c.lease.expires_at}${c.lease.expires_at < Date.now() ? ' (EXPIRED)' : ''}`
    : `no current holder${c.released ? `; lease ${c.released.id} was released at ${c.released.released_at}` : ''}`));
  candidates.push(block('last harness checkpoint', c.harness
    ? `turn ${c.harness.turn}, written_at ${c.harness.written_at}, files_touched ${JSON.stringify(c.harness.files_touched)}\ntool_digest (derived from the worker's event stream by the harness): ${JSON.stringify(c.harness.tool_digest)}`
    : '(none recorded)'));
  candidates.push(block('last worker-stated checkpoint — stated by the worker, unverified by the harness', c.worker && c.worker.stated
    ? `turn ${c.worker.turn}, written_at ${c.worker.written_at}, worker ${c.worker.worker_id}\nsummary: ${c.worker.stated.summary || '(none)'}\nnext step: ${c.worker.stated.next_step || '(none)'}\nopen questions: ${(c.worker.stated.open_questions || []).join(' | ') || '(none)'}`
    : '(none recorded)'));

  let mem = [];
  try { mem = E.store.taggedWith(ns, task.id, 10); } catch { mem = []; }
  candidates.push(block(`recent memory rows tagged ${task.id}`, mem.length
    ? mem.map(r => `- [${r.worker_id}] ${String(r.text).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
    : '(none)'));

  // The three orientation rules are part of the header, not a section, so they are never the thing that
  // truncation drops: a worker that has lost them goes looking for a roster it cannot have and ends up
  // asking a person (ADR 0013 §2). They cost about 330 of the 4,096 bytes, deterministically.
  const header = `# resume: task ${task.id} (state ${task.state})\n`
    + 'Derived from store rows only. Sections labelled "stated by the worker" are claims, not facts.\n\n'
    + '## how to orient\n'
    + 'You cannot see your peers and must not try to build a roster of them.\n'
    + 'Orient with task_list and memory_search, which answer from the store.\n'
    + 'Never ask a peer or the orchestrator what state something is in: task_list answers with lease holders and pid liveness, a peer answers with a claim.\n\n';
  let text = truncBytes(header, DOC_MAX);
  const sections = [];
  // Each section gets a fair share of what is left, and whatever a short section does not use rolls
  // forward to the next. Without this one runaway worker claim eats the budget and the sections after
  // it — the lease, the harness checkpoint, the memory rows — vanish from the briefing entirely.
  const marker = `\n…truncated to fit the ${DOC_MAX}-byte budget\n\n`;
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i];
    const room = DOC_MAX - Buffer.byteLength(text, 'utf8');
    if (room <= 0) break;
    const left = candidates.length - i;
    const share = left === 1 ? room : Math.floor(room / left);
    if (Buffer.byteLength(b.text, 'utf8') <= share) { text += b.text; sections.push(b.name); continue; }
    const keep = share - Buffer.byteLength(marker, 'utf8');
    if (keep > 40) { text += truncBytes(b.text, keep) + marker; sections.push(b.name + ' (truncated)'); }
  }
  if (Buffer.byteLength(text, 'utf8') > DOC_MAX) text = truncBytes(text, DOC_MAX);
  return { text, bytes: Buffer.byteLength(text, 'utf8'), sections };
}

module.exports = { checkpoint, lastCheckpoint, resumeLine, resumeDoc, truncBytes, LINE_MAX, DOC_MAX };
