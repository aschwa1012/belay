'use strict';
// memory-report.test.cjs — `belay memory report <note-id> --reason <text> [--replaced-by <id>]`: a write (it elects an owner, writes, returns the proof and
// leaves no owner behind), exit 0 with the proof, exit 1 on a refusal, exit 2 on a usage error, refused inside a worker. The built CLI as a subprocess
// against a sandbox store.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Store } = require('../../src/core/store.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');
const { teardown } = require('../helpers/teardown.cjs');
const { workerRefusal } = require('../../src/cli/worker-guard.cjs');
const LC = require('../../src/cli/cmd-memory-lifecycle.cjs');
const R = require('../../src/cli/memory-render.cjs');

const cli = (args, dataDir, env = {}) => spawnSync(process.execPath, [CLI, 'memory', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env } });

function plant(dataDir) {
  const store = new Store(`${dataDir}/memory.db`, { stamp: true });
  const put = (ns, type, title) => store.storeIn({ namespace: ns, worker_id: 'w1', type, text: `${title} ${Math.random()}`, title, body: type === 'note' ? { state: 'live', kind: 'lesson', evidence: [], reported_wrong: [] } : {}, run_id: 'r1', source: 'harness', written_by: 'w1' }).id;
  const out = { note: put('project/acme', 'note', 'a live note'), fact: put('project/acme', 'fact', 'a plain fact'), archived: put('archive/acme', 'note', 'an archived note') };
  store.close();
  return out;
}

const withSandbox = async (body) => {
  const dir = sandbox();
  let bodyError = null;
  try { await body(dir); } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => cleanup(dir)]); }
};

test('report elects, holds the note, returns the proof (exit 0) and leaves no owner behind', async () => {
  await withSandbox(async (dir) => {
    const p = plant(dir);
    const r = cli(['report', p.note, '--reason', 'the operator saw it fail'], dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.id, j.state, j.hold.kind, j.held.body.state, j.held.body.ground], [p.note, 'held', 'wrong', 'held', 'reported']);
    assert.strictEqual(j.reported_by, 'operator');
    assert.ok(Number.isInteger(j.row.body.reported_wrong[0].operator_pid), 'the checked pid is kept for the record');
    assert.strictEqual(j.held.written_by, 'harness');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'no owner left behind');
    const again = JSON.parse(cli(['report', p.note, '--reason', 'a better reason'], dir).stdout);
    assert.deepStrictEqual([again.state, again.hold.row], ['already_held', j.hold.row], 'a second report joins the same hold (each command is its own operator process, so its own reporter)');
    const text = cli(['report', p.note, '--reason', 'and again'], dir);
    assert.strictEqual(text.status, 0);
  });
});

test('report: a fact, an archived note and a missing note are refused with exit 1; nothing is written', async () => {
  await withSandbox(async (dir) => {
    const p = plant(dir);
    for (const id of [p.fact, p.archived, 'no-such-note']) {
      const r = cli(['report', id, '--reason', 'x'], dir);
      assert.strictEqual(r.status, 1, `${id}: ${r.stdout}${r.stderr}`);
      const code = JSON.parse(r.stderr).error.code;
      assert.ok(code === 'E_ARGS' || code === 'E_NOT_FOUND', code);
    }
    const store = new Store(`${dir}/memory.db`, { stamp: true });
    try { assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held'").get().n, 0); } finally { store.close(); }
  });
});

test('report: usage errors exit 2 before any store is opened', async () => {
  await withSandbox(async (dir) => {
    for (const args of [['report'], ['report', 'n1'], ['report', 'n1', '--reason', '  '], ['report', 'n1', '--reason', 'x', '--replaced-by'], ['report', 'n1', 'n2', '--reason', 'x'], ['report', 'n1', '--reason', 'x', '--nope']]) {
      const r = cli(args, dir);
      assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    assert.ok(!fs.existsSync(`${dir}/memory.db`), 'no file created');
  });
});

test('report is a write: classified in the lifecycle writes and refused inside a worker', () => {
  const argv = ['report', 'n1', '--reason', 'x'];
  assert.strictEqual(LC.writes(R.parseArgs(argv)), true);
  const refusal = workerRefusal({ name: 'memory', mode: 'R', argv, env: { BELAY_WORKER_ID: 'w9' } });
  assert.match(refusal, /refused/);
  assert.strictEqual(workerRefusal({ name: 'memory', mode: 'R', argv, env: {} }), null);
});

test('report inside a worker environment is refused by the built CLI (exit nonzero, no store touched)', async () => {
  await withSandbox(async (dir) => {
    const p = plant(dir);
    const r = cli(['report', p.note, '--reason', 'x'], dir, { BELAY_WORKER_ID: 'w9' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /refused/);
    const store = new Store(`${dir}/memory.db`, { stamp: true });
    try { assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held'").get().n, 0); } finally { store.close(); }
  });
});

test('three CLI reports on one note are one reporter: reports_total 1, the latest reason wins', async () => {
  await withSandbox(async (dir) => {
    const p = plant(dir);
    let last;
    for (const why of ['first', 'second', 'third']) { last = cli(['report', p.note, '--reason', why], dir); assert.strictEqual(last.status, 0, last.stdout + last.stderr); }
    const j = JSON.parse(last.stdout);
    assert.deepStrictEqual([j.reports, j.held.body.reports.length, j.held.body.reports_total, j.held.body.reports[0].why], [1, 1, 1, 'third']);
  });
});
