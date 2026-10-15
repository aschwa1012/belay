'use strict';
// close-stages-scrub.test.cjs — the run-close scrubber stage with a fake run manager, so no session is ever started. The core is the
// real engine on the lifecycle sandbox store: the scope is the core's, every hand-back is checked and applied by memory.scrubApply,
// and the adversarial hand-backs are refused there, at no cost.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { env, fakeManager, json, LV, RUN } = require('./close-stages-env.cjs');
const { runScrub } = require('../../src/run/scrub-stage.cjs');
const { createNoteWatcher } = require('../../src/run/note-wake.cjs');
const { stageEvents } = require('../../src/cli/cmd-notices.cjs');

let X, T;
before(async () => { X = await env(); T = X.T; await X.worker('apply', 'w-head'); await X.worker('apply', 'w2'); await X.worker('propose', 'w-head-p'); await X.worker('alarm', 'w-head-a'); });
after(() => T.close());

const stage = (kind, manager, extra = {}) => runScrub({ core: X.coreFor(kind), runId: RUN[kind], lv: LV[kind], dataDir: T.dir, getManager: async () => manager, worktree: T.repo, goal: 'ship the loader', summary: 'the orchestrator says it went fine', ...extra });
// The ids the core now lists as owed (the last owed receipt for the id, with no ok scrub_job after it).
const owedNow = async () => (await T.call(T.who.operator('apply'), 'memory.scrubScope', {})).items.filter((i) => i.why.includes('owed')).map((i) => i.id);

test('an empty scope spawns nothing, writes nothing and never asks for a manager', async () => {
  let asked = 0;
  const { log, core } = X.calls(X.coreFor('apply'));
  const before = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const eventsBefore = T.store.p('SELECT COUNT(*) AS n FROM memory_event').get().n;
  const o = await runScrub({ core, runId: RUN.apply, lv: LV.apply, dataDir: T.dir, getManager: async () => { asked += 1; return null; } });
  assert.deepStrictEqual([o.ran, o.reason, asked], [false, 'empty scope', 0]);
  assert.deepStrictEqual(log, ['memory.nominate', 'memory.scrubScope'], 'the nomination call, then one read, and nothing else');
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, before);
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_event').get().n, eventsBefore);
});

test('with notes off or scrub_action off the stage reads nothing at all', async () => {
  const { log, core } = X.calls(X.coreFor('off'));
  X.reported('would be in scope', 'off');
  const off = await runScrub({ core, runId: RUN.off, lv: LV.off, dataDir: T.dir, getManager: async () => assert.fail('no manager') });
  const plain = await runScrub({ core, runId: RUN.plain, lv: LV.plain, dataDir: T.dir, getManager: async () => assert.fail('no manager') });
  assert.deepStrictEqual([off.reason, plain.reason, log], ['scrub_action off', 'notes off', []]);
});

test('scope selection: the child gets exactly the core\'s three kinds of item, with their evidence, and a brief with the run\'s facts', async () => {
  const rep = X.reported('selected: reported wrong this run');
  const pend = X.pending('selected: pending from this run');
  const plain = T.note('not selected: merely delivered');
  const old = T.note('not selected: reported in an old run', { reported_wrong: [T.report()] });
  const m = fakeManager(T, 'apply', json('scrub', []));
  const o = await stage('apply', m);
  assert.strictEqual(o.ran, true);
  assert.strictEqual(m.spawned.length, 1);
  const a = m.spawned[0];
  assert.deepStrictEqual([a.model, a.allowed_tools, a.tools, a.max_budget_usd, a.substrate], ['claude-haiku-5-5', ['Read', 'Glob', 'Grep'], ['Read', 'Glob', 'Grep'], 0.1, 'claude-code']);
  assert.ok(a.worker_id.startsWith('scrub-lc-apply-') && !('task_id' in a), 'a job id, holding no task and no lease');
  assert.strictEqual(m.waits[0].timeout_ms, 300000);
  assert.deepStrictEqual(m.stopped, [a.worker_id], 'the child is stopped by the manager');
  const briefFile = /(\S+brief\.md)/.exec(a.prompt)[1];
  const brief = fs.readFileSync(briefFile, 'utf8');
  for (const must of ['ship the loader', 'the orchestrator says it went fine', T.head, rep, pend, '/workers/w2/stream.jsonl', 'reported_wrong', 'pending']) assert.ok(brief.includes(must), `the brief holds ${must}`);
  assert.ok(!brief.includes(plain) && !brief.includes(old), 'out-of-scope notes are not in the brief');
  const grounds = ['code_contradicts', 'report_confirmed', 'refuted_review', 'replaced_by_newer', 'same_claim', 'report_unfounded'];
  for (const g of grounds) assert.ok(a.prompt.includes(g), `the prompt names the ground ${g}`);
  assert.match(a.prompt, /never accepted|NOT a ground/);
  assert.deepStrictEqual(o.counts.items, 2);
});

