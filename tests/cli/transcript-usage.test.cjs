'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, sessionFileOf, PRICES } = require('../../src/cli/transcript-usage.cjs');
const { fillFromTranscript } = require('../../src/cli/cmd-agents.cjs');

const FIX = path.join(__dirname, '..', 'fixtures', 'transcript-usage', 'session.jsonl');
const RATES = { 'test-model-a': { input: 10, output: 100, cache_read: 1, cache_write_5m: 20, cache_write_1h: 40 } }; // a test rate, not a real one
// The reader only opens files under the Claude projects directory; tests name the directory their file is in.
const RU = (f, prices, root) => readUsage(f, prices, { projectsRoot: root || path.dirname(f) });
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const asst = (id, model, u, extra = {}) => `${JSON.stringify({ type: 'assistant', ...extra, message: { model, id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })}\n`;

// One message with the split cache writes; the same tokens priced per model, summed by hand below.
const one = (model, u, split = true) => {
  const usage = { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] + u[4] };
  if (split) usage.cache_creation = { ephemeral_5m_input_tokens: u[3], ephemeral_1h_input_tokens: u[4] };
  return `${JSON.stringify({ type: 'assistant', message: { model, id: `m-${model}`, usage } })}
`;
};
const usdOf = (t, model, u, split) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, one(model, u, split));
  return RU(f);
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const TOK = [1000, 2000, 10000, 3000, 5000]; // input, output, cache_read, cache_5m, cache_1h

test('shipped rates: opus 5.5, hand-computed', (t) => { // 4000 + 40000 + 2000 + 15000 + 40000 = 101000 / 1e6
  const u = usdOf(t, 'claude-opus-5-5', TOK);
  near(u.cost_usd, 0.101);
  assert.strictEqual(u.cache_write_assumed_5m, 0);
});
test('shipped rates: sonnet 5.5, hand-computed', (t) => { near(usdOf(t, 'claude-sonnet-5-5', TOK).cost_usd, 0.0515); }); // 2000 + 20000 + 2000 + 7500 + 20000
test('shipped rates: fable 5.1, hand-computed', (t) => { near(usdOf(t, 'claude-fable-5-1', TOK).cost_usd, 0.25); }); // 10000 + 100000 + 2500 + 37500 + 100000
test('shipped rates: haiku 5.5 small prompt (19000 tokens)', (t) => { near(usdOf(t, 'claude-haiku-5-5', TOK).cost_usd, 0.002575); }); // 100 + 1000 + 100 + 375 + 1000
test('shipped rates: haiku 5.5 large prompt (159000 tokens), the higher tier', (t) => { // 500 + 5000 + 7500 + 1875 + 5000
  near(usdOf(t, 'claude-haiku-5-5', [1000, 2000, 150000, 3000, 5000]).cost_usd, 0.019875);
});
test('haiku tier boundary: 100000 prompt tokens is the low tier, 100001 the high', (t) => {
  near(usdOf(t, 'claude-haiku-5-5', [100000, 0, 0, 0, 0]).cost_usd, 0.01);
  near(usdOf(t, 'claude-haiku-5-5', [100001, 0, 0, 0, 0]).cost_usd, 0.0500005);
});
test('no 5m/1h split: all cache writes at the 5m rate, and the result says so', (t) => { // 8000 * 5 / 1e6
  const u = usdOf(t, 'claude-opus-5-5', [0, 0, 0, 3000, 5000], false);
  near(u.cost_usd, 0.04);
  assert.strictEqual(u.cache_write_assumed_5m, 1);
});
test('alias names and unlisted ids stay unpriced', (t) => {
  for (const m of ['opus', 'sonnet', 'claude-opus-5-5-x']) assert.strictEqual(usdOf(t, m, TOK).cost_usd, null, m);
});
test('a replaced id is re-priced, not added twice (haiku across the tier line)', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, one('claude-haiku-5-5', [1000, 1, 0, 0, 0]) + one('claude-haiku-5-5', [1000, 2000, 150000, 0, 0]));
  near(RU(f).cost_usd, (1000 * 0.5 + 2000 * 2.5 + 150000 * 0.05) / 1e6);
});

