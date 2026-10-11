'use strict';
// summarise.cjs — the summariser seam (ADR 0041 §4). The `mechanical` kind is built: it assembles a summary
// from rows and worker-stated fields, makes no model call and no network call, and labels what the worker
// said as the worker's. The `model` kind is not built and refuses by name. Every result, from any kind, is
// run through `classify`, and each class has exactly one policy in POLICY, so a model kind cannot be added
// without deciding what happens to its empty, malformed, refused and oversize answers.

const { CoreError } = require('../core/errors.cjs');

const FIELD_KEYS = ['asked', 'looked_at', 'learned', 'done', 'next', 'notes'];
const NOT_STATED = '(not stated)';
const ASKED_MAX = 400;
const MAX_BYTES = 8192;
const GENERATOR_VERSION = 1;

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
  if (FIELD_KEYS.every((k) => isBlank(f[k]))) return 'empty';
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

function mechanical(input) {
  const i = input || {};
  const task = i.task && typeof i.task === 'object' ? i.task : {};
  const handoff = i.handoff && typeof i.handoff === 'object' ? i.handoff : {};
  const bodies = asArray(i.observations).map(bodyOf);
  const checkpoints = asArray(i.checkpoints).map(bodyOf);

  const spec = typeof task.spec === 'string' ? task.spec : (typeof task.title === 'string' ? task.title : '');
  const learned = flat(statedText(handoff.findings) || statedText(handoff.summary));
  const nexts = [...checkpoints.map((c) => c.next_step), handoff.next_step].map((v) => flat(statedText(v))).filter(Boolean);
  const commands = bodies.flatMap((b) => asArray(b.commands)).map((c) => ({
    command: c.command, exit_code: c.exit_code === undefined ? null : c.exit_code,
  }));
  const errors = bodies.reduce((n, b) => n + (Number.isInteger(b.errors) ? b.errors : 0), 0);
  // Two verdicts, never one field: the harness's, from task.evaluate (the caller passes task.verdict), and what the
  // worker said of its own work in its handoff, labelled as the worker's.
  const verdict = flat(statedText(task.verdict));
  const workerVerdict = flat(statedText(handoff.verdict) || statedText(handoff.acceptance));

  return {
    asked: cutBytes(flat(spec), ASKED_MAX),
    looked_at: uniq(bodies.flatMap((b) => asArray(b.files_read)).map((f) => (typeof f === 'string' ? flat(f) : f))),
    learned: learned ? `worker-stated: ${learned}` : NOT_STATED,
    done: {
      files_modified: uniq(bodies.flatMap((b) => asArray(b.files_modified)).map((f) => (typeof f === 'string' ? flat(f) : f))),
      commands, task_state: typeof task.state === 'string' ? task.state : null,
    },
    next: nexts.length ? `worker-stated: ${nexts[nexts.length - 1]}` : '',
    notes: { errors, verdict: verdict || null, worker_verdict: workerVerdict ? `worker-stated: ${workerVerdict}` : null },
  };
}

// summarise(input, { kind }) → Promise<{ fields, generator, output_class }>. `input = { task, observations,
// checkpoints, handoff }`. The result is classified here; the caller applies POLICY[output_class].
async function summarise(input, opts) {
  const kind = (opts && opts.kind) || 'mechanical';
  if (kind === 'model') {
    throw coded('E_SUMMARISER_ABSENT', 'the model summariser is not built; a later decision record must add it as a belay-spawned, budgeted process (ADR 0041 section 4)');
  }
  if (kind !== 'mechanical') throw coded('E_ARGS', `unknown summariser kind '${kind}'; expected 'mechanical' or 'model'`);
  const result = { fields: mechanical(input), generator: { kind: 'mechanical', version: GENERATOR_VERSION, model: null } };
  result.output_class = classify(result);
  return result;
}

module.exports = { summarise, classify, POLICY, FIELD_KEYS, MAX_BYTES };