test('a valid hand-back is applied through memory.scrubApply in apply mode, with a receipt naming the items', async () => {
  const n = X.reported('wrong: applied hold');
  const m = fakeManager(T, 'apply', (a) => json('scrub', [X.hold(n)]));
  const o = await stage('apply', m);
  assert.strictEqual(o.error, undefined, JSON.stringify(o.error));
  assert.strictEqual(o.result.counts.applied, 1);
  assert.ok(X.holds().length >= 1);
  assert.ok(JSON.parse(T.row(n).body).held, 'the note carries the hold');
  const ev = X.events('scrub_job').pop();
  assert.deepStrictEqual([ev.ok, JSON.parse(ev.row_ids).includes(n), ev.worker_id === m.spawned[0].worker_id], [1, true, true]);
  assert.match(ev.message, /apply: applied 1/);
  assert.ok(!(await owedNow()).includes(n), 'a handled item is not owed');
  const pre = X.events('scrub_owed').find((e) => JSON.parse(e.row_ids).includes(n));
  assert.deepStrictEqual([pre.code, pre.seq < ev.seq], ['E_INTERRUPTED', true], 'the item was owed BEFORE the child started, and the ok scrub_job cleared it');
  assert.match(ev.message, new RegExp(`head ${T.head} in `), 'the receipt names the head and worktree the cites were checked against');
});

test('scrub_action propose writes proposals and applies nothing', async () => {
  const n = X.reported('wrong: proposed only', 'propose');
  const m = fakeManager(T, 'propose', json('scrub', [X.hold(n)]));
  const before = X.holds().length;
  const o = await stage('propose', m);
  assert.strictEqual(o.mode, 'propose');
  assert.strictEqual(o.result.counts.proposed, 1);
  assert.strictEqual(X.holds().length, before, 'nothing held');
  assert.ok(X.proposals().length >= 1);
  assert.strictEqual(JSON.parse(T.row(n).body).held, undefined);
});