test('dedup by message.id (last line wins), sidechain and synthetic skipped for context', () => {
  const u = RU(FIX, RATES);
  assert.strictEqual(u.messages, 3); // msg_1 once, msg_side, msg_2; synthetic never counted
  assert.deepStrictEqual(u.tokens, { input: 12, output: 103, cache_read: 1000, cache_creation: 1200 });
  assert.strictEqual(u.context_tokens, 1203); // msg_2: 3 + 200 + 1000, not the sidechain's
  assert.strictEqual(u.model_seen, 'test-model-a');
  assert.strictEqual(u.cost_usd, (12 * 10 + 103 * 100 + 1000 * 1 + 1200 * 20) / 1e6);
});

test('unknown model: tokens and context, no dollars', () => {
  const u = RU(FIX);
  assert.strictEqual(u.cost_usd, null);
  assert.deepStrictEqual(u.unpriced_models, ['test-model-a']);
  assert.strictEqual(u.context_tokens, 1203);
});

test('a partial last line is left alone and counted once it completes', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  const whole = asst('m1', 'test-model-a', [1, 2, 3, 4]);
  const second = asst('m2', 'test-model-a', [10, 20, 30, 40]);
  fs.writeFileSync(f, whole + second.slice(0, 40));
  const u1 = RU(f);
  assert.strictEqual(u1.messages, 1);
  assert.strictEqual(u1.context_tokens, 6);
  fs.writeFileSync(f, whole + second);
  const u2 = RU(f);
  assert.strictEqual(u2.messages, 2);
  assert.strictEqual(u2.context_tokens, 60);
});

test('a missing file reads as nothing, throws nothing and creates nothing', (t) => {
  const d = tmp(t);
  const u = RU(path.join(d, 'nope.jsonl'), undefined, d);
  assert.strictEqual(u.exists, false);
  assert.strictEqual(u.refused, null);
  assert.strictEqual(u.context_tokens, null);
  assert.strictEqual(u.cost_usd, null);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('a transcript mixing a priced and an unpriced model has no dollar figure', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, one('claude-opus-5-5', TOK) + one('opus', TOK));
  const u = RU(f);
  assert.strictEqual(u.cost_usd, null);
  assert.deepStrictEqual(u.unpriced_models, ['opus']);
  assert.strictEqual(u.messages, 2);
});

test('a path that is not a plain .jsonl file under the projects directory is refused and nothing is opened', (t) => {
  const root = tmp(t);
  const outside = tmp(t);
  fs.writeFileSync(path.join(root, 'plain.txt'), asst('m1', 'test-model-a', [1, 1, 1, 1]));
  fs.writeFileSync(path.join(outside, 's.jsonl'), asst('m1', 'test-model-a', [1, 1, 1, 1]));
  fs.mkdirSync(path.join(root, 'dir.jsonl'));
  const opened = [];
  const real = fs.openSync;
  fs.openSync = (...a) => { opened.push(String(a[0])); return real(...a); };
  try {
    const cases = {
      pipe: '//./pipe/belay-test-pipe.jsonl', pipe_no_ext: '//./pipe/belay-test-pipe', directory: path.join(root, 'dir.jsonl'),
      not_jsonl: path.join(root, 'plain.txt'), outside: path.join(outside, 's.jsonl'), dotdot: path.join(root, '..', path.basename(outside), 's.jsonl'),
    };
    for (const [name, file] of Object.entries(cases)) {
      const u = readUsage(file, undefined, { projectsRoot: root });
      assert.ok(u.refused, `${name} was not refused`);
      assert.strictEqual(u.exists, false, name);
      assert.strictEqual(u.messages, 0, name);
    }
  } finally { fs.openSync = real; }
  assert.deepStrictEqual(opened, [], 'a refused path was opened');
});

test('sessionFileOf: the launch marker names the file; another run or epoch does not', (t) => {
  const d = tmp(t);
  const run = { id: 'r1', epoch: 2 };
  const opts = { projectsRoot: path.dirname(FIX) };
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', mode: 'interactive', epoch: 2, session_id: 's', session_file: FIX }));
  assert.strictEqual(sessionFileOf(d, run, opts).file, FIX);
  assert.strictEqual(sessionFileOf(d, { id: 'r1', epoch: 1 }, opts).file, null);
  fs.rmSync(`${d}/run-start.json`);
  fs.writeFileSync(`${d}/run.json`, JSON.stringify({ run_id: 'r1', orchestrator: { interactive: { session_file: FIX } } }));
  assert.strictEqual(sessionFileOf(d, run, opts).file, FIX);
});

