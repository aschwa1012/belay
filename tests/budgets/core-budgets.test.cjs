'use strict';
// core-budgets.test.cjs — the budgets that are measured in process (or inside one fresh child), in the shape of ADR 0018
// amendment 1. They used to sit in the functional suites (tests/core/status.test.cjs, tests/core/redact.test.cjs,
// tests/cli/slice-3a.test.cjs), where `node --test` runs fifteen files at once, so a median taken under that load failed on
// a busy host without a product change. `npm test` runs this directory in its own sequential phase, with nothing else of
// belay's running.
// Each gate samples interleaved: one floor sample (the same timing bracket around an empty body) immediately before every
// subject sample, n rounds, and the assertion is the minimum subject sample above the minimum floor sample. The raw
// wall-clock numbers (min, median, every sample) are printed and written to receipts/core-last.json beside each gate and
// never asserted. The bounds are the ones the suites had: status.get 100 ms, the usage text 50 ms, redact 20 ms for 64 KB.

require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { redact } = require('../../src/core/redact.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const N = 7;

function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-core-budgets-')).split(path.sep).join('/'); }
function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const medianOf = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const receipt = {};
const receiptsDir = path.join(__dirname, 'receipts');

// `floor` and `subject` each return one elapsed ms (the caller keeps its own checks inside `subject`). Round i takes the
// floor first, then the subject, so both see one load window.
async function interleavedInProcess({ floor, subject, n }) {
  const f = [];
  const s = [];
  for (let i = 0; i < n; i += 1) { f.push(await floor()); s.push(await subject(i)); }
  const min = Math.min(...s);
  return { floor: { min: Math.min(...f), median: medianOf(f), samples: f }, subject: { min, median: medianOf(s), samples: s }, over_floor_ms: min - Math.min(...f) };
}

function report(gate, bound, r) {
  const line = { gate, bound_ms: bound, over_floor_ms: r.over_floor_ms, floor: { min: r.floor.min, median: r.floor.median }, subject: { min: r.subject.min, median: r.subject.median } };
  console.log(JSON.stringify(line));
  receipt[gate] = { ...line, floor_samples: r.floor.samples, subject_samples: r.subject.samples };
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, 'core-last.json'), JSON.stringify(receipt, null, 2));
}

function assertGate(gate, bound, r) {
  assert.ok(r.over_floor_ms < bound, `${gate}: min ${r.subject.min.toFixed(2)} ms is ${r.over_floor_ms.toFixed(2)} ms above the floor (min ${r.floor.min.toFixed(3)} ms), over the ${bound} ms budget; `
    + `median ${r.subject.median.toFixed(2)} ms; samples ${r.subject.samples.map((x) => x.toFixed(2)).join(', ')}`);
}

const noop = async () => { const t0 = process.hrtime.bigint(); await Promise.resolve(); return ms(t0); };

test('budgets: status.get adds under 100 ms in process on a real store with no owner, interleaved, and creates no file', async (tcx) => {
  const dir = sandbox();
  tcx.after(() => cleanup(dir));
  const caller = (role) => ({ role, run_id: 'test-run', pid: process.pid });
  // A real store and rows, so the measured path is the copy-then-read one, not an empty directory.
  const o = await openCore({ dataDir: dir, caller: caller('orchestrator'), embed: false });
  try {
    await o.run.attach({ adapter_pid: process.pid });
    await o.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    for (let i = 0; i < 50; i++) await o.memory.store({ namespace: 'bulk', text: `row ${i}`, embedding: [i, 1], embedding_model: 'm', dim: 2 });
  } finally {
    await o.shutdownOwner();
    await o.close();
  }
  const before = fs.readdirSync(dir).sort();
  const c = await openCore({ dataDir: dir, caller: caller('operator'), embed: false });
  try {
    const r = await interleavedInProcess({
      floor: noop,
      subject: async () => { const t0 = process.hrtime.bigint(); await c.status.get({}); return ms(t0); },
      n: N,
    });
    report('status_get_in_process', 100, r);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'the status calls created nothing in the data dir');
    assertGate('status_get_in_process', 100, r);
  } finally { await c.close(); }
});

test('budgets: redacting 64 KB of mixed text adds under 20 ms in process, interleaved', async () => {
  const unit = 'The quick brown fox: see https://example.com/a?b=1 and commit ' + 'a1b2c3d4'.repeat(5)
    + ' plus task-sk-1 key=value, "name": "x" -- ' + 'ey' + 'Jabc not a token\nline two NAME=val\n';
  let text = '';
  while (text.length < 64 * 1024) text += unit;
  redact(text); // warm the regexes: the gate is the steady-state call, as it was
  const r = await interleavedInProcess({
    floor: noop,
    subject: async () => { const t0 = process.hrtime.bigint(); redact(text); return ms(t0); },
    n: 20,
  });
  report('redact_64kb', 20, r);
  assertGate('redact_64kb', 20, r);
});

// The cold cost of requiring the dispatcher and producing its usage text, measured in a fresh child so that no earlier
// require has warmed it. The floor child brackets the require of a node built-in with the same code.
test('budgets: requiring the dispatcher and producing the usage text adds under 50 ms in a fresh process, interleaved', async (tcx) => {
  const dir = sandbox();
  tcx.after(() => cleanup(dir));
  const script = `${dir}/probe.cjs`;
  fs.writeFileSync(script, `
const t0 = process.hrtime.bigint();
const target = process.argv[2];
const mod = require(target);
const text = typeof mod.usage === 'function' ? mod.usage() : 'x';
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
process.stdout.write(JSON.stringify({ ms, length: String(text).length }));
`, 'utf8');
  const child = (target) => {
    const r = spawnSync(process.execPath, [script, target], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.strictEqual(r.status, 0, `probe failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const r = await interleavedInProcess({
    floor: async () => child('node:path').ms,
    subject: async () => { const o = child(CLI); assert.ok(o.length > 0, 'usage produced text'); return o.ms; },
    n: N,
  });
  report('usage_text_fresh_process', 50, r);
  assertGate('usage_text_fresh_process', 50, r);
});