test('a cost over the cap, no recorded cost, a timeout, a failed turn or junk applies nothing and the items are owed to the next scrub', async () => {
  const cases = [
    ['over the cap', fakeManager(T, 'apply', null, { cost: 0.5 }), 'E_COST_CAP'],
    ['no recorded cost', fakeManager(T, 'apply', null, { cost: 0 }), 'E_COST_CAP'],
    ['timeout', fakeManager(T, 'apply', '', { event: 'timeout' }), 'E_TIMEOUT'],
    ['died', fakeManager(T, 'apply', '', { event: 'death' }), 'E_WORKER_NOT_LIVE'],
    ['junk', fakeManager(T, 'apply', 'I looked and it all seems fine.'), 'E_ARGS'],
    ['spawn refused', fakeManager(T, 'apply', null, { spawnError: Object.assign(new Error('no ready'), { code: 'E_NO_READY' }) }), 'E_NO_READY'],
  ];
  for (const [label, m, code] of cases) {
    const n = X.reported(`owed after ${label}`);
    const m2 = label === 'over the cap' || label === 'no recorded cost' ? fakeManager(T, 'apply', json('scrub', [X.hold(n)]), { cost: label === 'no recorded cost' ? 0 : 0.5 }) : m;
    const heldBefore = X.holds().length;
    const o = await stage('apply', m2);
    assert.strictEqual(o.error.code, code, label);
    assert.strictEqual(X.holds().length, heldBefore, `${label}: nothing applied`);
    assert.strictEqual(JSON.parse(T.row(n).body).held, undefined, label);
    assert.ok((await owedNow()).includes(n), `${label}: the item is owed`);
    const bad = X.events('scrub_job').filter((e) => !e.ok).pop();
    assert.deepStrictEqual([bad.code, bad.key], [code, `run:${RUN.apply}`]);
    if (label !== 'spawn refused') assert.deepStrictEqual(m2.stopped, [m2.spawned[0].worker_id], `${label}: the child was stopped`);
    // the next scrub of the project takes the owed item first, whatever run it is for
    const again = await X.T.call(T.who.operator('apply'), 'memory.scrubScope', {});
    assert.strictEqual(again.items[0].id, n, label);
    await T.call(T.who.harness('apply'), 'memory.recordEvent', { kind: 'scrub_job', run_id: RUN.apply, key: 'clear', row_ids: [n], ok: true, message: 'cleared by the test' });
  }
});

test('more items than scrub_max_items: the first are offered, the rest are owed, and the next scrub takes the owed first', async () => {
  const t0 = Date.now() + 100000;
  const ns = [1, 2, 3].map((i) => X.reported(`cap item ${i}`, 'apply', { created_at: t0 + i }));
  const lv = { ...LV.apply, scrub_max_items: 2 };
  const m = fakeManager(T, 'apply', json('scrub', []));
  const o = await runScrub({ core: X.coreFor('apply'), runId: RUN.apply, lv, dataDir: T.dir, getManager: async () => m, worktree: T.repo });
  assert.deepStrictEqual([o.offered, o.owed.slice(0, 1)], [2, [ns[2]]]);
  assert.deepStrictEqual(o.owed.slice(1).sort(), [ns[0], ns[1]].sort(), 'the two the child gave no entry for are owed once more');
  const brief = fs.readFileSync(/(\S+brief\.md)/.exec(m.spawned[0].prompt)[1], 'utf8');
  assert.ok(brief.includes(ns[0]) && brief.includes(ns[1]) && !brief.includes(ns[2]));
  const owed = X.events('scrub_owed').find((e) => e.code === 'E_ARGS' && JSON.parse(e.row_ids).includes(ns[2]));
  assert.deepStrictEqual([JSON.parse(owed.row_ids), owed.ok], [[ns[2]], 0]);
  const m2 = fakeManager(T, 'apply', json('scrub', []));
  await runScrub({ core: X.coreFor('apply'), runId: RUN.apply, lv: { ...lv, scrub_max_items: 5 }, dataDir: T.dir, getManager: async () => m2, worktree: T.repo });
  const brief2 = fs.readFileSync(/(\S+brief\.md)/.exec(m2.spawned[0].prompt)[1], 'utf8');
  assert.ok(brief2.includes(ns[2]) && brief2.includes(ns[0]) && brief2.includes(ns[1]), 'every owed item is taken first');
  const m3 = fakeManager(T, 'apply', json('scrub', []));
  const third = await runScrub({ core: X.coreFor('apply'), runId: RUN.apply, lv: { ...lv, scrub_max_items: 5 }, dataDir: T.dir, getManager: async () => m3, worktree: T.repo });
  assert.deepStrictEqual(third.owed, [], 'an item the child skipped twice is let go, not owed forever');
});

