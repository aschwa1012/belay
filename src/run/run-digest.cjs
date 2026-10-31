'use strict';
// run-digest.cjs — ADR 0074 decisions 2 and 4. The digest: belay's own policy steps since the last one, one line each, facts only,
// capped, oldest dropped first with a count. Two processes can ask for it (the adapter's worker_wait, the interactive launcher's wake
// publisher), so a digest is a CLAIM: a file <data>/run-wait/<run>/d<n>.json created by link, which fails when the number exists. The
// claim records the steps it shows and the ones the cap dropped, so a step is in exactly one digest (shown or counted) whoever asks, in
// whatever order, and a step that finishes late (outcome `started` at one read) is taken by the next. Nothing here retries a claim
// that lost: it reads the winner's coverage and builds again from what is left. A delivered exception wake is a marker file
// x-<hash>, created the same way, so the wait and the wake pipe never both deliver one fact. The run receipt's digests[] is the
// claim files read back (`readDigests`), which is what the orchestrator was actually shown.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CAP_BYTES = 2048; // ADR 0074 Q3: per return
const NOTE_RESERVE = 48; // room kept for the "not shown" note when the cap drops lines
const PAGE = 2000; // policy.list's most rows a call
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const scrub = (s, n) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);

const dirOf = (dataDir, runId) => path.join(dataDir, 'run-wait', String(runId)).replace(/\\/g, '/');
const ownFile = (dir, n) => `${dir}/d${n}.json`;
const markerFile = (dir, uid) => `${dir}/x-${crypto.createHash('sha1').update(String(uid)).digest('hex').slice(0, 24)}`;

const finished = (r) => !!r && Number.isInteger(Number(r.seq)) && !!r.outcome && r.outcome !== 'started';

// One step as one line: ids, states and counts. The error is belay's own text (an E_ code and its message), cut short.
function lineOf(r, short = false) {
  if (short) return `#${r.seq} ${scrub(r.step, 24)} ${scrub(r.task_id || '-', 40)} ${scrub(r.outcome, 12)}`;
  const to = r.row_ref ? ` -> ${scrub(r.row_ref, 60)}` : '';
  const by = r.worker_id ? ` by ${scrub(r.worker_id, 40)}` : '';
  const why = r.error ? `: ${scrub(r.error, 60)}` : '';
  return `#${r.seq} ${scrub(r.step, 24)} ${scrub(r.task_id || '-', 40)} ${scrub(r.outcome, 12)}${to}${by}${why}`;
}

// -> { shown: [rows], dropped: [rows], text }. `rows` ascend by seq. The newest lines that fit are kept; the dropped are the oldest.
// `head` leads the text and counts against the cap; `sep` joins the lines (a wake is one line, so it joins with '; ').
function build(rows, cap = CAP_BYTES, { head = '', sep = '\n', short = false } = {}) {
  const lines = rows.map((r) => lineOf(r, short));
  const room = cap - bytes(head);
  const total = lines.reduce((n, l) => n + bytes(l) + bytes(sep), 0);
  if (total <= room) return { shown: rows.slice(), dropped: [], text: head + lines.join(sep) };
  let used = 0; let keep = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const need = bytes(lines[i]) + bytes(sep);
    if (used + need > room - NOTE_RESERVE) break;
    used += need; keep = i;
  }
  const shown = rows.slice(keep); const dropped = rows.slice(0, keep);
  const note = `(+${dropped.length} earlier policy step${dropped.length === 1 ? '' : 's'} not shown)`;
  return { shown, dropped, text: head + [note, ...lines.slice(keep)].join(sep) };
}

function coverage(dir) {
  const covered = new Set(); let top = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { covered, top }; }
  for (const f of names) {
    const m = /^d(\d+)\.json$/.exec(f);
    if (!m) continue;
    top = Math.max(top, Number(m[1]));
    try {
      const d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
      for (const l of d.lines || []) covered.add(l.step_seq);
      for (const s of (d.dropped && d.dropped.seqs) || []) covered.add(s);
    } catch { /* an unreadable claim covers nothing it can name; the number it holds is still taken */ }
  }
  return { covered, top };
}

