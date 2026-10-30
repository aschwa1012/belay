'use strict';
// handback-rule.test.cjs — belay itself ends a worker's first message with the hand-back rule (and, for a verdict task, the Review
// standard), at a spawn as well as at a task_assign; the orchestrator no longer writes either into its prompts. The rule is one module
// (src/run/handback.cjs) and the standard one file (src/run/prompts/review-standard.md). Pure checks, then a real manager spawn.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HB = require('../../src/run/handback.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const NR = require('../../src/run/note-review.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const PL = require('../../src/run/task-body.cjs').PROCESS_LINE; // the standing process line, after the prompt
const STANDARD = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'prompts', 'review-standard.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
const TREE = { path: 'C:/r.worktrees/t1', branch: 'belay/t1' };
const assigned = (task, lease = 'L1') => ({ task, new_lease: { id: lease } });

test('the rule for a work task names the lease and the result shape; in the task\'s own tree it says to commit first', () => {
  const plain = HB.rule(assigned({ id: 't1', acceptance: { commands: [] } }));
  assert.strictEqual(plain, '\n\nWhen you are finished, call lease_release with lease_id L1 and a result object (branch, head, tests, findings).');
  const tree = HB.rule(assigned({ id: 't1', worktree: TREE }));
  assert.match(tree, /^\n\nWhen you are finished, commit your work in your worktree, then call lease_release with lease_id L1 and a result object \(branch, head, tests, findings\)\.$/);
  assert.ok(!HB.rule(assigned({ id: 't1', worktree: { ...TREE, removed_at: 5 } })).includes('commit your work'), 'a removed tree is no tree');
  assert.ok(!HB.rule(assigned({ id: 't1', worktree: TREE, acceptance: { verdict: true } })).includes('commit your work'), 'a reviewer never commits in the tree it judges');
});

test('the rule for a verdict task has the verdict shape and carries the Review standard, from its one file', () => {
  const r = HB.rule(assigned({ id: 'r1', acceptance: { verdict: true } }, 'L9'));
  assert.ok(r.startsWith('\n\nWhen you are finished, call lease_release with lease_id L9 and result: { "verdict": "holds" | "refuted", "summary": "...", "findings": [...] }.\n\n## Review standard\n'));
  assert.ok(r.endsWith(STANDARD), 'the standard is the file\'s text, verbatim');
  assert.ok(!r.includes('(branch, head, tests, findings)'), 'not the work task\'s shape');
  assert.ok(STANDARD.includes('(a) breaks one of the brief\'s stated acceptance criteria') && STANDARD.includes('(d) causes a hang, data loss, an orphaned process or a security hole'));
});

test('no lease, no rule', () => {
  assert.strictEqual(HB.rule(null), '');
  assert.strictEqual(HB.rule({ task: { id: 't1' } }), '');
  assert.strictEqual(HB.rule({ task: { id: 't1' }, new_lease: null }), '');
});

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-handback-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

// A fake core whose assign answers with this task record, so the spawn sees what the real core's assign answer would carry.
function coreFor(task) {
  const core = createFakeCore({ resumeLineText: 'task t1 lease=lease-1.' });
  const orig = core.task.assign;
  core.task.assign = async (a) => { const out = await orig(a); return a.check_only ? out : { ...out, task: { ...out.task, ...task } }; };
  return core;
}

async function firstMessage(task, spawnArgs = {}) {
  const sb = sandbox();
  const m = createRunManager({ core: coreFor(task), dataDir: sb.data, runId: 'run-hb', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'the brief', worker_id: 'w1', task_id: 't1', ...spawnArgs });
    return m._worker('w1').firstMessage;
  } finally { await m.shutdown(); cleanup(sb.data); }
}

test('a spawn with a task sends its spec after the resume line, then the prompt as added instructions, then the rule; no prompt is fine', async () => {
  const task = { id: 't1', spec: 'rename the frobnicator', acceptance: { commands: [{ argv: ['x'] }] } };
  const RULE = 'When you are finished, call lease_release with lease_id lease-1 and a result object (branch, head, tests, findings).';
  assert.strictEqual(await firstMessage(task), `task t1 lease=lease-1.\n\nTask: rename the frobnicator\n\nthe brief${PL}\n\n${RULE}`);
  assert.strictEqual(await firstMessage(task, { prompt: undefined }), `task t1 lease=lease-1.\n\nTask: rename the frobnicator${PL}\n\n${RULE}`);
  const sb = sandbox();
  const m = createRunManager({ core: createFakeCore(), dataDir: sb.data, runId: 'run-hb', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, worker_id: 'w3' }), /spawn needs a prompt/, 'without a task a prompt is still required');
  } finally { await m.shutdown(); cleanup(sb.data); }
});

