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
// A question that timed out leaves the agent mid-turn on it. The next question first waits that turn out and drops
// its answer (it answers the earlier question, not this one), or, if the turn still has not ended, is refused
// E_BUSY: a message sent mid-turn would make `wait` return the earlier turn's end and its text. An agent whose
// process has ended (dead, stopped, or held by an earlier adapter of this run) is relaunched with `restart`, and an
// agent in a new session (a replace relaunch, by anyone) is told to read the corpus again.
//
// Tool surface (ADR 0024, ADR 0043 decision 1): the built-in tools are narrowed to Read, Glob and Grep on every
// launch (`--tools`), and the surface check holds the launch to that list, so the agent cannot edit or run anything.
//
// `ctx` is { core, runId, dataDir, worktree, levers? | memoryLevers? }: the run's core handle, its id and data dir,
// the run's worktree (the agent's cwd; a run manager has it from its adapter's `--worktree`) and, for a caller that
// already holds them, the memory levers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('./launch.cjs');
const { writeAtomic } = require('./bottle.cjs');
const { fail } = require('./errors.cjs');

// ADR 0021 decision 1 as amended: researchers and reviewers run on Opus. The agent only reads.
const KNOWLEDGE_MODEL = 'claude-opus-5-5';
// Pre-approved (--allowedTools): the built-ins and only the memory read tools. Its adapter lists nothing else for a
// knowledge-<run> worker (src/mcp/tools.cjs KNOWLEDGE_READ_TOOLS), so the agent cannot write or delete a row.
const KNOWLEDGE_TOOLS = ['Read', 'Glob', 'Grep', ...['memory_retrieve', 'memory_search', 'memory_timeline', 'memory_list', 'memory_stats'].map((t) => `mcp__belay__${t}`)];
const KNOWLEDGE_BUILTINS = ['Read', 'Glob', 'Grep']; // the only built-ins the agent has (--tools)
const QUESTION_MAX_BYTES = 4096;
const GET_MANY_MAX = 50;
const CITE_RE = /\[mem:([^\]\s]+)\]/g;
const SUBSTANTIVE_MIN = 30; // a line shorter than this is a label or a connective, not a claim

const PROMPT_FILE = path.join(__dirname, 'prompts', 'knowledge.md');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const workerIdFor = (runId) => `knowledge-${runId}`;

// The record under the agent's id must be the read-only agent this module launched: its built-in tools exactly
// Read, Glob and Grep. A record with any other surface (an id taken before the prefix was reserved, or a relaunch
// that lost the narrowed list) is refused rather than handed the corpus and a question.
function checkTools(rec, id) {
  if (!rec) return;
  const got = Array.isArray(rec.tools) ? [...rec.tools].sort() : null;
  if (JSON.stringify(got) !== JSON.stringify([...KNOWLEDGE_BUILTINS].sort())) {
    fail('E_SUBSTRATE', `worker ${id} is not the read-only knowledge agent: its built-in tools are ${got ? got.join(', ') : 'the full list'}, not ${KNOWLEDGE_BUILTINS.join(', ')}`, { worker_id: id, tools: got });
  }
}

const states = new WeakMap(); // manager -> { sha, chain }
function stateOf(manager) {
  let s = states.get(manager);
  if (!s) { s = { sha: null, session: null, chain: Promise.resolve() }; states.set(manager, s); }
  return s;
}

