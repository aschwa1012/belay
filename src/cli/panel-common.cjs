'use strict';
// panel-common.cjs — what `belay transcript`, `belay notices` and `belay agents` share (ADR 0036
// decision 8, build step U1): the text sanitiser, the 120-column wrap, the orchestrator stream's
// location and the run choice. fs, os and path only: nothing here reaches src/core, src/run or the
// embedder, so a command that imports it pays for nothing it does not use.

const os = require('node:os');
const path = require('node:path');

const WIDTH = 120;
const STREAM_NAME = 'stream.jsonl'; // src/run/orchestrator.cjs writes `<orchestrator_dir>/stream.jsonl`

const fwd = (p) => String(p).split('\\').join('/');

// Where a run's orchestrator stream is. The run row names no orchestrator_dir yet (ADR 0036 U4), so
// the default is what `belay run` uses when the spec sets none (src/cli/cmd-run.cjs:225); `--dir`
// names a spec's own. Relative to the caller's cwd, absolute, forward slashes.
function orchestratorStreamPath(runId, dirOverride, cwd) {
  const dir = dirOverride
    ? fwd(path.resolve(cwd || process.cwd(), dirOverride))
    : fwd(path.join(os.tmpdir(), 'belay-run', String(runId)));
  return { dir, stream_path: `${dir}/${STREAM_NAME}` };
}

// The run chosen exactly as `receipts`/`status`/`workers` choose it: the argument, else the run
// flagged alive, else the newest written row. `chosen` is null when there is none.
async function chooseRun(core, runId) {
  const { runs } = await core.run.list({});
  if (runId) return { chosen: runs.find((r) => r.id === runId) || null, source: 'argument' };
  if (runs.length) return { chosen: runs.find((r) => r.alive) || runs[0], source: 'run.list' };
  return { chosen: null, source: 'none' };
}

// The one sanitiser (cmd-receipts.cjs states the character classes): control, C1, line and paragraph
// separators, bidi and zero-width characters become spaces; whitespace runs collapse to one space; the
// cap counts code points. Nothing a stream or a row holds can start a line of its own.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u2060\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
function clean(x, cap = 80) {
  const s = String(x).replace(CONTROL, ' ').replace(/\s{2,}/g, ' ');
  const cps = Array.from(s);
  return cps.length > cap ? cps.slice(0, cap).join('') : s;
}

const v = (x, cap) => (x === null || x === undefined ? 'not recorded' : clean(x, cap));
const iso = (ms) => (ms == null || !Number.isFinite(Number(ms)) ? 'not recorded' : new Date(Number(ms)).toISOString());

// At most 4 decimals, trailing zeros trimmed; a value that rounds to zero prints 0.0000.
function money(x) {
  if (x === null || x === undefined) return 'not recorded';
  const n = Number(x);
  if (!Number.isFinite(n)) return clean(x);
  let t = n.toFixed(4);
  if (Number(t) !== 0) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return `$${t}`;
}

// One line broken at spaces to fit WIDTH: `prefix` on the first line, spaces of the same length on
// the rest. A word longer than the room is cut at the room. Input is cleaned by the caller.
function wrapLine(prefix, text, width = WIDTH) {
  const room = Math.max(20, width - Array.from(prefix).length);
  const pad = ' '.repeat(Array.from(prefix).length);
  const out = [];
  let cur = '';
  const push = () => { out.push((out.length ? pad : prefix) + cur); cur = ''; };
  for (const word of text.split(' ')) {
    let w = word;
    while (Array.from(w).length > room) {
      if (cur) push();
      const cps = Array.from(w);
      cur = cps.slice(0, room).join('');
      push();
      w = cps.slice(room).join('');
    }
    if (!cur) { cur = w; continue; }
    if (Array.from(cur).length + 1 + Array.from(w).length > room) { push(); cur = w; } else cur += ` ${w}`;
  }
  if (cur || !out.length) push();
  return out;
}