// Create `file` with `content`, failing (false) when it exists. Written whole under a private name, then linked, so a reader never sees half of it.
function createOnce(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (e && e.code === 'EEXIST') return false; throw e; } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

// Claim the digest of `rows` (policy.list rows): the finished ones no digest has taken. -> the claim record, or null when there is nothing new.
// `hooks.beforeCreate(rec)` is a test seam: it runs between building the claim and creating its file, where a second asker can take the number.
function claimDigest({ dataDir, runId, rows, cap = CAP_BYTES, form = {}, via = 'wait', now = Date.now, claimant = null, hooks = {} }) {
  const dir = dirOf(dataDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { covered, top } = coverage(dir);
    const fresh = (rows || []).filter((r) => finished(r) && !covered.has(Number(r.seq))).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return null;
    const b = build(fresh, cap, form);
    const rec = {
      n: top + 1, via, at: now(), claimant, bytes: bytes(b.text), text: b.text,
      lines: b.shown.map((r) => ({ step_seq: Number(r.seq), text: lineOf(r, !!form.short) })),
      dropped: { count: b.dropped.length, seqs: b.dropped.map((r) => Number(r.seq)) },
    };
    if (hooks.beforeCreate) hooks.beforeCreate(rec);
    if (createOnce(ownFile(dir, rec.n), `${JSON.stringify(rec)}\n`)) return rec;
  }
  throw Object.assign(new Error('the digest could not be claimed: its number kept being taken'), { code: 'E_BUSY' });
}


// Claim the delivery of one wake (by its dedupe uid). true: this caller delivers it; false: another path already has. The marker records the
// claimant (adapter pid and creation time) and, for a wait's delivery, the receipt record of the wake (readDeliveries).
function claimException({ dataDir, runId, uid, record = null, claimant = null }) {
  const dir = dirOf(dataDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  return createOnce(markerFile(dir, uid), `${JSON.stringify({ uid, at: Date.now(), claimant, record })}\n`);
}
const isClaimed = ({ dataDir, runId, uid }) => fs.existsSync(markerFile(dirOf(dataDir, runId), uid));

// A worker life: the process a row records, never the turn count (a relaunched worker can die again at the same turn).
const lifeOf = (pid, created) => `${Number.isInteger(pid) ? pid : 0}:${created == null ? 0 : created}`;
// The delivery key of a wake, the same on every path that can deliver it: a policy exception by its fact, a worker death or stale record by
// (worker, kind, life). Null for a wake that has no second path (budget, notes, routine turn ends).
const deathUid = (workerId, kind, life) => `${workerId}:${kind}:${life}`;
function wakeUid(ev) {
  if (!ev || !ev.worker_id) return null;
  if (ev.exception && ev.key) return `${ev.worker_id}:${ev.key}`;
  if (ev.event === 'death' || ev.event === 'stale') return deathUid(ev.worker_id, ev.event, ev.life || lifeOf(null, null));
  return null;
}

const rm = (f) => { try { fs.unlinkSync(f); } catch { /* already gone */ } };
// Undo a claim whose reply was never sent (a worker_wait cancelled after it claimed, call-signal.cjs): the digest's number and the
// exception markers are removed, so the next asker is offered the same steps and exceptions. Nothing else records a delivery.
function release({ dataDir, runId, digestN = null, uids = [] }) {
  const dir = dirOf(dataDir, runId);
  if (digestN != null) { rm(ownFile(dir, digestN)); rm(`${ownFile(dir, digestN)}.ok`); }
  for (const uid of uids) { rm(markerFile(dir, uid)); rm(`${markerFile(dir, uid)}.ok`); }
}
// The reply was written: the claim stands for good (releaseUnconfirmed leaves it alone).
function confirm({ dataDir, runId, digestN = null, uids = [] }) {
  const dir = dirOf(dataDir, runId);
  const ok = (f) => { try { fs.writeFileSync(`${f}.ok`, ''); } catch { /* best effort: an unconfirmed claim is only released if its claimant is gone */ } };
  if (digestN != null) ok(ownFile(dir, digestN));
  for (const uid of uids) ok(markerFile(dir, uid));
}
// A wait's claim whose reply was never confirmed and whose claimant `orphan(claimant)` calls gone (an adapter that crashed with the reply
// in flight): released, so the next wait offers it. `orphan` is the seam for any other "release on X" (a timeout, an Esc). -> { digests, uids }
async function releaseUnconfirmed({ dataDir, runId, orphan }) {
  const dir = dirOf(dataDir, runId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { digests: [], uids: [] }; }
  const has = new Set(names);
  const out = { digests: [], uids: [] };
  for (const f of names) {
    const isDigest = /^d\d+\.json$/.test(f); const isMarker = /^x-[0-9a-f]+$/.test(f);
    if ((!isDigest && !isMarker) || has.has(`${f}.ok`)) continue;
    let d; try { d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    if (isDigest ? d.via !== 'wait' : !(d.record && d.record.via === 'wait')) continue;
    if (!d.claimant || !(await orphan(d.claimant))) continue;
    if (isDigest) { rm(`${dir}/${f}`); out.digests.push(d.n); } else { rm(`${dir}/${f}`); out.uids.push(d.uid); }
  }
  return out;
}
// The wakes a worker_wait delivered, as run-receipt wakes[] entries (at_ms counted from `t0`).
function readDeliveries(dataDir, runId, t0 = 0) {
  const dir = dirOf(dataDir, runId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!/^x-[0-9a-f]+$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
      if (d.record && d.record.via === 'wait') out.push({ ...d.record, at_ms: Number(d.at) - t0 });
    } catch { /* skipped */ }
  }
  return out.sort((a, b) => a.at_ms - b.at_ms);
}

// The run receipt's digests[]: every claim, in order. A run that never claimed one has no directory, and this makes none.
function readDigests(dataDir, runId) {
  const dir = dirOf(dataDir, runId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!/^d\d+\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
      out.push({ n: d.n, via: d.via, at: d.at, bytes: d.bytes, lines: d.lines, dropped: { count: (d.dropped && d.dropped.count) || 0 } });
    } catch { /* skipped */ }
  }
  return out.sort((a, b) => a.n - b.n);
}

