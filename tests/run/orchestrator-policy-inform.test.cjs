'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// orchestrator-policy-inform.test.cjs — the orchestrator is told that the policy manager exists, what it does and what it saves
// (fewer routine wakes, a leaner context on big runs), in both shipped prompts and in task_create's `policy` description. It is
// told, not ordered: neither text carries a mandate word. The plan values the prompt names are the ones the core accepts.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
const HEADING = "## Plans: belay's policy manager";
const MANDATE = /\b(must|always|never|required|mandatory)\b/i;
const sectionOf = (text) => { const i = text.indexOf(`${HEADING}\n`); if (i < 0) return null; const j = text.indexOf('\n## ', i + 1); return text.slice(i, j < 0 ? text.length : j); };

test('both prompts carry the policy manager section: what it does, what wakes the orchestrator, and why it helps', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const s = sectionOf(read(f));
    assert.ok(s, `${f}: has the section`);
    assert.match(s, /`mcp__belay__task_create` takes a `policy`/, `${f}: names the field`);
    assert.match(s, /does not wake you/, `${f}: routine steps do not wake it`);
    assert.match(s, /digest/, `${f}: the digest`);
    assert.match(s, /wakes you on an exception/, `${f}: exceptions wake it`);
    assert.match(s, /halts belay's steps on that task until you act on it or amend its plan/, `${f}: the halt`);
    assert.match(s, /fewer of those turns and a context that grows more slowly/, `${f}: the context benefit`);
    assert.match(s, /Whether to plan a task, and how much, is yours/, `${f}: the choice is the orchestrator's`);
    assert.doesNotMatch(s, MANDATE, `${f}: informs, never mandates`);
  }
});

test('the plan values the section names are the ones the core accepts', () => {
  const { V1_ACCEPTS, AGENT_TYPES } = require(path.join(ROOT, 'src/core/policy-plan.cjs'));
  const s = sectionOf(read('orchestrator.md'));
  for (const k of ['fix', 're_review', 'integrate']) assert.ok(s.includes(`\`${k}: "${V1_ACCEPTS[k][0]}"\``), k);
  const plan = require(path.join(ROOT, 'src/core/policy-plan.cjs')).check({ review: { spawn: { agent_type: 'reviewer' } }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' });
  assert.ok(plan.review.spawn && AGENT_TYPES.includes('reviewer'));
  assert.match(s, /`review: \{ worker: "<id>" \}`/);
  assert.match(s, /`review: \{ spawn: \{ agent_type: "reviewer" \} \}`/);
});

test('task_create\'s policy description says what a plan saves, and orders nothing', () => {
  const d = require(path.join(ROOT, 'src/mcp/tools-policy.cjs')).POLICY_PROPERTY.description;
  assert.match(d, /do not wake you/);
  assert.match(d, /exceptions do/);
  assert.match(d, /digest/);
  assert.match(d, /leaner context on big runs/);
  assert.doesNotMatch(d, MANDATE);
});
