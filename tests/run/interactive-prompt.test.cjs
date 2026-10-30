'use strict';
// ADR 0037 decision 4: the interactive twin is orchestrator.md with only its headless sentences replaced.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
// The templates are read as a run without notes renders them: the {{memory_use}} and {{memory_outcome}} markers (ADR 0047 amendment of 2026-10-22) are dropped and the text between them stays.
const read = (f) => fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n').replace(/\{\{\/?memory_(use|outcome)\}\}/g, '');
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
  'either end your turn (belay wakes you with a message when a worker\'s turn ends or a worker dies;',
  'that wake exists only when belay started you with `belay run`, and only while some worker is mid-turn',
  'do not poll in a loop',
  'and ending your turn closes the run.',
  'is not mid-turn, and the run closes.',
  'To stop on purpose, store the outcome in memory, say why, then end a turn with no worker mid-turn.',
  'and when you end the run (the outcome',
  // amendment 6: the headless waiting rules
  'a timeout is a result: call it again',
  'Never end a turn just after a `task_assign` whose',
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
  assert.match(TWIN, /belay wakes you with a short message when a worker's turn ends or a worker dies\. While workers are working, end your turn; do not hold one open to wait\./);
  assert.ok(!/There are no wakes/.test(TWIN), 'the no-wakes claim is gone');
  // Wording audit: the embedder-failure pause is told by the error that reports it (pauseAdvice), not by a paragraph every request pays for.
  assert.ok(!/paused for an embedder failure/.test(TWIN));
  const advice = require(path.join(ROOT, 'src/core/embedder-mode.cjs')).pauseAdvice('run-1');
  assert.match(advice, /Stop and ask the operator which they want: keyword .*, off .*, or stay paused\. Apply their choice with: belay resume run-1 --embedder keyword\|off/);
  assert.match(TWIN, /Ending a turn does not end the run/);
  assert.match(TWIN, /the run ends when the operator quits the session/);
  // ADR 0037 amendment 6: the wake is how the orchestrator waits; worker_wait is a short check, never a loop
  // (wait-loop probe: the old "re-call it" text held a turn 165 s in two waits, the new text none).
  assert.ok(!/Re-call it/.test(TWIN), 'no instruction to re-call worker_wait');
  assert.ok(!/wait on its id/.test(TWIN), 'no "wait on its id"');
  assert.match(TWIN, /`timeout_ms: 5000`[^]*Never call it in a loop\./);
  const iWait = T.indexOf('- After you start work (a spawn with a prompt, or a `worker_message`), name the workers you are');
  assert.deepStrictEqual(T.slice(iWait, iWait + 10), [
    '- After you start work (a spawn with a prompt, or a `worker_message`), name the workers you are',
    '  waiting for so the operator can see it. When a wake names a worker, read its',
    '  hand-back with `mcp__belay__task_list` and its `task_ids`. Use',
    '  `mcp__belay__worker_wait` only as a check when no wake came for a worker you expected: pass',
    '  `worker_ids` and `timeout_ms: 5000`. A timeout means the worker is still working: end your turn',
    '  again. Never call it in a loop.',
    '  `already: true` means that worker\'s turn ended before your call, not that the work is done.',
    '- A worker whose turn has ended without what you waited for is idle, not working. Instead call',
    '  `mcp__belay__worker_message` to tell it what is missing: that starts a turn. Then end your turn.',
    '- When every task is `done`, or when you stop on purpose, store the outcome in memory with',
  ], 'the waiting bullets, pinned line for line');
  assert.ok(!/check its work with `task_evaluate`/.test(TWIN), 'a hand-back with a result is evaluated at release; task_evaluate on a done task is refused (E_TASK_DONE)');
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
  assert.match(r.text, /after 3 fix rounds belay still creates the fix/);
});

