'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// orchestrator-policy-inform.test.cjs — the orchestrator is told that the policy manager exists, what it does and what it saves
// (fewer routine wakes, a leaner context on big runs), in both shipped prompts and in task_create's `policy` description. The
// operator chose directive wording for this run: on a run of more than a few tasks, both texts tell it to state its plan as policy
// fields and to handle a step itself only for a stated reason. The plan values the prompt names are the ones the core accepts.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');
const HEADING = "## Plans: belay's policy manager";
// Plan-first (ADR 0037 amendment 8): plan the work, then go hands off; the run's plan is rendered in at launch ({{run_plan}}).
const { PLAN_FIRST, NO_PLAN } = require(path.join(ROOT, 'src/cli/run-levers.cjs')); // the directive, rendered only for a run with a plan
const DONE = 'belay wakes you once when the implementation is done: every task of the run done, every planned task reviewed and merged, and the merged head\'s checks passed.';
const REVIEW_CLAUSE = 'When a work task carries a plan, belay runs the steps it names in this cycle for you (see Plans below); take a step by hand for a task or step without one, when belay wakes you with an exception on it, or for a stated reason.';
const sectionOf = (text) => { const i = text.indexOf(`${HEADING}\n`); if (i < 0) return null; const j = text.indexOf('\n## ', i + 1); return text.slice(i, j < 0 ? text.length : j); };

test('both prompts carry the policy manager section: what it does, what wakes the orchestrator, and why it helps', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const s = sectionOf(read(f));
    assert.ok(s, `${f}: has the section`);
    assert.match(s, /`mcp__belay__task_create` takes a `policy`/, `${f}: names the field`);
    assert.match(s, /does not wake you/, `${f}: routine steps do not wake it`);
    assert.match(s, /digest/, `${f}: the digest`);
    assert.match(s, /wakes you on an exception/, `${f}: exceptions wake it`);
    // E1 to E3 and E5 to E8 halt a task; a death (E4) halts nothing, a budget pause (E9) pauses the run.
    assert.match(s, /An exception about a task halts belay's steps on it until you act on it or amend its plan; a death halts nothing, and a budget pause pauses the whole run\./, `${f}: the halt`);
    assert.match(s, /so a plan keeps your context lean/, `${f}: the context benefit`);
    assert.ok(!s.includes('Plan the work first'), `${f}: the directive is not in the template: it is rendered with the run's plan`);
    assert.ok(flat(s).includes(DONE), `${f}: the done wake`);
    assert.ok(s.includes('{{run_plan}}'), `${f}: the run's plan is rendered in at launch`);
    assert.ok(!/more than a few tasks/.test(s), `${f}: no task-count threshold`);
    const review = read(f).split('## Review tasks')[1] || '';
    assert.ok(flat(review).startsWith(` ${REVIEW_CLAUSE}`), `${f}: Review tasks opens by pointing to the plan`);
    assert.ok(!s.includes('Whether to plan a task, and how much, is yours'), `${f}: the informative wording it replaced is gone`);
  }
});

test('the plan values the section names are the ones the core accepts', () => {
  const { V1_ACCEPTS, AGENT_TYPES } = require(path.join(ROOT, 'src/core/policy-plan.cjs'));
  const s = sectionOf(read('orchestrator.md'));
  for (const k of ['fix', 're_review', 'integrate']) assert.ok(s.includes(`\`${k}: "${V1_ACCEPTS[k][0]}"\``), k);
  assert.match(s, /`build: \{ spawn: \{ agent_type: "coder" \} \}`/);
  assert.match(s, /`build: \{ worker: "<id>" \}`/);
  assert.ok(AGENT_TYPES.includes('coder'));
  assert.ok(AGENT_TYPES.includes('reviewer'), 'the spawn the section shows names an agent type the core accepts');
  assert.match(s, /`review: \{ worker: "<id>" \}`/);
  assert.match(s, /`review: \{ spawn: \{ agent_type: "reviewer" \} \}`/);
});

test('headless only: the prompt says which steps keep the run open, with the bound', () => {
  // True with the idle close's policy hold (src/run/policy-close-hold.cjs); without it the run could close before a due step was taken.
  const h = flat(read('orchestrator.md'));
  assert.ok(h.includes('A step belay has started, or one due for under 30 s while belay takes no other, keeps the run open after you end your turn.'));
  assert.ok(!flat(read('orchestrator-interactive.md')).includes('keeps the run open'), 'an interactive run does not close on an idle turn');
});

test('task_create\'s policy description says what wakes the orchestrator and that the run\'s plan names every step', () => {
  const d = require(path.join(ROOT, 'src/mcp/tools-policy.cjs')).POLICY_PROPERTY.description;
  assert.match(d, /do not wake you/);
  assert.match(d, /exceptions, escalations and the done wake do, with a digest/);
  assert.match(d, /The run plan names build, review, fix, re_review and integrate; set a field here only to change it for this task$/);
});

test('the run plan line names the run\'s plan, or says there is none', () => {
  const { runPlanLine, substituteLevers, parseLevers } = require(path.join(ROOT, 'src/cli/run-levers.cjs'));
  const on = parseLevers({});
  assert.ok(runPlanLine(on).startsWith('This run\'s plan, which every work task you create takes unless you give it a `policy` of its own or `policy: null`, is `{"build":'), runPlanLine(on));
  assert.strictEqual(runPlanLine(parseLevers({ policy: null })), NO_PLAN);
  assert.ok(runPlanLine(on).endsWith(PLAN_FIRST), 'a run with a plan is told to plan first and go hands off');
  assert.ok(!runPlanLine(parseLevers({ policy: null })).includes('Plan the work first'), 'a run with no plan keeps the flow where the orchestrator takes each step');
  assert.match(PLAN_FIRST, /a dependent one with its `depends_on` and no tree \(belay cuts its tree from `belay\/integrate\/<run>` once its dependencies are merged/);
  assert.match(PLAN_FIRST, /If a builder dies, belay does not start another/);
  assert.match(PLAN_FIRST, /act on an exception or an escalation/);
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = substituteLevers(read(f), on, 0, { mode: f === 'orchestrator.md' ? 'headless' : 'interactive' }).text;
    assert.ok(!text.includes('{{run_plan}}') && text.includes(runPlanLine(on)), `${f}: substituted`);
  }
});