// Every policy step of the run, read in pages after the last seq of the page before (policy.list is capped at 2,000 a call).
async function listSteps(core, runId) {
  const rows = []; let since = 0;
  for (let page = 0; page < 100; page += 1) {
    const got = ((await core.policy.list({ run_id: runId, since_seq: since, limit: PAGE })) || {}).rows || [];
    rows.push(...got);
    const last = got.length ? Number(got[got.length - 1].seq) : since;
    if (got.length < PAGE || !(last > since)) break;
    since = last;
  }
  return rows;
}

const WAKE_CAP = 221; // the wake text cap (policy-wakes.cjs WAKE_TEXT_MAX): the digest that rides a wake is one more wake line
const WAKE_HEAD = 'belay: policy steps since the last wake: ';

// ADR 0074 decision 4: the interactive path. The digest of the steps no digest has taken yet, as one wake line (short lines), or null.
async function wakeDigest({ core, dataDir, runId, now = Date.now, claimant = null, hooks = {} }) {
  let rows;
  try { rows = await listSteps(core, runId); } catch { return null; }
  const rec = claimDigest({ dataDir, runId, rows, cap: WAKE_CAP, form: { head: WAKE_HEAD, sep: '; ', short: true }, via: 'wake', now, claimant, hooks });
  return rec ? { id: `${runId}:digest:${rec.n}`, text: rec.text, n: rec.n } : null;
}

// The receipt field: digests[] when the run took a policy step or returned a digest, nothing for a run with no plan (its receipt is as before).
async function receiptField(core, dataDir, runId) {
  const digests = readDigests(dataDir, runId);
  let steps = 0;
  try { steps = (((await core.policy.list({ run_id: runId, limit: 1 })) || {}).rows || []).length; } catch { /* an old store has no steps */ }
  return digests.length || steps ? { digests } : {};
}

module.exports = { wakeUid, deathUid, lifeOf, release, confirm, releaseUnconfirmed, readDeliveries, isClaimed, listSteps, wakeDigest, receiptField, claimDigest, claimException, readDigests, build, lineOf, CAP_BYTES };