test('the alarm: more holds than scrub_alarm_holds still apply, and come back as a receipt, a wake in belay\'s words and a notice', async () => {
  const ns = [1, 2, 3].map((i) => X.reported(`alarm item ${i}`, 'alarm'));
  const m = fakeManager(T, 'alarm', json('scrub', ns.map((n) => X.hold(n))));
  const o = await stage('alarm', m);
  assert.strictEqual(o.alarm.kind, 'many_holds');
  assert.strictEqual(o.result.counts.applied, 3, 'not a throttle');
  const ev = X.events('scrub_alarm').pop();
  assert.deepStrictEqual([ev.ok, JSON.parse(ev.row_ids).length], [1, 3]);
  assert.match(ev.message, /3 hold marks, over the 2/);
  const watcher = createNoteWatcher({ core: X.coreFor('alarm'), runId: RUN.alarm, enabled: true });
  const wakes = await watcher.poll();
  const w = wakes.find((x) => x.event === 'scrub_alarm');
  assert.ok(w && w.text.startsWith('belay: ') && w.text.includes('3 hold marks') && Buffer.byteLength(w.text) < 600);
  assert.strictEqual((await watcher.poll()).filter((x) => x.event === 'scrub_alarm').length, 0, 'one wake per receipt');
  const off = createNoteWatcher({ core: X.coreFor('alarm'), runId: RUN.alarm, enabled: false });
  assert.deepStrictEqual(await off.poll(), []);
  const notice = stageEvents(X.events('scrub_alarm'), RUN.alarm)[0];
  assert.strictEqual(notice.kind, 'scrub_alarm');
  assert.match(notice.text, /hold marks/);
});

// REPORT 6.1: the adversarial hand-backs are refused by the core, so a wrong model costs a Haiku call and nothing else.
// Each case plants its own reported note: a note a scrub already handled is not offered to the run again.
const attack = async (label, make, expect) => {
  const target = X.reported(`adversarial target: ${label}`);
  const outside = T.note(`outside the scope: ${label}`, { reported_wrong: [T.report()] });
  const heldBefore = X.holds().length;
  const m = fakeManager(T, 'apply', json('scrub', make(target, outside)));
  const o = await stage('apply', m);
  assert.strictEqual(m.spawned.length, 1, label);
  if (expect.code) assert.strictEqual(o.error && o.error.code, expect.code, label);
  else { assert.strictEqual(o.error, undefined, `${label}: ${JSON.stringify(o.error)}`); assert.deepStrictEqual(o.result.refused.map((r) => r.code), [expect.refused], label); }
  assert.strictEqual(X.holds().length, heldBefore, `${label}: nothing was held`);
  for (const id of [target, outside]) assert.strictEqual(JSON.parse(T.row(id).body).held, undefined, `${label}: ${id} carries no hold`);
  if (expect.code) assert.ok((await owedNow()).includes(target), `${label}: a refused hand-back owes its items`);
};

test('adversarial: an id outside the scope list refuses the whole call, the in-scope entry included', async () => {
  await attack('out-of-scope id', (t, o) => [X.hold(t), X.hold(o)], { code: 'E_SCOPE' });
});

test('adversarial: a cite that is not in the file at the head commit, or a stream not offered, is refused entry by entry', async () => {
  await attack('bad cite', (t) => [X.hold(t, { cites: [{ where: 'loader.js', quote: 'this line is not anywhere in the file at all' }] })], { refused: 'E_CITATION' });
  await attack('missing file', (t) => [X.hold(t, { cites: [{ where: 'src/missing.js', quote: 'return fixtures.get(name); // unlisted names throw' }] })], { refused: 'E_CITATION' });
  await attack('path escape', (t) => [X.hold(t, { cites: [{ where: '../outside.txt', quote: 'return fixtures.get(name); // unlisted names throw' }] })], { refused: 'E_CITATION' });
  await attack('stream not offered', (t) => [X.hold(t, { cites: [{ where: `stream:${T.dir}/workers/elsewhere/stream.jsonl`, quote: 'a long enough line that no stream holds' }] })], { refused: 'E_CITATION' });
  await attack('code_contradicts on a stream alone', (t) => [X.hold(t, { ground: 'code_contradicts', cites: [{ where: `stream:${T.dir}/workers/w2/stream.jsonl`, quote: '{"type":"system"}' }] })], { code: 'E_ARGS' });
});

