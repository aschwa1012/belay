'use strict';
// knowledge.cjs — ADR 0043 decision 1: the knowledge agent. `ask(manager, ctx, { question, timeout_ms })` is what
// the run manager's `ask` calls. With the run's `knowledge_agent` lever off it refuses E_LEVER_OFF before it does
// anything. With it on, the agent is an ordinary worker (invariant 1): spawned by the manager, with its id given
// in argv (`knowledge-<run>`), subject to liveness, pause, stop and budgets like any other.
//
// Priming: the corpus (memory.corpus) is written to workers/<id>/corpus.md and the first question names it. The
// agent is primed again, by a message, only when the corpus sha256 differs from the one it last read; each priming
// is a `corpus_primed` memory_event, and each question a `knowledge_ask` event. Asking: message the worker, wait
// for its turn with the manager's own `wait`, then look up every `[mem:<id>]` the answer cites. A cited id with no
// row is reported `found: false`, never dropped. Questions to one manager are answered one at a time, because one
// worker takes one turn at a time.
//
// `ctx` is { core, runId, dataDir, worktree?, levers? }: the run's core handle, its id and data dir, the cwd the
// agent works in (default: this process's) and, for a caller that already read them, the memory levers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('./launch.cjs');
const { writeAtomic } = require('./bottle.cjs');
const { fail } = require('./errors.cjs');

// ADR 0021 decision 1 as amended: researchers and reviewers run on Opus. The agent only reads.
const KNOWLEDGE_MODEL = 'claude-opus-5-5';
const KNOWLEDGE_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__belay'];
const QUESTION_MAX_BYTES = 4096;
const GET_MANY_MAX = 50;
const CITE_RE = /\[mem:([^\]\s]+)\]/g;
const SUBSTANTIVE_MIN = 30; // a line shorter than this is a label or a connective, not a claim

const PROMPT_FILE = path.join(__dirname, 'prompts', 'knowledge.md');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const workerIdFor = (runId) => `knowledge-${runId}`;

const states = new WeakMap(); // manager -> { sha, chain }
function stateOf(manager) {
  let s = states.get(manager);
  if (!s) { s = { sha: null, chain: Promise.resolve() }; states.set(manager, s); }
  return s;
}

