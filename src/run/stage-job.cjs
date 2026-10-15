'use strict';
// stage-job.cjs — what the run-close stages (the scrubber and the archive reviewer) share: one read-only child worker, spawned by
// the run manager (invariant 1) with Read, Glob and Grep, its answer read from its last message and its recorded cost checked against
// the cap. The child is stopped by the manager in a `finally` (by its exact pid, ADR 0039). Nothing here writes the store but the
// receipts it is asked to; applying an answer is the core's (memory.scrubApply, memory.reviewApply).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BUILTINS = ['Read', 'Glob', 'Grep'];
const DIFF_MAX = 200 * 1024;
const FILE_CUT = 16 * 1024;
const GIT_BOUND_MS = 15000;
const fwd = (p) => String(p).replace(/\\/g, '/');
const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const coded = (code, message) => Object.assign(new Error(message), { code });

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'prompts', name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}
const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(String(v)), tpl);

// The child's answer: the JSON object in its last message, and the list under `key`. { list } or { error }.
function parseList(text, key) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'the job ended its turn with no text' };
  const tries = [raw];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) tries.push(fence[1]);
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(raw.slice(a, b + 1));
  for (const t of tries) {
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (j && Array.isArray(j[key])) return { list: j[key] };
  }
  return { error: `the job's final message holds no ${key} JSON` };
}

// The recorded cost is the binding check: a job that recorded none, or more than its cap, is not used.
function costError(cost, cap, what) {
  if (!(typeof cost === 'number' && cost > 0)) return coded('E_COST_CAP', `the ${what} recorded no cost, so its cap cannot be checked; its answer was not used`);
  if (cost > cap) return coded('E_COST_CAP', `the ${what} cost $${cost.toFixed(4)}, over its cap of $${cap}; its answer was not used`);
  return null;
}

// Spawn the child, wait for its turn, read its last text and cost, stop it. Resolves to { text, cost, error } and throws only for a
// spawn that never produced a worker. `manager` is a run manager (or a test double with spawn, wait, stop and _worker).
async function runChild({ manager, workerId, worktree, model, capUsd, wallMs, prompt, label }) {
  if (!manager || typeof manager.spawn !== 'function') throw coded('E_INTERNAL', `the run has no manager to spawn the ${label} with`);
  if (typeof manager._closed === 'function' && manager._closed()) throw coded('E_SHUTDOWN', `the run manager is shutting down, so the ${label} was not started`);
  await manager.spawn({ substrate: 'claude-code', worktree, worker_id: workerId, model, allowed_tools: BUILTINS, tools: BUILTINS, max_budget_usd: capUsd, prompt });
  let text = '', cost = null, error = null;
  try {
    const got = await manager.wait({ worker_ids: [workerId], timeout_ms: wallMs });
    const rec = manager._worker(workerId);
    if (got.timed_out) error = coded('E_TIMEOUT', `the ${label} did not finish inside ${Math.round(wallMs / 1000)} s`);
    else if (got.event !== 'turn_end' || got.is_error) error = coded('E_WORKER_NOT_LIVE', `the ${label} ${got.event === 'turn_end' ? 'ended its turn in error' : `is ${got.event}`}`);
    text = rec && typeof rec.lastAssistantText === 'string' ? rec.lastAssistantText : '';
    cost = rec && typeof rec.costUsd === 'number' ? rec.costUsd : null;
  } finally { await Promise.resolve(manager.stop({ worker_id: workerId })).catch(() => {}); }
  return { text, cost, error };
}

function git(worktree, args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_BOUND_MS, windowsHide: true, encoding: 'utf8', ...opts }, (e, out) => resolve(e ? { error: e.killed ? 'git timed out' : 'git failed' } : { text: out }));
  });
}
async function diffText(worktree, base, head) {
  const d = await git(worktree, ['diff', '--no-color', base, head]);
  if (d.error) return `(${d.error} for ${String(base).slice(0, 12)}..${String(head).slice(0, 12)})\n`;
  return d.text.length > DIFF_MAX ? `${d.text.slice(0, DIFF_MAX)}\n(diff cut at ${DIFF_MAX} bytes)\n` : d.text || '(no change)\n';
}
// A file as it was at a commit, cut; or a sentence saying why it could not be read.
async function fileAt(worktree, sha, rel) {
  const r = await git(worktree, ['show', `${sha}:${rel}`]);
  if (r.error) return `(${rel} could not be read at ${String(sha).slice(0, 12)}: ${r.error})\n`;
  return r.text.length > FILE_CUT ? `${r.text.slice(0, FILE_CUT)}\n(file cut at ${FILE_CUT} bytes)\n` : r.text;
}

function writeFileIn(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fwd(path.join(dir, name));
  fs.writeFileSync(file, text);
  return file;
}

// A receipt row; never throws.
async function receipt(core, fields) {
  try { return await core.memory.recordEvent(fields); } catch { return null; }
}
const failFields = (e) => ({ ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) });

module.exports = { BUILTINS, runChild, parseList, costError, readTemplate, fill, diffText, fileAt, writeFileIn, receipt, failFields, fwd, codeOf, coded, git };
