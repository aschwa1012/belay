'use strict';
// methods-embed-query.cjs — memory.embedQuery: the query vectors for the first-message index (ADR 0042 decision 2). The run
// manager calls it when a worker spawns or relaunches, then hands the vectors to memory.index, which never embeds. It runs in
// the store owner, through the same embedding phase memory.search uses (withEmbedding): the model loads there, the canary is
// checked there, and an embedder failure goes to the owner's ADR 0034 hook, so `on_embedder_failure` decides whether the run
// pauses (the hook is told the call name `memory.embedQuery` and the worker the call is for).
//
// Input: { task_id?, extra_texts?, worker_id?, timeout_ms? }.
//   task_id     the task's own text, its `spec` (a task has no separate title; the spec's opening line is it), read here from
//               the task row, so the caller never sends it and a relaunch embeds the same text a spawn did. Label `task`.
//   extra_texts up to 4 further short queries (strings, or { label, text }), written by the orchestrator in time; labelled
//               `extra:1`, `extra:2`, ... unless they carry a label. Nothing in the run manager sends them yet.
//   worker_id   the worker the call is for, for the hook's label.
//   timeout_ms  the whole call's bound, 12,000 ms by default (500 to 100,000): a spawn must not wait on a slow embedder.
// Each text is cut to TEXT_CHARS characters first (the embedder's cost grows with the text; on the real model 2,048 characters
// take about 3 s), and the call's input is at most INPUT_MAX bytes.
//
// Output: { queries: [{ label, ok, ms, query_embedding?, embedding_model?, dim?, code?, message?, cause?, timed_out? }],
//           on_embedder_failure, embed_ms }. A text that could not be embedded is its own entry with ok false and its code; an
// embedder failure (detail.embedder true) also reaches the hook. A text still unembedded when the bound passes is ok false,
// timed_out true, code E_EMBED_BOUND, and does NOT reach the hook (it is a late answer, not a failed model); the embed in
// flight finishes on its own and a failure of it is reported to the hook then. A bad call (E_ARGS) or a call from another
// channel (E_ROLE) is thrown. Writes nothing; it is a `write` method in the engine table only so that the call reaches the
// owner (as memory.warm does). Harness channel only: the run manager holds it, a model's tool call never does.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { withEmbedding } = require('./methods-memory.cjs');

const TEXT_CHARS = 2048;
const EXTRA_MAX = 4;
const INPUT_MAX = 65536;
const DEFAULT_TIMEOUT_MS = 12000;
const CALL = 'memory.embedQuery';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function parseExtras(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > EXTRA_MAX) throw err('E_ARGS', `memory.embedQuery extra_texts must be an array of at most ${EXTRA_MAX}`, { field: 'extra_texts' });
  return list.map((x, i) => {
    const text = typeof x === 'string' ? x : x && x.text;
    const label = typeof x === 'object' && x && x.label ? x.label : `extra:${i + 1}`;
    if (!isStr(text)) throw err('E_ARGS', `memory.embedQuery extra_texts[${i}] must be a non-empty string or { label, text }`, { field: 'extra_texts' });
    if (typeof label !== 'string' || label.length > 64) throw err('E_ARGS', `memory.embedQuery extra_texts[${i}].label must be a string of at most 64 characters`, { field: 'extra_texts' });
    return { label, text };
  });
}

async function embedQuery(E, caller, args = {}) {
  if (caller.channel !== 'harness') {
    throw err('E_ROLE', `memory.embedQuery belongs to the run manager's harness channel and this call came from the ${caller.channel || 'tool'} channel; this is a wiring fault, not an embedder failure`, { role: caller.role, channel: caller.channel || 'tool' });
  }
  if (args.task_id != null && !isStr(args.task_id)) throw err('E_ARGS', 'memory.embedQuery task_id must be a non-empty string', { field: 'task_id' });
  if (args.worker_id != null && !isStr(args.worker_id)) throw err('E_ARGS', 'memory.embedQuery worker_id must be a non-empty string', { field: 'worker_id' });
  const timeout = args.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : args.timeout_ms;
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 100000) throw err('E_ARGS', 'memory.embedQuery timeout_ms must be an integer from 500 to 100000', { field: 'timeout_ms' });
  const extras = parseExtras(args.extra_texts);
  if (Buffer.byteLength(JSON.stringify(extras), 'utf8') > INPUT_MAX) throw err('E_ARGS', `memory.embedQuery extra_texts must be at most ${INPUT_MAX} bytes in all`, { field: 'extra_texts' });

  const texts = [];
  const task = args.task_id ? rows.current(E.store, 'task', args.task_id) : null;
  if (task && isStr(task.spec)) texts.push({ label: 'task', text: task.spec });
  texts.push(...extras);

  const mode = E.owner && E.owner.opts ? E.owner.opts.embedderMode : null;
  const t0 = Date.now();
  const deadline = t0 + timeout;
  const queries = [];
  for (const t of texts) {
    const left = deadline - Date.now();
    const s0 = Date.now();
    const timedOut = (label) => ({ label, ok: false, ms: Date.now() - s0, code: 'E_EMBED_BOUND', timed_out: true, message: `the ${timeout} ms bound for embedding the index query passed before ${label} was embedded` });
    if (left <= 0) { queries.push(timedOut(t.label)); continue; }
    let timer;
    const bound = new Promise((resolve) => { timer = setTimeout(() => resolve('bound'), left); });
    const work = withEmbedding(E, { query: t.text.slice(0, TEXT_CHARS) }, 'query_embedding', 'query', caller, CALL, args.worker_id).then((e) => ({ e }), (error) => ({ error }));
    const got = await Promise.race([work, bound]);
    clearTimeout(timer);
    if (got === 'bound') { queries.push(timedOut(t.label)); continue; }
    if (got.e) {
      queries.push({ label: t.label, ok: true, ms: Date.now() - s0, query_embedding: got.e.query_embedding, embedding_model: got.e.embedding_model, dim: got.e.query_embedding.length });
      continue;
    }
    const e = got.error;
    queries.push({ label: t.label, ok: false, ms: Date.now() - s0, code: (e && e.code) || 'E_INTERNAL', message: String((e && e.message) || e).slice(0, 300), cause: (e && e.detail && e.detail.cause) || null, embedder: !!(e && e.detail && e.detail.embedder === true) });
  }
  return { queries, on_embedder_failure: mode === 'stop' || mode === 'continue' ? mode : null, embed_ms: Date.now() - t0 };
}

module.exports = { embedQuery, TEXT_CHARS, EXTRA_MAX, DEFAULT_TIMEOUT_MS };