// Every distinct cited id, in the order first cited.
function citedIds(answer) {
  const out = [];
  for (const m of answer.matchAll(CITE_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// True when some substantive line of the answer carries no citation and does not say it is not in memory.
function hasUncitedClaims(answer) {
  return answer.split('\n').some((line) => {
    const t = line.trim();
    if (t.length < SUBSTANTIVE_MIN || t.startsWith('#')) return false;
    return !t.includes('[mem:') && !/not in memory/i.test(t);
  });
}

async function lookUp(core, ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += GET_MANY_MAX) {
    const got = await core.memory.get_many({ ids: ids.slice(i, i + GET_MANY_MAX), view: 'index' });
    for (const r of got.rows) if (r && r.found) byId.set(r.id, r);
  }
  return ids.map((id) => (byId.has(id)
    ? { id, found: true, status: byId.get(id).status || 'unverified' }
    : { id, found: false, status: null }));
}

// The corpus sha256 the agent last read, from the ledger, for a manager that has the worker but no memory of
// priming it (an adopted record).
async function lastPrimedSha(core, runId, workerId) {
  const got = await core.memory.events({ run_id: runId, worker_id: workerId, kinds: ['corpus_primed'] });
  const rows = (got.events || []).filter((e) => e.ok);
  return rows.length ? rows[rows.length - 1].sha256 : null;
}

const noteFailure = (core, workerId, question, e) => core.memory.recordEvent({
  kind: 'knowledge_ask', worker_id: workerId, sha256: sha256(question), ok: false,
  code: (e && e.code) || 'E_INTERNAL', message: String((e && e.message) || e).slice(0, 300),
}).catch(() => {}); // the error being reported is the one the caller needs

async function doAsk(manager, ctx, state, args) {
  const t0 = Date.now();
  const { question, timeout_ms = 110000 } = args || {};
  if (typeof question !== 'string' || !question.trim()) fail('E_ARGS', 'ask needs a question');
  if (Buffer.byteLength(question, 'utf8') > QUESTION_MAX_BYTES) fail('E_ARGS', `ask: the question is over ${QUESTION_MAX_BYTES} bytes`, { max: QUESTION_MAX_BYTES });
  const { core, runId } = ctx;
  const levers = ctx.levers || await require('./memory-levers.cjs').leversFor(core, runId);
  if (!levers.knowledge_agent) {
    fail('E_LEVER_OFF', 'the knowledge agent is off for this run; set memory.knowledge_agent to true in the run spec', { lever: 'knowledge_agent' });
  }
  if (!ctx.dataDir) fail('E_ARGS', 'ask needs the run\'s data dir in its context');

  const id = workerIdFor(runId);
  const exists = !!(manager._worker && manager._worker(id));
  const corpus = await core.memory.corpus(levers.project ? { project: levers.project } : {});
  const corpusPath = `${L.fwd(L.workerDir(ctx.dataDir, id))}/corpus.md`;
  const known = exists ? (state.sha || await lastPrimedSha(core, runId, id)) : null;
  const changed = known !== corpus.sha256;
  if (changed || !fs.existsSync(corpusPath)) {
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    writeAtomic(corpusPath, corpus.text);
  }
  if (changed) {
    // The receipt comes before anything is sent, so a priming that cannot be recorded sends nothing and the
    // next question tries again.
    await core.memory.recordEvent({
      kind: 'corpus_primed', worker_id: id, bytes: corpus.bytes, sha256: corpus.sha256,
      row_ids: corpus.row_ids, dropped: corpus.dropped > 0, over_budget: corpus.over_budget,
    });
  }

  let turn;
  try {
    if (!exists) {
      const intro = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      await manager.spawn({
        substrate: 'claude-code', worktree: ctx.worktree || process.cwd(), worker_id: id,
        model: KNOWLEDGE_MODEL, allowed_tools: KNOWLEDGE_TOOLS,
        prompt: `${intro}\n\nThe corpus is in ${corpusPath}. Read it now.\n\nQuestion:\n${question}`,
      });
    } else {
      const lead = changed ? `The corpus changed. Read ${corpusPath} again in full before you answer.\n\n` : '';
      await manager.message({ worker_id: id, text: `${lead}Question:\n${question}` });
    }
    state.sha = corpus.sha256;
    const w = await manager.wait({ worker_ids: [id], timeout_ms });
    if (w.timed_out) fail('E_TIMEOUT', `the knowledge agent did not finish its turn inside ${w.waited_ms} ms; ask again to collect it`, { worker_id: id, waited_ms: w.waited_ms });
    if (w.event !== 'turn_end' || w.is_error) {
      fail(w.event === 'turn_end' ? 'E_SUBSTRATE' : 'E_WORKER_NOT_LIVE',
        `the knowledge agent ${w.event === 'turn_end' ? 'ended its turn in error' : `is ${w.event}`}`, { worker_id: id, event: w.event, established_by: w.established_by });
    }
    turn = w.turn;
    const rec = manager._worker(id);
    const answer = rec && typeof rec.lastAssistantText === 'string' ? rec.lastAssistantText.trim() : '';
    if (!answer) fail('E_SUBSTRATE', 'the knowledge agent ended its turn with no text', { worker_id: id, turn });
    const cited = await lookUp(core, citedIds(answer));
    await core.memory.recordEvent({
      kind: 'knowledge_ask', worker_id: id, bytes: Buffer.byteLength(answer, 'utf8'), sha256: sha256(question),
      row_ids: cited.map((c) => c.id), ok: true,
    });
    return { answer, cited, uncited_claims: hasUncitedClaims(answer), worker_id: id, turn, waited_ms: Date.now() - t0 };
  } catch (e) {
    await noteFailure(core, id, question, e);
    throw e;
  }
}

// One question at a time per manager. A refusal for the lever is immediate and cached nowhere.
function ask(manager, ctx, args) {
  const state = stateOf(manager);
  const run = state.chain.then(() => doAsk(manager, ctx, state, args));
  state.chain = run.catch(() => {});
  return run;
}

module.exports = { ask, workerIdFor, citedIds, hasUncitedClaims, KNOWLEDGE_MODEL, KNOWLEDGE_TOOLS };