test('sessionFileOf: a marker pointing at a pipe is refused without a look at it', (t) => {
  const d = tmp(t);
  const probed = [];
  const real = { exists: fs.existsSync, stat: fs.statSync };
  fs.existsSync = (p) => { probed.push(String(p)); return real.exists(p); };
  fs.statSync = (p, ...a) => { probed.push(String(p)); return real.stat(p, ...a); };
  try {
    fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', mode: 'interactive', epoch: 1, session_file: '//./pipe/planted.jsonl' }));
    probed.length = 0;
    const r = sessionFileOf(d, { id: 'r1', epoch: 1 }, { projectsRoot: path.join(d, 'projects') });
    assert.strictEqual(r.file, null);
    assert.match(r.refused[0], /not under the Claude projects directory/);
    assert.ok(!probed.some((p) => p.includes('pipe')), `the pipe path was probed: ${probed}`);
  } finally { fs.existsSync = real.exists; fs.statSync = real.stat; }
});

test('agents row: tokens from the transcript, "no rate" note for an unknown model, row untouched when no transcript', (t) => {
  const d = tmp(t);
  const opts = { projectsRoot: path.dirname(FIX) };
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', mode: 'interactive', epoch: 1, session_file: FIX }));
  const row = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(row, d, { id: 'r1', epoch: 1 }, opts);
  assert.strictEqual(row.context_tokens, 1203);
  assert.strictEqual(row.cost_usd, null);
  assert.match(row.cost_note, /no rate for test-model-a/);
  assert.match(row.cost_note, /\/clear starts a new one that is not followed/);
  assert.strictEqual(row.transcript_usage.messages, 3);
  const bare = { context_tokens: null, cost_usd: null };
  fillFromTranscript(bare, tmp(t), { id: 'r1', epoch: 1 }, opts);
  assert.deepStrictEqual(bare, { context_tokens: null, cost_usd: null });
  const streamed = { context_tokens: 99, cost_usd: 1.5 }; // the stream already gave usage: the transcript is not consulted
  fillFromTranscript(streamed, d, { id: 'r1', epoch: 1 }, opts);
  assert.deepStrictEqual(streamed, { context_tokens: 99, cost_usd: 1.5 });
});

test('agents row: a marker outside the projects directory gives n/a and says why', (t) => {
  const d = tmp(t);
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', mode: 'interactive', epoch: 1, session_file: FIX }));
  const row = { context_tokens: null, cost_usd: null };
  fillFromTranscript(row, d, { id: 'r1', epoch: 1 }, { projectsRoot: path.join(d, 'elsewhere') });
  assert.strictEqual(row.context_tokens, null);
  assert.match(row.cost_note, /session transcript not read: .*not under the Claude projects directory/);
});

test('agents row: a priced model gets an estimated cost marked as transcript API rates, with the /clear caveat', (t) => {
  const d = tmp(t);
  const f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, one('claude-opus-5-5', TOK));
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', mode: 'interactive', epoch: 1, session_file: f }));
  const row = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(row, d, { id: 'r1', epoch: 1 }, { projectsRoot: d });
  near(row.cost_usd, 0.101);
  assert.strictEqual(row.cost_basis, 'transcript, API rates');
  assert.match(row.cost_source, /estimate/);
  assert.match(row.cost_source, /\/clear starts a new one that is not followed/);
});

// Record every call that could follow a link (stat, open, exists, read) with its path argument.
function watchFollowers() {
  const calls = [];
  const names = ['statSync', 'openSync', 'existsSync', 'readFileSync'];
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = (p, ...a) => { calls.push([n, String(p)]); return real[n](p, ...a); };
  return { calls, restore: () => { for (const n of names) fs[n] = real[n]; } };
}

