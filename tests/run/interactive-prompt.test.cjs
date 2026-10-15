'use strict';
// ADR 0037 decision 4: the interactive twin is orchestrator.md with only its headless sentences replaced.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
const HEADLESS = read('orchestrator.md');
const TWIN = read('orchestrator-interactive.md');
const H = HEADLESS.split('\n');
const T = TWIN.split('\n');
const MARKER = '<!-- belay-mode: interactive -->';
const flat = (s) => s.replace(/\s+/g, ' ');

// The headless-only sentences the twin replaces (orchestrator.md lines 47-48, 53-63, 102-104).
const REPLACED = [
  'The run ends when you end a turn while no worker is mid-turn.',
  'A live worker that is idle does not keep it open.',
  'Or end your turn; belay wakes you with a message when a worker\'s turn ends or a worker dies.',
  'That wake exists only when belay started you with `belay run`, and only while some worker is mid-turn.',
  'Do not poll in a loop.',
  'and ending your turn closes the run.',
  'is not mid-turn, and the run closes.',
  'To stop on purpose, store the outcome in memory, say why, then end a turn with no worker mid-turn.',
  'and when you end the run (the outcome',
  // amendment 6: the headless waiting rules
  'a timeout is a result: call it again',
  'Never end a turn just after `task_assign`',
];
// The same sentences as the default fix_cutoff substitution carries them (run-levers.cjs cutoffRule).
const REPLACED_IN_RULE = [
  'end the run and name the open blocking findings for the human',
  'Name the condition and its evidence when you close.',
];

test('interactive prompt: carries the marker, and the headless template does not', () => {
  assert.ok(T.slice(0, 5).includes(MARKER), 'marker near the top of the twin');
  assert.ok(!HEADLESS.includes('belay-mode'), 'the headless template has no marker');
});

test('interactive prompt: each replaced headless sentence is in orchestrator.md and absent from the twin', () => {
  for (const s of REPLACED) {
    assert.ok(flat(HEADLESS).includes(flat(s)), `headless template has: ${s}`);
    assert.ok(!flat(TWIN).includes(flat(s)), `twin still has: ${s}`);
  }
});