// A user-message `content` as plain text: a string, or the text blocks of an array joined by newlines.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// The count of notes stored without a vector, as one line with the command that embeds them. `u` is the core's
// { total, by_project }; a project name is core-written but still goes through the sanitiser.
function unembeddedText(u) {
  const names = Object.keys(u.by_project || {}).sort();
  const where = names.length === 1 ? ` --project ${clean(names[0], 64)}` : ' --project <p>';
  const per = names.length > 1 ? ` (${names.map((p) => `${clean(p, 64)} ${u.by_project[p]}`).join(', ')})` : '';
  return `${u.total} note${u.total === 1 ? '' : 's'} unembedded${per}: embed with belay memory embed${where}`;
}

// Notes held for the Opus archive reviewer: a count, the oldest wait in runs, the projects, and the command that dispatches it. `queued` is the part
// of the count that hides nothing (a report past its run's breaker), named apart: "3 held, 1 queued".
const heldCount = (h) => { const q = Number(h.queued) || 0; return q > 0 ? `${h.total - q} held, ${q} queued` : `${h.total} held`; };
const GROUND_LABEL = { reported: 'reported wrong', report_confirmed: 'reported wrong', code_contradicts: 'wrong', refuted_review: 'wrong', same_claim: 'duplicate', replaced_by_newer: 'superseded', unsupported: 'unsupported', none: 'other' };
// "3 held: 2 reported wrong, 1 duplicate; 1 queued past the breaker; 1 awaits you" when the count is broken down by ground; null when it is not.
function heldBreakdown(h) {
  const g = h.by_ground && typeof h.by_ground === 'object' ? h.by_ground : null;
  if (!g || !Object.keys(g).length) return null;
  const parts = new Map();
  for (const [k, n] of Object.entries(g)) parts.set(GROUND_LABEL[k] || clean(k, 30), (parts.get(GROUND_LABEL[k] || clean(k, 30)) || 0) + Number(n));
  const a = Number(h.awaiting_operator) || 0;
  const q = Number(h.queued) || 0;
  return `${h.total - q} held: ${[...parts].map(([k, n]) => `${n} ${k}`).join(', ')}${q > 0 ? `; ${q} queued past the breaker` : ''}${a > 0 ? `; ${a} await${a === 1 ? 's' : ''} you` : ''}`;
}

// Held rows the read filter cannot read: withheld closed, and, for one that names no note, every note of its project with it.
function unreadableText(u) {
  const closed = Array.isArray(u.closed_projects) ? u.closed_projects.map((p) => clean(p, 64)) : [];
  const n = Number(u.count) || 0;
  const whole = closed.length ? `; every note of project${closed.length === 1 ? '' : 's'} ${closed.join(', ')} is withheld from workers` : '';
  return `${n} held row${n === 1 ? '' : 's'} cannot be read; ${n === 1 ? 'its note is' : 'their notes are'} withheld from workers (closed)${whole} until fixed or settled: see belay memory held`;
}

function heldText(h) {
  const b = heldBreakdown(h);
  if (b) return `${b}: review with belay memory review`;
  const names = Object.keys(h.by_project || {}).sort();
  const per = names.length > 1 ? ` (${names.map((p) => `${clean(p, 64)} ${h.by_project[p]}`).join(', ')})` : '';
  const where = names.length === 1 ? ` --project ${clean(names[0], 64)}` : ' --project <p>';
  const u = h.unsupported || 0;
  if (u > 0) return `${h.total - u > 0 ? `${h.total - u} held as wrong or duplicate · ` : ''}${u} unsupported awaiting review${per}, oldest ${h.oldest_age_runs || 0} run${h.oldest_age_runs === 1 ? '' : 's'}: review with belay memory review${where}`;
  if (Number(h.queued) > 0) return `${heldCount(h)} for review${per}, oldest ${h.oldest_age_runs || 0} run${h.oldest_age_runs === 1 ? '' : 's'}: review with belay memory review${where}`;
  return `${h.total} note${h.total === 1 ? '' : 's'} held for review${per}, oldest ${h.oldest_age_runs || 0} run${h.oldest_age_runs === 1 ? '' : 's'}: review with belay memory review${where}`;
}

module.exports = { unembeddedText, unreadableText, heldText, WIDTH, STREAM_NAME, fwd, orchestratorStreamPath, chooseRun, clean, v, iso, money, wrapLine, contentText };