test('adversarial: use and miss facts are never a ground, and a ground must fit the kind', async () => {
  for (const ground of ['never_used', 'delivered_but_not_cited', 'missed_ten_times', 'unused_for_weeks', 'stale', 'inert']) await attack(`ground ${ground}`, (t) => [X.hold(t, { ground })], { code: 'E_GROUND' });
  await attack('a ground of another kind', (t) => [X.hold(t, { ground: 'same_claim' })], { code: 'E_GROUND' });
  await attack('no ground', (t) => [X.hold(t, { ground: undefined })], { code: 'E_GROUND' });
});

test('adversarial: forged kinds, actions, fields and shapes are refused whole', async () => {
  await attack('forged kind', (t) => [X.hold(t, { kind: 'stale' })], { code: 'E_ARGS' });
  await attack('forged action', (t) => [{ id: t, action: 'delete', reason: 'gone for good' }], { code: 'E_ARGS' });
  await attack('archive action', (t) => [{ id: t, action: 'archive', reason: 'straight to the archive', cites: [T.cite] }], { code: 'E_ARGS' });
  await attack('extra field', (t) => [X.hold(t, { archive: true })], { code: 'E_ARGS' });
  await attack('hold without cites', (t) => [X.hold(t, { cites: [] })], { code: 'E_ARGS' });
  await attack('twice', (t) => [X.hold(t), X.hold(t)], { code: 'E_ARGS' });
  await attack('too many', (t) => Array.from({ length: 41 }, (_, i) => X.hold(i ? `n${i}` : t)), { code: 'E_ARGS' });
  await attack('hold without its other note', (t) => [X.hold(t, { kind: 'duplicate', ground: 'same_claim' })], { code: 'E_ARGS' });
});

test('adversarial: facts the store does not hold are refused entry by entry (a duplicate nobody reported, a wrong note nobody reported)', async () => {
  await attack('duplicate without similarity or report', (t, o) => [X.hold(t, { kind: 'duplicate', of: o, ground: 'same_claim' })], { refused: 'E_SCOPE' });
  const unreported = T.note('never reported wrong');
  const target = X.reported('scoped, so the stage can reach the unreported one');
  const m = fakeManager(T, 'apply', json('scrub', [X.hold(unreported)]));
  const o = await stage('apply', m);
  assert.strictEqual(o.error.code, 'E_SCOPE', 'a note the core did not list is not the scrubber\'s to touch');
  assert.strictEqual(JSON.parse(T.row(unreported).body).held, undefined);
  void target;
});


test('nothing but the scope: a hold on a pending note is applied directly and a resolve settles it, both inside the scope list', async () => {
  const pend = X.pending('pending to resolve', 'apply', { matches: [] });
  const m = fakeManager(T, 'apply', json('scrub', [{ id: pend, action: 'resolve', resolve: 'new', reason: 'a different lesson from any live note' }]));
  const o = await stage('apply', m);
  assert.strictEqual(o.result.counts.applied, 1, JSON.stringify(o));
  assert.strictEqual(T.row(pend).namespace, 'project/lc');
});