test('interactive prompt: apart from three named ranges the twin equals orchestrator.md section for section', () => {
  // Allowed differences: (1) the blank line and marker after the title; (2) the "When the run ends" section; (3) the fix-round
  // cutoff sentence, the last three lines of "Review tasks"; and (amendment 6) the two wake phrases below. The sections are matched by
  // heading, not by line number, so a line added to both prompts needs no edit here.
  const sections = (L) => { const m = new Map(); let k = '(top)'; m.set(k, []); for (const l of L) { if (l.startsWith('## ')) { k = l; m.set(k, []); } m.get(k).push(l); } return m; };
  const hs = sections(H), ts = sections(T);
  assert.deepStrictEqual([...ts.keys()], [...hs.keys()], 'the same sections in the same order');
  assert.deepStrictEqual(T.slice(0, 3), [H[0], '', MARKER]);
  // The top, apart from the marker and its blank line.
  assert.deepStrictEqual(ts.get('(top)').slice(4), hs.get('(top)').slice(2), 'the title block');
  // "Your role" differs by one phrase ("when you end the run (the outcome" -> "when you stop (the outcome"): the run does not end here.
  const role = hs.get('## Your role').map((l) => l.replace('and when you end the run (the outcome', 'and when you stop (the outcome'));
  assert.notDeepStrictEqual(role, hs.get('## Your role'), 'the substitution applied');
  assert.deepStrictEqual(ts.get('## Your role'), role);
  for (const k of ['## Tasks', '## Handing a task to a worker', '## Rules of thumb']) assert.deepStrictEqual(ts.get(k), hs.get(k), k);
  // ADR 0037 amendment 6: each "wait on its id" becomes "end your turn until its wake".
  const WAKE_PHRASES = [
    ['wait on its id, and evaluate again', 'end your turn until its wake, and evaluate again'],
    ['with its result, wait on its id; that', 'with its result, end your turn until its wake; that'],
  ];
  const swap = (L) => L.map((l) => WAKE_PHRASES.reduce((x, [p, q]) => x.replace(p, q), l));
  const checking = swap(hs.get('## Checking the work')), review = swap(hs.get('## Review tasks'));
  assert.strictEqual(checking.concat(review).filter((l, i) => l !== hs.get('## Checking the work').concat(hs.get('## Review tasks'))[i]).length, WAKE_PHRASES.length, 'each phrase replaced once');
  assert.deepStrictEqual(ts.get('## Checking the work'), checking);
  const cut = (L) => L.findIndex((l) => l.startsWith('     {{max_fix_rounds}} per work task'));
  const iH = cut(review), iT = cut(ts.get('## Review tasks'));
  assert.ok(iH > 0 && iH === iT, 'the cutoff sentence starts at the same line');
  assert.deepStrictEqual(ts.get('## Review tasks').slice(0, iT), review.slice(0, iH), 'Review tasks up to the cutoff sentence');
  assert.deepStrictEqual(ts.get('## Review tasks').slice(iT + 3), review.slice(iH + 3), 'and after it');
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
      assert.ok(flat(out).includes('stop-and-surface (stop, record the outcome, tell the operator the open blocking findings, then wait for them)'));
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
  const common = 'You may stop fix rounds before the fix-round limit, only towards stop-and-surface (end the run and name the open blocking findings for the human), '
    + 'and only when one of these holds: the same blocking finding survived a fix round; a fix round introduced a new regression; '
    + 'the fix needs files outside the task\'s owned set';
  const tail = '. Name the condition and its evidence when you close. Never report a refuted step as passing or mark it done.';
  const want0 = `${common}${tail} The run has no time bound.`;
  const wantT = `${common}; the run's time bound (600000 ms from its start) is near, judged from the waited_ms your worker_wait answers report${tail}`;
  assert.strictEqual(cutoffRule('orchestrator', 0), want0);
  assert.strictEqual(cutoffRule('orchestrator', 600000), wantT);
  assert.strictEqual(cutoffRule('cap-only', 0), 'Do not stop fix rounds before the fix-round limit.');
  for (const call of [(t, l, n) => substituteLevers(t, l, n), (t, l, n) => substituteLevers(t, l, n, {}), (t, l, n) => substituteLevers(t, l, n, { mode: 'headless' })]) {
    assert.deepStrictEqual(call('{{fix_cutoff_rule}}|{{max_fix_rounds}}', lv, 0), { text: `${want0}|2`, substituted: { max_fix_rounds: 1, fix_cutoff_rule: 1 } });
    assert.strictEqual(call('{{fix_cutoff_rule}}', lv, 600000).text, wantT);
  }
  assert.strictEqual(substituteLevers(HEADLESS, lv, 0).text, substituteLevers(HEADLESS, lv, 0, { mode: 'headless' }).text);
});
