'use strict';
// memory-held.test.cjs — `belay memory held` (the listing, a read: no owner, no file, bytes unchanged) and `belay memory held settle` (a write: it
// elects, writes, returns the rows it changed and leaves no owner behind). The built CLI as a subprocess against a sandbox store planted into the tables.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Store } = require('../../src/core/store.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');
const { teardown } = require('../helpers/teardown.cjs');

const cli = (args, dataDir, json = true) => spawnSync(process.execPath, [CLI, 'memory', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
const listDir = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length)); } };
  walk(dir);
  return out.sort();
};
const digest = (dir) => listDir(dir).map((f) => `${f}:${crypto.createHash('sha256').update(fs.readFileSync(dir + f)).digest('hex')}`);

function plant(dataDir) {
  const store = new Store(`${dataDir}/memory.db`, { stamp: true });
  const put = (ns, type, title, body) => store.storeIn({ namespace: ns, worker_id: 'w1', type, text: `${title} ${Math.random()}`, title, body, run_id: 'r1', source: 'harness', written_by: 'harness' }).id;
  const out = {};
  for (const k of ['a', 'b']) {
    out[k] = put('project/acme', 'note', `held note ${k}`, { state: 'live', kind: 'lesson', evidence: [], reported_wrong: [{ by: 'worker:w2', task_id: 't2', at: 5, why: 'wrong', seq: 1 }], report_seq: 1 });
    out[`${k}Hold`] = put('held/acme', 'held', `held wrong ${k}`, { state: 'held', note_id: out[k], kind: 'wrong', ground: 'reported', reason: 'wrong', rev: 0, reports: [{ key: 's:1', by: 'worker:w2', why: 'wrong', at: 5 }], reports_total: 1, reviews: [] });
    store.patchBody(out[k], (b) => { b.held = { row: out[`${k}Hold`], kind: 'wrong', of: null, reason: 'wrong', run_id: 'r1', at: 1 }; return b; });
  }
  store.patchBody(out.bHold, (b) => { b.undecided = { rev: 0, at: 9, receipt: 'review:r1:x', reason: 'cannot say' }; return b; });
  store.close();
  return out;
}

