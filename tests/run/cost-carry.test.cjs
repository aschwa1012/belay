'use strict';
require('../helpers/tmp.cjs');
// cost-carry.test.cjs — the worker row's cost across launches (src/run/cost-carry.cjs). The model: the substrate saves the session total only at a
// graceful exit, a kill saves nothing, a resume starts from the last saved total. Each sequence must give the true spend, never fall, and survive an adopt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CC = require('../../src/run/cost-carry.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

// One life of a worker: `turns` are the spends of its turns; it ends gracefully (exit 0) or by a kill. `adopt`: a new adapter takes the row over afterwards.
function run(seq) {
  let w = { costUsd: 0, costBase: 0 };
  let truth = 0, saved = 0, last = 0;
  for (const life of seq) {
    if (life.replace) saved = 0;
    CC.arm(w); w.exitCode = null;
    if (life.replace) CC.fresh(w);
    let cur = life.replace ? 0 : saved;
    for (const s of life.turns) { cur += s; truth += s; w.costUsd = CC.total(w, cur); assert.ok(w.costUsd >= last - 1e-12, 'the row never falls'); last = w.costUsd; }
    if (life.end === 'g' || life.end === 'u') saved = cur; // 'u': the adapter died, the worker saw stdin close and exited cleanly, but belay saw no exit code
    w.exitCode = life.end === 'g' ? 0 : life.end === 'u' || life.end === 'uk' ? null : 1; CC.noteExit(w); // 'uk': unknown exit code, and the process was in fact killed
    if (life.adopt) w = { costUsd: w.costUsd, costBase: w.costBase, costSaved: CC.savedOf(w), exitCode: w.exitCode, exitSignal: null }; // what the row records, read back
  }
  return { truth, row: w.costUsd };
}
const G = 'g', K = 'k', U = 'u', UK = 'uk';
const SEQ = {
  'graceful, resume': [{ turns: [0.0347364], end: G }, { turns: [0.0043765], end: G }],
  'kill, resume': [{ turns: [0.0102262], end: K }, { turns: [0.0020085], end: G }],
  'graceful, resume, kill, resume (measured)': [{ turns: [0.0050575], end: G }, { turns: [0.0024199], end: K }, { turns: [0.0009055], end: G }],
  'a carried chain': [{ turns: [1, 1], end: G }, { turns: [0.5], end: G }, { turns: [0.5], end: G }, { turns: [0.2], end: G }],
  'a kill chain with no save': [{ turns: [1], end: K }, { turns: [0.4], end: K }, { turns: [0.3], end: K }],
  'a mixed chain': [{ turns: [1], end: G }, { turns: [0.5], end: K }, { turns: [0.2], end: G }, { turns: [0.1], end: K }, { turns: [0.3], end: G }],
  'a mixed chain that crosses the gap between totals': [{ turns: [1], end: G }, { turns: [0.5], end: K }, { turns: [0.2], end: G }, { turns: [0.3], end: K }, { turns: [0.3], end: G }],
  'a first report of zero': [{ turns: [1], end: G }, { turns: [0, 0.4], end: K }, { turns: [0, 0.1], end: G }],
  'a replace in the middle': [{ turns: [1], end: G }, { turns: [0.5], end: K }, { replace: true, turns: [0.3], end: G }, { turns: [0.2], end: G }],
  'the measured sequence, a new adapter adopting after the kill': [{ turns: [0.0050575], end: G }, { turns: [0.0024199], end: K, adopt: true }, { turns: [0.0009055], end: G }],
  'an adapter dies (exit code unknown, the worker exited cleanly), a new one adopts, resume': [{ turns: [1], end: G }, { turns: [0.5], end: U, adopt: true }, { turns: [0.2], end: G }],
  'two adapter deaths in a row': [{ turns: [1], end: U, adopt: true }, { turns: [0.5], end: U, adopt: true }, { turns: [0.2], end: G }],
  'a new adapter adopting after each life': [{ turns: [1], end: G, adopt: true }, { turns: [0.5], end: K, adopt: true }, { turns: [0.2], end: G, adopt: true }, { turns: [0.1], end: K }],
};
for (const [name, seq] of Object.entries(SEQ)) test(`cost-carry: ${name} gives the true spend`, () => { const r = run(seq); near(r.row, r.truth); });

test('cost-carry: an unknown exit that was in fact a kill can only undercount, by at most the gap', () => {
  const r = run([{ turns: [1], end: G }, { turns: [0.5], end: UK, adopt: true }, { turns: [0.2], end: G }]);
  assert.ok(r.row <= r.truth + 1e-9, 'never over');
  assert.ok(r.truth - r.row <= 0.5 + 1e-9, 'by at most the killed process\'s unsaved spend');
});

test('cost-carry: an operator kill mark means an unknown exit is a kill, and the saved total stands', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cc-km-')).replace(/\\/g, '/');
  try {
    require('../../src/core/kill-mark.cjs').mark(data, 'w1', 77, null);
    const w = { id: 'w1', pid: 77, pidCreated: null, costUsd: 1.5, costBase: 0, costSaved: 1, exitCode: null, exitSignal: null };
    CC.arm(w, data);
    w.costUsd = CC.total(w, 1.3); // restored the graceful total 1 and added 0.3: the killed process's 0.5 is not counted twice
    near(w.costUsd, 1.8);
  } finally { cleanup(data); }
});

test('cost-carry: a first report below the saved total is counted whole, and says so', () => {
  const w = { costUsd: 1, costBase: 0, costSaved: 1 }; // saved 1 by a graceful exit, yet the next process reports 0.2: the model is wrong for it
  CC.arm(w);
  w.costUsd = CC.total(w, 0.2);
  near(w.costUsd, 1.2);
  assert.strictEqual(w.lastError.where, 'cost');
});

test('cost-carry: the graceful total is saved on the row, and a new adapter that adopts it keeps counting exactly', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cost-carry-'));
  const data = d.replace(/\\/g, '/');
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore({ runId: 'run-cc', resumeLineText: 'LINE' });
  const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
  const mk = () => createRunManager({ core, dataDir: data, runId: 'run-cc', paths: { claudeExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const first = mk(); let second = null;
  t.after(async () => { delete process.env.FAKE_COST_BASE; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(d); });
  await first.spawn({ substrate: 'claude-code', worktree: data + '/wt', prompt: 'one', worker_id: 'w1' });
  await first._waitTurn('w1', 20000);
  await first.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 8000 });
  near(core.currentWorker('w1').cost_saved, 0.001, 'the graceful exit saved the first total');
  process.env.FAKE_COST_BASE = '0.001'; // the resume restores it: its first turn reports 0.002
  await first.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  near(core.currentWorker('w1').cost_usd, 0.002, 'carried');
  await first.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
  near(core.currentWorker('w1').cost_saved, 0.001, 'a kill saves nothing: the graceful total stays');
  second = mk(); // a new adapter adopts the row; the resume restores the graceful total again (0.001) and adds its turn
  await second.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  near(core.currentWorker('w1').cost_usd, 0.003, 'true spend: 0.001 + 0.001 + 0.001');
});