test('fast close: nothing is spawned, the whole scope is owed, and the reviewer is skipped too', async () => {
  const n = X.reported('fast close item');
  const m = fakeManager(T, 'apply', json('scrub', []));
  const o = await stage('apply', m, { fast: () => true });
  assert.deepStrictEqual([o.ran, o.reason, m.spawned.length], [false, 'fast close', 0]);
  assert.ok(o.owed.includes(n) && (await owedNow()).includes(n), 'the item is owed to the next scrub');
  assert.strictEqual(X.events('scrub_owed').filter((e) => e.worker_id && e.worker_id.startsWith('scrub-')).pop().code, 'E_ABORTED');
  const r = await require('../../src/run/review-stage.cjs').runReview({ core: X.coreFor('apply'), runId: RUN.apply, lv: LV.apply, dataDir: T.dir, getManager: async () => assert.fail('no manager'), fast: () => true, force: true });
  assert.ok(r.ran === false);
  // the owed item is taken by an ordinary scrub afterwards
  const m2 = fakeManager(T, 'apply', json('scrub', [X.hold(n)]));
  assert.strictEqual((await stage('apply', m2)).result.counts.applied, 1);
});

test('fast close while the child runs: it is killed by its exact pid (mode kill), nothing is applied, and the items stay owed', async () => {
  const n = X.reported('child running when the console closes');
  let flag = false;
  const m = fakeManager(T, 'apply', json('scrub', [X.hold(n)]));
  m.wait = async () => { setTimeout(() => { flag = true; }, 50); return new Promise(() => {}); }; // the child never answers
  const stops = [];
  m.stop = async (a) => { stops.push(a); };
  const o = await stage('apply', m, { fast: () => flag });
  assert.strictEqual(o.error.code, 'E_ABORTED');
  assert.ok(stops.some((s) => s.mode === 'kill' && s.worker_id === m.spawned[0].worker_id), JSON.stringify(stops));
  assert.strictEqual(JSON.parse(T.row(n).body).held, undefined, 'nothing applied');
  assert.ok((await owedNow()).includes(n));
  // a fast close that arrives while the child is still starting is killed once the spawn settles
  const m2 = fakeManager(T, 'apply', '');
  const real = m2.spawn; let f2 = false;
  m2.spawn = async (a) => { setTimeout(() => { f2 = true; }, 30); await new Promise((r) => setTimeout(r, 400)); return real(a); };
  const stops2 = []; m2.stop = async (a) => { stops2.push(a); };
  const o2 = await stage('apply', m2, { fast: () => f2 });
  assert.strictEqual(o2.error.code, 'E_ABORTED');
  assert.ok(stops2.some((s) => s.mode === 'kill'));
});

test('a child that survives its stop is killed again and, if it is still alive, named for the run', async () => {
  const n = X.reported('survivor');
  const m = fakeManager(T, 'apply', json('scrub', []));
  const kills = [];
  m.stop = async (a) => { kills.push(a.mode || 'graceful'); };
  const real = m.spawn;
  m.spawn = async (a) => { const r = await real(a); m.recs.get(a.worker_id).pid = process.pid; return r; }; // a pid that stays alive
  const o = await stage('apply', m);
  assert.strictEqual(o.survivor, process.pid);
  assert.deepStrictEqual(kills, ['graceful', 'kill']);
  void n;
});

// Hands every item still in scope to a child that gives no entry, until the scope is empty (an item skipped twice is let go).
async function settleAll() {
  for (let i = 0; i < 6; i += 1) {
    const o = await runScrub({ core: X.coreFor('apply'), runId: RUN.apply, lv: { ...LV.apply, scrub_max_items: 500 }, dataDir: T.dir, getManager: async () => fakeManager(T, 'apply', json('scrub', [])), worktree: T.repo });
    if (!o.ran) return;
  }
  assert.fail('the scope never emptied');
}

