'use strict';
// policy-plan.cjs — a task's policy: the plan the orchestrator or the user wrote for what belay does for that task (ADR 0071). It is data on
// the task row. This file checks it, resolves a task's own plan over the user's defaults field by field, and shows it as a short tag. It
// acts on nothing: the run's executor reads the stored plan (ADR 0072).
//
// V1_ACCEPTS is the seam for the values 0.4.0 takes (ADR 0071 question 2 is open). Anything else, a field or a value, is refused with E_ARGS
// "not accepted in 0.4.0", so a wider plan needs this table to change and nothing else to be unlearned.

const { err } = require('./errors.cjs');
const { isPathId, pathIdMessage } = require('./path-id.cjs');
const { isReservedWorkerId } = require('./reserved-ids.cjs');

// The worker agent types a spawn may name. Kept here because the core imports nothing from src/run; a test pins it to agent-defaults.cjs WORKER_TYPES.
const AGENT_TYPES = ['coder', 'tester', 'reviewer', 'researcher'];

// field -> the one value (or shape) v1 accepts. `review` is a shape; the rest are a single word.
const V1_ACCEPTS = Object.freeze({
  build: 'a worker id ({ worker }) or a spawn ({ spawn: { agent_type, worker_id? } }): who builds an open task once its dependencies are done',
  review: 'a worker id ({ worker }) or a spawn ({ spawn: { agent_type, worker_id? } })',
  fix: Object.freeze(['builder']),
  re_review: Object.freeze(['refuter']),
  integrate: Object.freeze(['on_hold']),
  follow_up: Object.freeze(['plan']), // a held review's should-fix findings become a follow-up task the plan builds, reviews and merges (ADR 0064), not a wake
});

const notAccepted = (path, value, accepted) => err('E_ARGS', `${path}${value === undefined ? '' : `: ${value}`} is not accepted in 0.4.0${accepted ? ` (accepted: ${accepted})` : ''}`, { field: path });

function checkReview(v, where) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err('E_ARGS', `${where} must be an object: { worker: <id> } or { spawn: { agent_type, worker_id? } }`, { field: where });
  const keys = Object.keys(v);
  if (keys.length !== 1) throw err('E_ARGS', `${where} names exactly one of worker or spawn`, { field: where });
  const [k] = keys;
  if (k === 'worker') {
    if (!isPathId(v.worker)) throw err('E_ARGS', `${where}.worker: ${pathIdMessage('worker', v.worker)}`, { field: `${where}.worker` });
    return { worker: v.worker };
  }
  if (k !== 'spawn') throw notAccepted(`${where}.${k}`, undefined, 'worker, spawn');
  const s = v.spawn;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw err('E_ARGS', `${where}.spawn must be an object with agent_type`, { field: `${where}.spawn` });
  for (const sk of Object.keys(s)) if (sk !== 'agent_type' && sk !== 'worker_id') throw notAccepted(`${where}.spawn.${sk}`, undefined, 'agent_type, worker_id');
  if (!AGENT_TYPES.includes(s.agent_type)) throw err('E_ARGS', `${where}.spawn.agent_type must be one of ${AGENT_TYPES.join(', ')}`, { field: `${where}.spawn.agent_type` });
  if (s.worker_id !== undefined && !isPathId(s.worker_id)) throw err('E_ARGS', `${where}.spawn.worker_id: ${pathIdMessage('worker_id', s.worker_id)}`, { field: `${where}.spawn.worker_id` });
  if (s.worker_id !== undefined && isReservedWorkerId(s.worker_id)) throw err('E_ARGS', `${where}.spawn.worker_id: ids starting knowledge-, notereview-, scrub- or archreview- are reserved for belay's own workers`, { field: `${where}.spawn.worker_id`, reason: 'reserved' });
  return { spawn: { agent_type: s.agent_type, ...(s.worker_id !== undefined ? { worker_id: s.worker_id } : {}) } };
}