test('a link at the file or at its directory is refused and its target is never stat-ed, opened or read', (t) => {
  const root = tmp(t);
  const outside = tmp(t);
  const target = path.join(outside, 's.jsonl');
  fs.writeFileSync(target, asst('m1', 'test-model-a', [1, 1, 1, 1]));
  fs.symlinkSync(outside, path.join(root, 'linkdir'), 'junction'); // a directory junction needs no privilege
  const links = { dir: path.join(root, 'linkdir', 's.jsonl') };
  try { fs.symlinkSync(target, path.join(root, 'link.jsonl'), 'file'); links.file = path.join(root, 'link.jsonl'); } catch { /* file symlinks need a privilege this host may not grant */ }
  const w = watchFollowers();
  try {
    for (const [name, file] of Object.entries(links)) {
      const u = readUsage(file, undefined, { projectsRoot: root });
      assert.ok(u.refused, `${name} link was not refused`);
      assert.ok(u.refused.includes(`checked ${root}`), u.refused);
      assert.strictEqual(u.messages, 0);
    }
  } finally { w.restore(); }
  assert.deepStrictEqual(w.calls.filter(([, p]) => p.includes('linkdir') || p.includes('link.jsonl') || p.includes(path.basename(outside))), [], 'a link or its target was followed');
});

test('the opened file must be the checked file: a different inode at open is refused', (t) => {
  const root = tmp(t);
  const f = path.join(root, 's.jsonl');
  fs.writeFileSync(f, asst('m1', 'test-model-a', [1, 1, 1, 1]));
  assert.strictEqual(readUsage(f, undefined, { projectsRoot: root }).messages, 1);
  const real = fs.fstatSync;
  fs.fstatSync = (fd, o) => { const s = real(fd, o); return o && o.bigint ? { ino: s.ino + 1n, dev: s.dev, isFile: () => true, size: s.size } : s; };
  try {
    const u = readUsage(f, undefined, { projectsRoot: root });
    assert.match(u.refused, /changed between the check and the open/);
    assert.strictEqual(u.messages, 0);
  } finally { fs.fstatSync = real; }
});

test('a link at the file itself (lstat says so) is refused before anything follows it', (t) => {
  const root = tmp(t);
  const f = path.join(root, 'l.jsonl');
  fs.writeFileSync(f, asst('m1', 'test-model-a', [1, 1, 1, 1]));
  const realL = fs.lstatSync; // a file symlink needs a privilege some hosts lack, so lstat reports one for this path
  fs.lstatSync = (p, ...a) => (path.resolve(String(p)) === path.resolve(f) ? { isSymbolicLink: () => true, isFile: () => false } : realL(p, ...a));
  const w = watchFollowers();
  try {
    const u = readUsage(f, undefined, { projectsRoot: root });
    assert.match(u.refused, /is a link \(checked /);
  } finally { w.restore(); fs.lstatSync = realL; }
  assert.deepStrictEqual(w.calls.filter(([, p]) => p.includes('l.jsonl')), [], 'the link was followed');
});

// ---- the real epoch sequence, and the cache timer -------------------------------------------------

const { openCore } = require('../../src/core/index.cjs');

const tline = (id, model, ts, usage, extra = {}) => `${JSON.stringify({ type: 'assistant', uuid: `u-${id}-${ts}`, timestamp: ts, ...extra, message: { model, id, usage } })}\n`;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

test('the real sequence: the launcher attaches (epoch 1, the marker), the orchestrator adapter attaches (epoch 2), and the row still gets usage, cost and cache', async (t) => {
  const d = tmp(t);
  const dataDir = `${d}/.belay`;
  const RUN = 'run-live';
  const launcher = await openCore({ dataDir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  let row;
  try {
    const first = await launcher.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(first.epoch ?? first.run.epoch, 1);
    fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: RUN, epoch: 1, mode: 'interactive', started_at: 1, launcher_pid: 1, session_id: 's', session_file: path.join(d, 's.jsonl') }));
    const adapter = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try {
      const second = await adapter.run.attach({ adapter_pid: process.pid });
      assert.strictEqual(second.epoch ?? second.run.epoch, 2, 'the adapter attach bumps the epoch past the marker');
      row = (await adapter.run.list({})).runs.find((r) => r.id === RUN);
    } finally { await adapter.close(); }
  } finally { await launcher.shutdownOwner(); await launcher.close(); }
  assert.strictEqual(row.epoch, 2);
  fs.writeFileSync(path.join(d, 's.jsonl'), tline('m1', 'claude-opus-5-5', '2026-10-23T11:59:00.000Z', { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 8000, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 5000 } }));
  const orch = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(orch, d, row, { projectsRoot: d, now: NOW });
  assert.strictEqual(orch.context_tokens, 19000);
  near(orch.cost_usd, 0.101);
  assert.strictEqual(orch.cache.state, 'warm');
});