test('the listing is a read: it starts no owner, creates no file, changes no byte; --awaiting and --project filter', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    const p = plant(dir);
    const before = digest(dir);
    const r = cli(['held'], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.total, j.awaiting_operator, j.entries.map((e) => e.note_id).sort()], [2, 1, [p.a, p.b].sort()]);
    const aw = JSON.parse(cli(['held', '--awaiting'], dir).stdout);
    assert.deepStrictEqual(aw.entries.map((e) => e.note_id), [p.b]);
    assert.strictEqual(JSON.parse(cli(['held', '--project', 'nope'], dir).stdout).entries.length, 0);
    const text = cli(['held'], dir, false);
    assert.match(text.stdout, /2 held, 1 awaiting the operator/);
    assert.match(text.stdout, /AWAITS YOU: cannot say/);
    assert.deepStrictEqual(digest(dir), before, 'no file created, no byte changed');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`));
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('settle elects, writes, returns the rows it changed and leaves no owner behind', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    const p = plant(dir);
    const r = cli(['held', 'settle', p.a, '--release', '--reason', 'the operator judged the report unfounded'], dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.outcome, j.held_row, j.held.body.state, j.settled.count, j.verified], ['released', p.aHold, 'released', 1, false]);
    assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'no owner left behind');
    const r2 = cli(['held', 'settle', p.b, '--reoffer', '--reason', 'look again'], dir); assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
    assert.strictEqual(JSON.parse(r2.stdout).outcome, 'reoffered');
    const r3 = cli(['held', 'settle', p.b, '--archive', '--reason', 'wrong for good'], dir);
    assert.strictEqual(JSON.parse(r3.stdout).to, 'archive/acme');
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('--if-awaiting settles only a hold that awaits the operator, checked in the write itself; without it nothing changes', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    const p = plant(dir);
    // a was never marked undecided: refused, and nothing is written (the same settle without the flag still works afterwards)
    const no = cli(['held', 'settle', p.a, '--release', '--reason', 'r', '--if-awaiting'], dir);
    assert.strictEqual(no.status, 1, no.stdout + no.stderr);
    const e = JSON.parse(no.stderr || no.stdout).error;
    assert.deepStrictEqual([e.code, e.detail.awaiting, e.detail.state], ['E_PRECONDITION', false, 'held']);
    assert.ok(!fs.existsSync(dir + '/owner.lock'), 'no owner left behind');
    // b awaits the operator: re-offer works with the flag, and then a second settle with the flag is refused (the re-offer cleared undecided)
    const re = cli(['held', 'settle', p.b, '--reoffer', '--reason', 'look again', '--if-awaiting'], dir);
    assert.strictEqual(re.status, 0, re.stdout + re.stderr);
    assert.strictEqual(JSON.parse(re.stdout).outcome, 'reoffered');
    const twice = cli(['held', 'settle', p.b, '--archive', '--reason', 'again', '--if-awaiting'], dir);
    assert.strictEqual(twice.status, 1, twice.stdout + twice.stderr);
    assert.strictEqual(JSON.parse(twice.stderr || twice.stdout).error.code, 'E_PRECONDITION');
    // without the flag the core allows it, as before
    const plain = cli(['held', 'settle', p.b, '--archive', '--reason', 'wrong for good'], dir);
    assert.strictEqual(plain.status, 0, plain.stdout + plain.stderr);
    assert.strictEqual(JSON.parse(plain.stdout).to, 'archive/acme');
    const rel = cli(['held', 'settle', p.a, '--release', '--reason', 'r'], dir);
    assert.strictEqual(rel.status, 0, rel.stdout + rel.stderr);
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('every usage error exits 2 and prints the usage line', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    plant(dir);
    for (const args of [
      ['held', 'settle'], ['held', 'settle', 'x'], ['held', 'settle', 'x', '--release'], ['held', 'settle', 'x', '--release', '--archive', '--reason', 'r'],
      ['held', 'bogus'], ['held', '--release'], ['held', '--reason', 'r'], ['held', 'settle', 'x', '--release', '--reason', 'r', '--awaiting'], ['held', '--if-awaiting'],
    ]) {
      const r = cli(args, dir, false);
      assert.strictEqual(r.status, 2, args.join(' '));
      assert.match(r.stdout + r.stderr, /belay memory held/);
    }
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('a reason that looks like a flag is the reason, not a flag (the panel passes it as one argv element)', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    const p = plant(dir);
    const r = cli(['held', 'settle', p.a, '--release', '--reason', '--archive -x'], dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.action, j.outcome], ['release', 'released']);
    assert.ok(JSON.stringify(j).includes('--archive -x'), 'the reason is kept whole');
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});

test('a queued hold (a report past its run\'s breaker) is counted and listed apart from the held ones', async () => {
  const dir = sandbox();
  let bodyError = null;
  try {
    plant(dir);
    const store = new Store(`${dir}/memory.db`, { stamp: true });
    const n = store.storeIn({ namespace: 'project/acme', worker_id: 'w1', type: 'note', text: `queued note ${Math.random()}`, title: 'queued note', body: { state: 'live', kind: 'lesson', evidence: [], reported_wrong: [{ by: 'worker:w3', task_id: 't3', at: 6, why: 'wrong', seq: 1, withhold: false }], report_seq: 1 }, run_id: 'r1', source: 'harness', written_by: 'harness' }).id;
    store.storeIn({ namespace: 'held/acme', worker_id: 'w1', type: 'held', text: `held queued ${Math.random()}`, title: 'held queued', body: { state: 'queued', note_id: n, kind: 'wrong', ground: 'reported', reason: 'wrong', rev: 0, reports: [{ key: 's:1', by: 'worker:w3', why: 'wrong', at: 6, withhold: false }], reports_total: 1, reviews: [] }, run_id: 'r1', source: 'harness', written_by: 'harness' });
    store.close();
    const j = JSON.parse(cli(['held'], dir).stdout);
    assert.deepStrictEqual([j.total, j.held, j.queued, j.by_ground.reported, j.queued_by_ground.reported], [3, 2, 1, 2, 1]);
    assert.strictEqual(j.entries.find((e) => e.note_id === n).state, 'queued');
    const text = cli(['held'], dir, false).stdout;
    assert.match(text, /2 held, 1 queued, 1 awaiting the operator/);
    assert.match(text.split('\n').find((l) => l.startsWith(n)), new RegExp(`^${n}  queued  wrong/reported`));
    const P = require('../../src/cli/panel-common.cjs');
    assert.match(P.heldText(j), /^2 held: 2 reported wrong; 1 queued past the breaker; 1 awaits you/);
    assert.match(P.heldText({ ...j, by_ground: {} }), /^2 held, 1 queued for review/);
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
});