// The plan as stated: an object whose fields are in V1_ACCEPTS with accepted values. Returns a fresh normalised object; throws E_ARGS and writes
// nothing. A null field is refused (`policy: null` is the whole-plan hand-back); an empty object is a valid plan that says nothing.
// `where` names the source in the message (`policy`, `spec policy`, or the config path).
function check(policy, where = 'policy') {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw err('E_ARGS', `${where} must be an object of what belay does for the task (build, review, fix, re_review, integrate, follow_up)`, { field: where });
  const out = {};
  for (const k of Object.keys(policy)) {
    const v = policy[k];
    if (!Object.prototype.hasOwnProperty.call(V1_ACCEPTS, k)) throw notAccepted(`${where}.${k}`, undefined, Object.keys(V1_ACCEPTS).join(', '));
    if (v === null || v === undefined) throw err('E_ARGS', `${where}.${k} cannot be null: leave a field out to leave its step to the orchestrator, or pass policy: null on an amend to hand the whole task back`, { field: `${where}.${k}` });
    if (k === 'review' || k === 'build') { out[k] = checkReview(v, `${where}.${k}`); continue; } // the same shape: a named worker or a spawn
    if (!V1_ACCEPTS[k].includes(v)) throw notAccepted(`${where}.${k}`, JSON.stringify(v), V1_ACCEPTS[k].map((x) => JSON.stringify(x)).join(', '));
    out[k] = v;
  }
  return out;
}

// A task's own plan over the user's default, field by field (ADR 0071 decision 3): the task's field wins, the default fills what the task's
// plan leaves unsaid. A field is a whole value (a stated review replaces the default review). null when nothing is left.
function resolve(own, defaults) {
  const out = { ...(defaults || {}), ...(own || {}) };
  return Object.keys(out).length ? out : null;
}

// The run's default as run.attach stores it: JSON text. A bad stored value reads as no default rather than failing a create.
function parseDefault(text) {
  if (text == null) return null;
  try { const v = typeof text === 'string' ? JSON.parse(text) : text; return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

// Tasks whose work is itself a step of another task's plan do not take the run default: a fix task (repairs), a follow-up and a review
// task (acceptance.verdict) would otherwise be planned as work units of their own. A plan stated on them is still kept.
const takesDefault = (t) => !(t && (t.repairs || t.follows_up || (t.acceptance && t.acceptance.verdict === true)));

// What task.create writes for the policy columns: { policy, policy_rev }. `args.policy` undefined takes the run default (when the task takes one),
// null is "no plan" and takes none. The stored plan is the resolved one, so each step reads the same plan for the task's life.
function forCreate(runRow, args, task) {
  if (args.policy === null) return { policy: null, policy_rev: null };
  const own = args.policy === undefined ? null : check(args.policy);
  const defaults = takesDefault(task) && runRow ? parseDefault(runRow.policy_default) : null;
  const policy = resolve(own, defaults);
  return { policy, policy_rev: policy ? 1 : null };
}

// task.create { amend: true, policy }: the stated plan replaces the task's own and is resolved over the default again; null hands the task back.
// Every amend is a new revision, so a step reads which plan it acted under.
function forAmend(runRow, task, statedPolicy) {
  const rev = (Number(task.policy_rev) || 0) + 1;
  if (statedPolicy === null) return { policy: null, policy_rev: rev };
  const defaults = takesDefault(task) && runRow ? parseDefault(runRow.policy_default) : null;
  return { policy: resolve(check(statedPolicy), defaults), policy_rev: rev };
}

// The compact tag a listing shows: `r:w1 rr:refuter f:builder i:on_hold`. A spawn reads `r:spawn(coder)`.
function tag(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const parts = [];
  const who = (x) => (x.worker !== undefined ? x.worker : `spawn(${x.spawn.agent_type})`);
  if (policy.build) parts.push(`b:${who(policy.build)}`);
  if (policy.review) parts.push(`r:${who(policy.review)}`);
  if (policy.fix) parts.push(`f:${policy.fix}`);
  if (policy.re_review) parts.push(`rr:${policy.re_review}`);
  if (policy.integrate) parts.push(`i:${policy.integrate}`);
  if (policy.follow_up) parts.push(`fu:${policy.follow_up}`);
  return parts.join(' ') || null;
}

module.exports = { V1_ACCEPTS, AGENT_TYPES, check, resolve, parseDefault, takesDefault, forCreate, forAmend, tag };