test('a cost overrun halves the next attempt, oldest first, down to 1; a success ends it; nothing is applied from an over-cap job', async () => {
  await settleAll();
  const t0 = Date.now() + 500000;
  const ns = [1, 2, 3, 4].map((i) => X.reported(`overrun item ${i}`, 'apply', { created_at: t0 + i }));
  const lv = { ...LV.apply, scrub_max_items: 4 };
  const go = (m) => runScrub({ core: X.coreFor('apply'), runId: RUN.apply, lv, dataDir: T.dir, getManager: async () => m, worktree: T.repo });
  const briefOf = (m) => fs.readFileSync(/(\S+brief\.md)/.exec(m.spawned[0].prompt)[1], 'utf8');
  const heldBefore = X.holds().length;
  const over = fakeManager(T, 'apply', json('scrub', ns.map((n) => X.hold(n))), { cost: 0.5 });
  const a1 = await go(over);
  assert.deepStrictEqual([a1.offered, a1.overrun.attempted, a1.overrun.next, a1.error.code], [4, 4, 2, 'E_COST_CAP']);
  assert.strictEqual(X.holds().length, heldBefore, 'nothing from an over-cap job is applied');
  const ev = X.events('stage_overrun').pop();
  assert.deepStrictEqual([ev.key, JSON.parse(ev.row_ids).length, ev.ok], ['scrub', 4, 0]);
  assert.match(ev.message, /raise memory\.scrub_cost_cap_usd/);
  const over2 = fakeManager(T, 'apply', '', { cost: 0.5 });
  const a2 = await go(over2);
  assert.deepStrictEqual([a2.offered, a2.overrun.next], [2, 1]);
  const over3 = fakeManager(T, 'apply', '', { cost: 0.5 });
  const a3 = await go(over3);
  assert.deepStrictEqual([a3.offered, a3.overrun.next], [1, 1], 'down to 1, never 0');
  const b3 = briefOf(over3), b2 = briefOf(over2);
  assert.ok(b3.includes(ns[0]) && !b3.includes(ns[1]), 'oldest first');
  assert.ok(b2.includes(ns[0]) && b2.includes(ns[1]) && !b2.includes(ns[2]));
  const ok = fakeManager(T, 'apply', json('scrub', [X.hold(ns[0])]));
  assert.strictEqual((await go(ok)).result.counts.applied, 1);
  const after = fakeManager(T, 'apply', json('scrub', []));
  assert.strictEqual((await go(after)).offered, 3, 'the success ended the halving: every remaining item is taken');
});

test('a failure that spent most of the cap counts as an overrun; a cheap failure does not', async () => {
  X.reported('cheap failure');
  const cheap = await stage('apply', fakeManager(T, 'apply', 'junk', { cost: 0.01 }));
  assert.strictEqual(cheap.overrun, undefined);
  const dear = await stage('apply', fakeManager(T, 'apply', 'junk', { cost: 0.095 }));
  assert.ok(dear.overrun, 'junk after spending 95% of the cap');
  await stage('apply', fakeManager(T, 'apply', json('scrub', [])));
});

test('the notices: an overrun is a line naming the lever; an owed receipt shows only while an item is still owed', async () => {
  const N = require('../../src/cli/cmd-notices.cjs');
  const ledger = (await T.call(T.who.operator('apply'), 'memory.events', { kinds: ['scrub_owed', 'scrub_job', 'stage_overrun', 'scrub_alarm', 'review_stage'] })).events;
  const notes = N.stageEvents(ledger, RUN.apply);
  assert.ok(notes.some((e) => e.kind === 'stage_overrun' && /raise memory\.scrub_cost_cap_usd/.test(e.text)));
  const owed = notes.filter((e) => e.kind === 'scrub_owed');
  for (const e of owed) assert.ok(e.row_ids.length > 0);
  const synth = [
    { id: 'a', kind: 'scrub_owed', ok: 0, row_ids: ['n1'], written_at: 1, code: 'E_INTERRUPTED', message: 'started' },
    { id: 'b', kind: 'scrub_job', ok: 1, row_ids: ['n1'], written_at: 2 },
    { id: 'c', kind: 'scrub_owed', ok: 0, row_ids: ['n2'], written_at: 3, code: 'E_TIMEOUT', message: 'late' },
  ];
  assert.deepStrictEqual(N.stageEvents(synth, 'r').map((e) => [e.kind, e.row_ids]), [['scrub_owed', ['n2']]], 'n1 was cleared by the ok job');
});
