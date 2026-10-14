'use strict';
// summarise.cjs — the summariser seam (ADR 0041 §4). The `mechanical` kind is built: it assembles a summary
// from rows and worker-stated fields, makes no model call and no network call, and labels what the worker
// said as the worker's. The `model` kind is not built and refuses by name. Every result, from any kind, is
// run through `classify`, and each class has exactly one policy in POLICY, so a model kind cannot be added
// without deciding what happens to its empty, malformed, refused and oversize answers.

const { CoreError } = require('../core/errors.cjs');
const { redact } = require('../core/redact.cjs');

const FIELD_KEYS = ['asked', 'looked_at', 'learned', 'done', 'next', 'notes'];
// `final` (body v2) is optional so a v1 shape still classifies; when present it must be a string.
const OPTIONAL_STRING_KEYS = ['final'];
const NOT_STATED = '(not stated)';
const ASKED_MAX = 400;
const MAX_BYTES = 8192;
const GENERATOR_VERSION = 2;
const TITLE_MAX = 160; // the store's title bound (methods-memory.cjs)
const FINAL_MAX = 1200; // the whole `final` field, label included
const WORKER_LABEL = 'worker-stated: ';
// What a long task may put in a summary (ADR 0044 decision 4.1): the last commands and the first files, each
// with a count of the rest. The fields are fitted under BODY_ROOM so the stored body (fields plus the row's
// version and generator keys) stays under MAX_BYTES.
const KEEP_COMMANDS = 30;
const KEEP_FILES = 50;
const COMMAND_MAX = 200;
// Worker-stated fields are bounded so no handoff can push a summary over budget (cap in bytes, before the label).
const LEARNED_MAX = 2000;
const NEXT_MAX = 600;
const VERDICT_MAX = 300;
const BODY_ROOM = MAX_BYTES - 512;

// class -> what the caller does. `store` false means no row; `code` is the memory_event code recorded.
const POLICY = Object.freeze({
  ok: Object.freeze({ store: true, code: null }),
  empty: Object.freeze({ store: false, code: 'E_SUMMARY_EMPTY' }),
  malformed: Object.freeze({ store: false, code: 'E_SUMMARY_MALFORMED' }),
  refused: Object.freeze({ store: false, code: 'E_SUMMARY_REFUSED' }),
  over_budget: Object.freeze({ store: false, code: 'E_SUMMARY_OVER_BUDGET' }),
});

// These codes may not be in errors.cjs's list until the schema change lands. CoreError would fold an
// unlisted code into E_INTERNAL, so set the code after construction: it must reach the caller as itself.
function coded(code, message) {
  const e = new CoreError(code, message);
  e.code = code;
  e.message = message;
  return e;
}