test('interactive prompt: says what the mode is', () => {
  assert.match(TWIN, /operator is present in this session/);
  assert.match(TWIN, /belay wakes you with a short message when a worker's turn ends or a worker dies\. While workers are working, end your turn: the wake brings you back and names the worker\. Do not hold a turn open to wait\./);
  assert.ok(!/There are no wakes/.test(TWIN), 'the no-wakes claim is gone');
  assert.match(flat(TWIN), /paused for an embedder failure, stop and ask the operator which of the three they want: `keyword`, `off`, or stay paused\. Then give them the exact `belay resume` command/);
  assert.match(TWIN, /Ending a turn does not end the run/);
  assert.match(TWIN, /the run ends when the operator quits the session/);
  // ADR 0037 amendment 6: the wake is how the orchestrator waits; worker_wait is a short check, never a loop
  // (wait-loop probe: the old "re-call it" text held a turn 165 s in two waits, the new text none).
  assert.ok(!/Re-call it/.test(TWIN), 'no instruction to re-call worker_wait');
  assert.ok(!/wait on its id/.test(TWIN), 'no "wait on its id"');
  assert.match(TWIN, /`timeout_ms: 5000`[^]*Never call it in a loop\./);
  const iWait = T.indexOf('- After you start work (a spawn with a prompt, or a `worker_message`), end your turn, naming the');
  assert.deepStrictEqual(T.slice(iWait, iWait + 10), [
    '- After you start work (a spawn with a prompt, or a `worker_message`), end your turn, naming the',
    '  workers you are waiting for so the operator can see it. When a wake names a worker, read its',
    '  hand-back with `mcp__belay__task_list` or check its work with `task_evaluate`. Use',
    '  `mcp__belay__worker_wait` only as a check when no wake came for a worker you expected: pass',
    '  `worker_ids` and `timeout_ms: 5000`. A timeout means the worker is still working: end your turn',
    '  again, although the tool\'s description says to call it again. Never call it in a loop.',
    '  `already: true` means that worker\'s turn ended before your call, not that the work is done.',
    '- A worker whose turn has ended without what you waited for is idle, not working. Instead call',
    '  `mcp__belay__worker_message` to tell it what is missing: that starts a turn. Then end your turn.',
    '- `task_assign` alone starts nothing and no wake follows it: send the `worker_message` above first.',
  ], 'the waiting bullets, pinned line for line');
  assert.match(TWIN, /`namespace: "project"`, tell the operator the result and any open blocking findings, and then wait for them/);
  // the no-wakes wording is one self-contained paragraph a later amendment can swap
  const para = TWIN.split(/\n\n/).find((p) => p.startsWith('belay wakes you'));
  assert.ok(para && !para.includes('\n'), 'the wakes paragraph is a single line between blank lines');
});

test('interactive prompt: both lever placeholders are present and substituteLevers fills them', () => {
  const { substituteLevers, parseLevers } = require(path.join(ROOT, 'src/cli/run-levers.cjs'));
  assert.ok(TWIN.includes('{{fix_cutoff_rule}}'));
  assert.strictEqual(TWIN.split('{{max_fix_rounds}}').length - 1, 2, 'max_fix_rounds appears twice, as in the headless template');
  const levers = parseLevers({ max_fix_rounds: 3 });
  assert.ok(!levers.error, 'levers parse');
  const r = substituteLevers(TWIN, levers, 0);
  assert.strictEqual(r.substituted.max_fix_rounds, 2);
  assert.strictEqual(r.substituted.fix_cutoff_rule, 1);
  assert.ok(!/\{\{[a-z_]+\}\}/.test(r.text), 'no placeholder left');
  assert.match(r.text, /refuted after 3\s+fix rounds/);
});

test('interactive prompt: apart from three named ranges the twin equals orchestrator.md line for line', () => {
  // Allowed differences: (1) the blank line and marker after the title; (2) the "When the run ends" section,
  // (amendment 6: also the four wake phrases in headless lines 64-101, pinned below)
  // headless lines 45-63; (3) the fix-round cutoff sentence, headless lines 102-104.
  const iHead = T.indexOf('## When the run ends');
  const iCheck = T.indexOf('## Checking the work');
  const iTail = T.findIndex((l) => l.startsWith('     {{max_fix_rounds}} fix rounds per work task'));
  assert.ok(iHead > 0 && iCheck > iHead && iTail > iCheck, 'sections found in order');
  assert.deepStrictEqual(T.slice(0, 3), [H[0], '', MARKER]);
  // line 17 differs by one phrase ("when you end the run" -> "when you stop"): the run does not end here.
  const l17 = H.slice(1, 44).map((l) => l.replace('and when you end the run (the outcome', 'and when you stop (the outcome'));
  assert.notDeepStrictEqual(l17, H.slice(1, 44), 'the substitution applied');
  assert.deepStrictEqual(T.slice(3, iHead), l17, 'headless lines 2-44, with the one phrase on line 17');
  // ADR 0037 amendment 6: in headless lines 64-101 each "wait on its id" becomes "end your turn until its wake",
  // and the compaction retry gets a bounded wait.
  const WAKE_PHRASES = [
    ['wait on its id, and evaluate again', 'end your turn until its wake, and evaluate again'],
    ['`worker_wait` on its id, resend after it answers.', '`worker_wait` on its id with `timeout_ms: 30000`, resend after it answers; if it times out, end your turn and resend on the next wake.'],
    ["When the reviewer's turn ends (wait on its id), call", "When the reviewer's wake comes (its turn ended), call"],
    ['with its result, wait on its id, then', 'with its result, end your turn until its wake, then'],
  ];
  const mid = H.slice(63, 101).map((l) => WAKE_PHRASES.reduce((s, [a, b]) => s.replace(a, b), l));
  assert.strictEqual(mid.filter((l, i) => l !== H[63 + i]).length, WAKE_PHRASES.length, 'each phrase replaced once');
  assert.deepStrictEqual(T.slice(iCheck - 1, iTail), mid, 'headless lines 64-101, with the wake phrases');
  assert.deepStrictEqual(T.slice(iTail + 3), H.slice(104), 'headless lines 105 to the end');
});

test('interactive prompt: the wakes paragraph stands alone and the bullet list is not split', () => {
  const iHead = T.indexOf('## When the run ends');
  const iCheck = T.indexOf('## Checking the work');
  const sec = T.slice(iHead, iCheck);
  const bullets = sec.map((l, i) => (l.startsWith('- ') ? i : -1)).filter((i) => i >= 0);
  assert.ok(bullets.length >= 3, 'the three bullets are there');
  for (let i = bullets[0]; i <= bullets[bullets.length - 1]; i++) assert.notStrictEqual(sec[i], '', `no blank line inside the list (line ${i})`);
  const noWakes = sec.findIndex((l) => l.startsWith('belay wakes you'));
  assert.ok(noWakes > 0 && noWakes < bullets[0], 'the paragraph precedes the list');
  assert.strictEqual(sec[noWakes - 1], ''); assert.strictEqual(sec[noWakes + 1], '');
});

const { substituteLevers, cutoffRule } = require(path.join(ROOT, 'src/cli/run-levers.cjs'));
const CASES = [['orchestrator', 0], ['orchestrator', 600000], ['cap-only', 0], ['cap-only', 600000]];

test('interactive prompt: rendered through substituteLevers in interactive mode, no replaced sentence survives (every fix_cutoff)', () => {
  for (const [fix_cutoff, timeout] of CASES) {
    const out = substituteLevers(TWIN, { max_fix_rounds: 2, fix_cutoff }, timeout, { mode: 'interactive' }).text;
    for (const s of [...REPLACED, ...REPLACED_IN_RULE]) assert.ok(!flat(out).includes(flat(s)), `${fix_cutoff}/${timeout} still has: ${s}`);
    assert.ok(!/\bwhen you close\b/.test(out), 'no "when you close"');
    if (fix_cutoff === 'orchestrator') {
      assert.ok(flat(out).includes('stop-and-surface (stop, store the outcome in memory, tell the operator the open blocking findings, then wait for them)'));
      assert.ok(flat(out).includes('when you stop.'));
    }
  }
});

test('interactive prompt: the sentence test can fail (the twin rendered in headless mode still carries the headless rule)', () => {
  const out = substituteLevers(TWIN, { max_fix_rounds: 2, fix_cutoff: 'orchestrator' }, 0).text;
  assert.ok(flat(out).includes(flat(REPLACED_IN_RULE[0])));
  assert.ok(flat(out).includes(flat(REPLACED_IN_RULE[1])));
});

test('headless substitution output is pinned byte for byte (the default mode is unchanged)', () => {
  const lv = { max_fix_rounds: 2, fix_cutoff: 'orchestrator' };
  const common = 'You may stop fix rounds before the cap, only towards stop-and-surface (end the run and name the open blocking findings for the human), '
    + 'and only when one of these holds: the same blocking finding survived a fix round; a fix round introduced a new regression; '
    + 'the fix needs files outside the task\'s owned set';
  const tail = '. Name the condition and its evidence when you close. Never extend past the cap and never report a refuted step as passing or mark it done.';
  const want0 = `${common}${tail} The run has no time bound.`;
  const wantT = `${common}; the run's time bound (600000 ms from its start) is near, judged from the waited_ms your worker_wait answers report${tail}`;
  assert.strictEqual(cutoffRule('orchestrator', 0), want0);
  assert.strictEqual(cutoffRule('orchestrator', 600000), wantT);
  assert.strictEqual(cutoffRule('cap-only', 0), 'Do not stop fix rounds before the cap.');
  for (const call of [(t, l, n) => substituteLevers(t, l, n), (t, l, n) => substituteLevers(t, l, n, {}), (t, l, n) => substituteLevers(t, l, n, { mode: 'headless' })]) {
    assert.deepStrictEqual(call('{{fix_cutoff_rule}}|{{max_fix_rounds}}', lv, 0), { text: `${want0}|2`, substituted: { max_fix_rounds: 1, fix_cutoff_rule: 1 } });
    assert.strictEqual(call('{{fix_cutoff_rule}}', lv, 600000).text, wantT);
  }
  assert.strictEqual(substituteLevers(HEADLESS, lv, 0).text, substituteLevers(HEADLESS, lv, 0, { mode: 'headless' }).text);
});