// Where the agent stands before a question: 'none' (never spawned in this run), 'live' (this manager's, its process
// running) or 'ended' (a record whose process has ended, or a row an earlier adapter of this run left).
async function standing(manager, core, id) {
  const rec = manager._worker && manager._worker(id);
  if (rec) return rec.settled ? 'ended' : 'live';
  if (!core.worker || typeof core.worker.get !== 'function') return 'none';
  try { await core.worker.get({ worker_id: id }); return 'ended'; } catch (e) {
    if (e && e.code === 'E_NOT_FOUND') return 'none';
    throw e;
  }
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
  const levers = ctx.levers || ctx.memoryLevers || await require('./memory-levers.cjs').leversFor(core, runId);
  if (!levers.knowledge_agent) {
    fail('E_LEVER_OFF', 'the knowledge agent is off for this run; set memory.knowledge_agent to true in the run spec', { lever: 'knowledge_agent' });
  }
  if (!ctx.dataDir) fail('E_ARGS', 'ask needs the run\'s data dir in its context');
  if (!ctx.worktree) fail('E_ARGS', 'ask needs the run\'s worktree, the knowledge agent\'s cwd (ADR 0043 decision 1); this adapter was started without --worktree');
  const deadline = t0 + Math.max(1, Number(timeout_ms) || 110000);
  const left = () => Math.max(1, deadline - Date.now());

  const id = workerIdFor(runId);
  let stand;
  let earlierDropped = false;
  let relaunch = null;
  try {
    stand = await standing(manager, core, id);
    const held = manager._worker(id);
    if (held) checkTools(held, id);
    // A row an earlier adapter left is relaunched with the tool list its row records (ADR 0024 amendment 4); only a row written before that column falls back to argv.json.
    else if (stand === 'ended') {
      const row = await core.worker.get({ worker_id: id });
      checkTools({ tools: Array.isArray(row.tools) ? require('./surface.cjs').narrowTools(row.tools) : require('./lifecycle.cjs').readLaunchOptions(L.workerDir(ctx.dataDir, id)).tools }, id);
    }
    if (stand === 'live' && manager._worker(id).turnEnded === false) {
      // Mid-turn on an earlier question that timed out: wait that turn out; its answer is not this question's.
      const prior = await manager.wait({ worker_ids: [id], timeout_ms: left() });
      if (prior.timed_out) fail('E_BUSY', 'the knowledge agent is still answering an earlier question; ask again later', { worker_id: id, waited_ms: prior.waited_ms });
      earlierDropped = prior.event === 'turn_end';
      if (prior.event !== 'turn_end') stand = 'ended';
    }
    if (stand === 'ended') {
      relaunch = await manager.restart({ worker_id: id, first_turn_timeout_ms: left() });
      checkTools(manager._worker(id), id); // a row an earlier adapter left: its tool list comes from its row
      if (relaunch.first_turn_timed_out) fail('E_BUSY', 'the relaunched knowledge agent has not finished its first turn; ask again later', { worker_id: id, branch: relaunch.branch });
    }
  } catch (e) {
    await noteFailure(core, id, question, e);
    throw e;
  }
  const rec0 = manager._worker(id);
  // A session other than the one that read the corpus (a replace relaunch, ours or anyone's) has not read it.
  const newSession = !!rec0 && ((relaunch && relaunch.branch === 'replace') || (state.session != null && rec0.sessionId != null && rec0.sessionId !== state.session));
  const corpus = await core.memory.corpus(levers.project ? { project: levers.project } : {});
  const corpusPath = `${L.fwd(L.workerDir(ctx.dataDir, id))}/corpus.md`;
  const known = stand === 'none' || newSession ? null : (state.sha || await lastPrimedSha(core, runId, id));
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
    if (stand === 'none') {
      const intro = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      await manager.spawn({
        substrate: 'claude-code', worktree: ctx.worktree, worker_id: id,
        model: KNOWLEDGE_MODEL, allowed_tools: KNOWLEDGE_TOOLS, tools: KNOWLEDGE_BUILTINS,
        prompt: `${intro}\n\nThe corpus is in ${corpusPath}. Read it now.\n\nQuestion:\n${question}`,
      });
    } else {
      const lead = changed ? `The corpus changed. Read ${corpusPath} again in full before you answer.\n\n` : '';
      await manager.message({ worker_id: id, text: `${lead}Question:\n${question}` });
    }
    state.sha = corpus.sha256;
    const w = await manager.wait({ worker_ids: [id], timeout_ms: left() });
    if (w.timed_out) fail('E_TIMEOUT', `the knowledge agent did not finish its turn inside ${w.waited_ms} ms; ask again to collect it`, { worker_id: id, waited_ms: w.waited_ms });
    if (w.event !== 'turn_end' || w.is_error) {
      fail(w.event === 'turn_end' ? 'E_SUBSTRATE' : 'E_WORKER_NOT_LIVE',
        `the knowledge agent ${w.event === 'turn_end' ? 'ended its turn in error' : `is ${w.event}`}`, { worker_id: id, event: w.event, established_by: w.established_by });
    }
    turn = w.turn;
    const rec = manager._worker(id);
    state.session = (rec && rec.sessionId) || state.session;
    const answer = rec && typeof rec.lastAssistantText === 'string' ? rec.lastAssistantText.trim() : '';
    if (!answer) fail('E_SUBSTRATE', 'the knowledge agent ended its turn with no text', { worker_id: id, turn });
    const cited = await lookUp(core, citedIds(answer));
    await core.memory.recordEvent({
      kind: 'knowledge_ask', worker_id: id, bytes: Buffer.byteLength(answer, 'utf8'), sha256: sha256(question),
      row_ids: cited.map((c) => c.id), ok: true,
    });
    return {
      answer, cited, uncited_claims: hasUncitedClaims(answer), worker_id: id, turn, waited_ms: Date.now() - t0,
      ...(earlierDropped ? { earlier_answer_dropped: true } : {}), ...(relaunch ? { relaunched: relaunch.branch } : {}),
    };
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

module.exports = { ask, workerIdFor, citedIds, hasUncitedClaims, KNOWLEDGE_MODEL, KNOWLEDGE_TOOLS, KNOWLEDGE_BUILTINS };