test('a spawn ends the first message with the rule: the resume line, the prompt, then the hand-back rule', async () => {
  assert.strictEqual(await firstMessage({ id: 't1', acceptance: { commands: [{ argv: ['x'] }] } }),
    'task t1 lease=lease-1.\n\nthe brief' + PL + '\n\nWhen you are finished, call lease_release with lease_id lease-1 and a result object (branch, head, tests, findings).');
  const own = await firstMessage({ id: 't1', worktree: TREE });
  assert.ok(own.endsWith('When you are finished, commit your work in your worktree, then call lease_release with lease_id lease-1 and a result object (branch, head, tests, findings).'));
});

test('a spawn for a verdict task ends with the verdict rule and the Review standard, so the orchestrator copies neither', async () => {
  const first = await firstMessage({ id: 't1', acceptance: { verdict: true } }, { agent_type: 'reviewer' });
  assert.ok(first.startsWith('task t1 lease=lease-1.\n\nthe brief'));
  assert.ok(first.includes('\n\nWhen you are finished, call lease_release with lease_id lease-1 and result: { "verdict": "holds" | "refuted", "summary": "...", "findings": [...] }.\n\n## Review standard\n'));
  assert.ok(first.endsWith(STANDARD));
  assert.strictEqual(first.split('## Review standard').length - 1, 1, 'once');
});

test('a spawn with no task has no lease and so no rule', async () => {
  const sb = sandbox();
  const m = createRunManager({ core: createFakeCore(), dataDir: sb.data, runId: 'run-hb', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'just this', worker_id: 'w2' });
    assert.strictEqual(m._worker('w2').firstMessage, 'just this' + PL);
  } finally { await m.shutdown(); cleanup(sb.data); }
});

test('the manager\'s reviewTail hands the brief of a task assigned to a live worker to the note review, as the worker\'s own id and that task', async () => {
  const sb = sandbox();
  const m = createRunManager({ core: createFakeCore(), dataDir: sb.data, runId: 'run-hb', memoryLevers: { notes: true }, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const real = NR.reviewTail;
  const seen = [];
  NR.reviewTail = async (ctx, w) => { seen.push({ ctx, id: w.id, taskId: w.taskId }); w.lastError = { where: 'x' }; return '\n\nBRIEF'; };
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'p', worker_id: 'rv1' });
    seen.length = 0; // the spawn itself asked once, for no task
    assert.strictEqual(await m.reviewTail({ worker_id: 'rv1', task_id: 'r2' }), '\n\nBRIEF');
    assert.deepStrictEqual(seen.map((s) => [s.id, s.taskId]), [['rv1', 'r2']], 'the new task, not the one it was spawned for');
    assert.deepStrictEqual(m._worker('rv1').lastError, { where: 'x' }, 'a failure noted on the shim lands on the worker');
    assert.strictEqual(await m.reviewTail({ worker_id: 'nobody', task_id: 'r2' }), '', 'a worker this manager does not hold has no brief');
  } finally { NR.reviewTail = real; await m.shutdown(); cleanup(sb.data); }
});

test('a worker spawned in a run with the permission_prompt lever on is launched with the permission channel; off, or an explicit false, it is not', async () => {
  for (const [lever, arg, want] of [[true, undefined, true], [false, undefined, false], [true, false, false], [false, true, true]]) {
    const sb = sandbox();
    const m = createRunManager({ core: createFakeCore(), dataDir: sb.data, runId: 'run-pp', permissionPrompt: lever, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    try {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'p', worker_id: 'pp1', ...(arg === undefined ? {} : { permission_prompt: arg }) });
      const w = m._worker('pp1');
      assert.strictEqual(w.permissionPrompt, want, `lever ${lever}, argument ${arg}`);
      const mcp = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'pp1', 'mcp.json'), 'utf8'));
      assert.strictEqual(mcp.mcpServers.belay.args.includes('--permit'), want, 'the worker adapter is launched with --permit exactly then');
    } finally { await m.shutdown(); cleanup(sb.data); }
  }
});

test('a task that declares required hand-back fields says so in the rule, at a spawn and from the rule alone; none declared, no line', async () => {
  const acceptance = { handoff: { required: ['head', 'tests', 'summary'] } };
  const line = ' The result must carry head, tests, summary, each non-empty; lease_release refuses it otherwise.';
  assert.ok(HB.rule(assigned({ id: 't1', acceptance })).endsWith(`(branch, head, tests, findings).${line}`));
  assert.ok(HB.rule(assigned({ id: 'r1', acceptance: { verdict: true, handoff: { required: ['head', 'tests', 'summary'] } } })).includes(`"findings": [...] }.${line}\n\n## Review standard`));
  assert.ok(!HB.rule(assigned({ id: 't1', acceptance: { commands: [] } })).includes('must carry'));
  assert.ok((await firstMessage({ id: 't1', acceptance })).endsWith(line), 'the spawn\'s first message carries it');
});