test('a marker ahead of the row, or one that does not say interactive, is not this run\'s', (t) => {
  const d = tmp(t);
  const f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, tline('m1', 'claude-opus-5-5', '2026-10-23T11:59:00.000Z', { input_tokens: 1, output_tokens: 1 }));
  const row = { id: 'r', epoch: 2 };
  const put = (m) => fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r', mode: 'interactive', session_file: f, ...m }));
  put({ epoch: 2 }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, f);
  put({ epoch: 1 }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, f);
  put({ epoch: 3 }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, null);
  put({ epoch: 1, mode: 'headless' }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, null);
  put({ epoch: '1' }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, null);
  put({ epoch: 1, run_id: 'other' }); assert.strictEqual(sessionFileOf(d, row, { projectsRoot: d }).file, null);
});

const cacheOfLines = (t, text) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 's.jsonl'), text);
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r', epoch: 1, mode: 'interactive', session_file: path.join(d, 's.jsonl') }));
  const orch = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(orch, d, { id: 'r', epoch: 1 }, { projectsRoot: d, now: NOW });
  return orch.cache;
};
const U = (cc, extra = {}) => ({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: cc ? (cc.ephemeral_1h_input_tokens || 0) + (cc.ephemeral_5m_input_tokens || 0) : 0, ...(cc ? { cache_creation: cc } : {}), ...extra });

test('cache from the transcript: a 1h write is warm with 3600 s, named by the transcript and the field', (t) => {
  const c = cacheOfLines(t, tline('m1', 'claude-opus-5-5', '2026-10-23T11:59:00.000Z', U({ ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 })));
  assert.strictEqual(c.ttl_s, 3600);
  assert.strictEqual(c.state, 'warm');
  assert.strictEqual(c.age_ms, 60000);
  assert.strictEqual(c.left_ms, 3540000);
  assert.strictEqual(c.last_request_at_ms, Date.parse('2026-10-23T11:59:00.000Z'));
  assert.match(c.ttl_established_by, /message\.usage\.cache_creation\.ephemeral_1h_input_tokens=100 of the session transcript .*s\.jsonl/);
});
test('cache from the transcript: only 5m written gives 300 s', (t) => {
  const c = cacheOfLines(t, tline('m1', 'claude-opus-5-5', '2026-10-23T11:59:00.000Z', U({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50 })));
  assert.strictEqual(c.ttl_s, 300);
  assert.strictEqual(c.left_ms, 240000);
  assert.match(c.ttl_established_by, /ephemeral_5m_input_tokens=50/);
});
test('cache from the transcript: no split means the lifetime stays unknown, never assumed', (t) => {
  const c = cacheOfLines(t, tline('m1', 'claude-opus-5-5', '2026-10-23T11:59:00.000Z', U(null)));
  assert.strictEqual(c.ttl_s, null);
  assert.strictEqual(c.state, 'unknown');
  assert.strictEqual(c.left_ms, null);
  assert.strictEqual(c.last_request_at_ms, Date.parse('2026-10-23T11:59:00.000Z'));
  assert.match(c.ttl_established_by, /lifetime is not assumed/);
});
test('cache from the transcript: an expired entry is cold', (t) => {
  const c = cacheOfLines(t, tline('m1', 'claude-opus-5-5', '2026-10-23T09:00:00.000Z', U({ ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 })));
  assert.strictEqual(c.state, 'cold');
  assert.ok(c.left_ms < 0);
});
test('cache from the transcript: the request time is the first line of the latest message; the lifetime is the latest writer, a later read-only message keeps it', (t) => {
  const w = U({ ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 });
  const zero = U({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 });
  const c = cacheOfLines(t,
    tline('m1', 'claude-opus-5-5', '2026-10-23T11:00:00.000Z', w)
    + tline('m2', 'claude-opus-5-5', '2026-10-23T11:58:00.000Z', zero)
    + tline('m2', 'claude-opus-5-5', '2026-10-23T11:58:30.000Z', zero)
    + tline('s1', 'claude-opus-5-5', '2026-10-23T11:59:50.000Z', w, { isSidechain: true }));
  assert.strictEqual(c.last_request_at_ms, Date.parse('2026-10-23T11:58:00.000Z'), 'first line of m2, not the sidechain, not the later line of m2');
  assert.strictEqual(c.ttl_s, 3600);
});