function cutBytes(s, max) {
  let out = s.slice(0, max); // a character is at least one byte, so this cannot cut too little
  while (out && Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, -1);
  if (out && /[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

const isBlank = (v) => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '' || v === NOT_STATED;
  if (Array.isArray(v)) return v.every(isBlank);
  if (typeof v === 'object') return Object.values(v).every(isBlank);
  return v === 0; // a zero count states nothing
};

// classify(output) → 'ok' | 'empty' | 'malformed' | 'refused' | 'over_budget'. The order matters: a result
// that is not even the right shape is malformed before anything else is asked of it.
function classify(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return 'malformed';
  const f = output.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'malformed';
  if (output.refused === true || (typeof f.refusal === 'string' && f.refusal)) return 'refused';
  for (const k of FIELD_KEYS) if (!(k in f)) return 'malformed';
  if (typeof f.asked !== 'string' || typeof f.learned !== 'string' || typeof f.next !== 'string') return 'malformed';
  if (!Array.isArray(f.looked_at)) return 'malformed';
  if (f.done === null || typeof f.done !== 'object') return 'malformed';
  if (f.notes === null || typeof f.notes !== 'object') return 'malformed';
  for (const k of OPTIONAL_STRING_KEYS) if (k in f && typeof f[k] !== 'string') return 'malformed';
  if ([...FIELD_KEYS, ...OPTIONAL_STRING_KEYS].every((k) => isBlank(f[k]))) return 'empty';
  if (Buffer.byteLength(JSON.stringify(f), 'utf8') > MAX_BYTES) return 'over_budget';
  return 'ok';
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const uniq = (list) => [...new Set(list.filter((x) => typeof x === 'string' && x))];
// A stored row carries `body` as an object or as the JSON text of one.
function bodyOf(o) {
  const b = o && o.body !== undefined ? o.body : o;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b && typeof b === 'object' ? b : {};
}
function statedText(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(statedText).filter(Boolean).join('; ');
  return '';
}
// Words a worker or a row wrote go into the summary on one line each: the summary text is rendered line by line
// (memory-jobs.cjs render), and a newline inside a worker-stated field could start a line that passes for a row,
// a status or the harness's own verdict.
const flat = (v) => String(v).replace(/\s+/g, ' ').trim();

// A title is one line the index renders after `- <id> [type/status] `: control characters become spaces, whitespace
// collapses, the text is redacted, and only then is it cut, on a character edge, to the store's bound (the store
// redacts again and refuses a title over the bound, so the cut must follow the redaction).
function titleOf(taskId, learned) {
  const text = typeof learned === 'string' ? learned.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) return `summary: task ${taskId} (no findings stated)`;
  return cutBytes(redact(WORKER_LABEL + text).text.replace(/\s+/g, ' ').trim(), TITLE_MAX);
}
// The last turn's final text: the newest observation that states one (observe.cjs keeps it as `narrative`).
function finalOf(bodies) {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const n = bodies[i] && bodies[i].narrative;
    const t = typeof n === 'string' ? flat(n) : '';
    if (t) return WORKER_LABEL + capText(t, FINAL_MAX - WORKER_LABEL.length);
  }
  return '';
}

const sizeOf = (f) => Buffer.byteLength(JSON.stringify(f), 'utf8');
// Cuts a string to `max` bytes on a character boundary and says how much was cut; a string within `max` is returned as is.
function capText(v, max) {
  if (typeof v !== 'string') return v;
  const total = Buffer.byteLength(v, 'utf8');
  if (total <= max) return v;
  const kept = cutBytes(v, Math.max(0, max - 24));
  return `${kept}…[+${total - Buffer.byteLength(kept, 'utf8')} bytes]`;
}
// Keeps the newest commands (a command's text is cut with a visible marker) and the first `keep` of a list; the rest is a count.
function boundCommands(done, all) {
  const kept = all.slice(-KEEP_COMMANDS).map((c) => ({ command: capText(c.command, COMMAND_MAX), exit_code: c.exit_code }));
  done.commands = kept;
  if (all.length > kept.length) done.commands_omitted = all.length - kept.length;
}
function boundList(all, keep) { return { kept: all.slice(0, keep), omitted: Math.max(0, all.length - keep) }; }
// If the fields are still over, commands go before anything else, then the file lists are halved.
function fitFields(fields, allCommands, allLooked, allFiles) {
  if (sizeOf(fields) <= BODY_ROOM) return;
  fields.done.commands = [];
  if (allCommands.length) fields.done.commands_omitted = allCommands.length;
  for (let keep = KEEP_FILES >> 1; sizeOf(fields) > BODY_ROOM && keep >= 0; keep = keep ? keep >> 1 : -1) {
    const lk = boundList(allLooked, keep); const fm = boundList(allFiles, keep);
    fields.looked_at = lk.kept; fields.done.files_modified = fm.kept;
    for (const [obj, key, n] of [[fields, 'looked_at_omitted', lk.omitted], [fields.done, 'files_modified_omitted', fm.omitted]]) { if (n) obj[key] = n; else delete obj[key]; }
  }
}

function mechanical(input) {
  const i = input || {};
  const task = i.task && typeof i.task === 'object' ? i.task : {};
  const handoff = i.handoff && typeof i.handoff === 'object' ? i.handoff : {};
  const bodies = asArray(i.observations).map(bodyOf);
  const checkpoints = asArray(i.checkpoints).map(bodyOf);

  const spec = typeof task.spec === 'string' ? task.spec : (typeof task.title === 'string' ? task.title : '');
  const learned = capText(flat(statedText(handoff.findings) || statedText(handoff.summary)), LEARNED_MAX);
  // A worker checkpoint states its next step under `stated`; a harness checkpoint states none.
  const nexts = [...checkpoints.map((c) => (c.stated && typeof c.stated === 'object' ? c.stated.next_step : c.next_step)), handoff.next_step].map((v) => capText(flat(statedText(v)), NEXT_MAX)).filter(Boolean);
  const allCommands = bodies.flatMap((b) => asArray(b.commands)).map((c) => ({
    command: c.command, exit_code: c.exit_code === undefined ? null : c.exit_code,
  }));
  const errors = bodies.reduce((n, b) => n + (Number.isInteger(b.errors) ? b.errors : 0), 0);
  // Two verdicts, never one field: the harness's, from task.evaluate (the caller passes task.verdict), and what the
  // worker said of its own work in its handoff, labelled as the worker's.
  const verdict = flat(statedText(task.verdict));
  const workerVerdict = capText(flat(statedText(handoff.verdict) || statedText(handoff.acceptance)), VERDICT_MAX);

  const allLooked = uniq(bodies.flatMap((b) => asArray(b.files_read)).map((f) => (typeof f === 'string' ? flat(f) : f)));
  const allFiles = uniq(bodies.flatMap((b) => asArray(b.files_modified)).map((f) => (typeof f === 'string' ? flat(f) : f)));
  const looked = boundList(allLooked, KEEP_FILES);
  const modified = boundList(allFiles, KEEP_FILES);

  const fields = {
    asked: cutBytes(flat(spec), ASKED_MAX),
    looked_at: looked.kept,
    learned: learned ? `worker-stated: ${learned}` : NOT_STATED,
    done: {
      files_modified: modified.kept,
      commands: [], task_state: typeof task.state === 'string' ? task.state : null,
    },
    final: finalOf(bodies),
    next: nexts.length ? `worker-stated: ${nexts[nexts.length - 1]}` : '',
    notes: { errors, verdict: verdict || null, worker_verdict: workerVerdict ? `worker-stated: ${workerVerdict}` : null },
  };
  boundCommands(fields.done, allCommands);
  const part = i.partial;
  if (part && typeof part === 'object') fields.observations_partial = { read: part.read, listed: part.listed, code: part.code };
  if (looked.omitted) fields.looked_at_omitted = looked.omitted;
  if (modified.omitted) fields.done.files_modified_omitted = modified.omitted;
  fitFields(fields, allCommands, allLooked, allFiles);
  return fields;
}

// summarise(input, { kind }) → Promise<{ fields, generator, output_class }>. `input = { task, observations,
// checkpoints, handoff }`. The result is classified here; the caller applies POLICY[output_class].
async function summarise(input, opts) {
  const kind = (opts && opts.kind) || 'mechanical';
  if (kind === 'model') {
    throw coded('E_SUMMARISER_ABSENT', 'the model summariser is not built; a later decision record must add it as a belay-spawned, budgeted process (ADR 0041 section 4)');
  }
  if (kind !== 'mechanical') throw coded('E_ARGS', `unknown summariser kind '${kind}'; expected 'mechanical' or 'model'`);
  const fields = mechanical(input);
  const stated = fields.learned.startsWith(WORKER_LABEL) ? fields.learned.slice(WORKER_LABEL.length) : '';
  const taskId = input && input.task && input.task.id;
  const result = { fields, title: titleOf(taskId, stated), generator: { kind: 'mechanical', version: GENERATOR_VERSION, model: null } };
  result.output_class = classify(result);
  return result;
}

module.exports = { summarise, classify, titleOf, POLICY, FIELD_KEYS, MAX_BYTES };
