'use strict';
require('../helpers/tmp.cjs');
// wake-mod-delivery.test.cjs — the wake mod's delivered-wakes file (ADR 0037 amendment 5 decision 7): an unreadable file is never
// "nothing delivered" (a replay would submit every retained wake twice and the next write would wipe the record), and a wake whose
// record write fails stays pending and is retried until the write lands, though the stream stays open. The real hook
// (src/mod/hooks/wake/index.ts) runs over a fake `$` with a clock the test fires by hand: no sleeps.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake').split('\\').join('/')}`;
const RUNFILE = JSON.stringify({ role: 'orchestrator', run_id: 'r1', data_dir: 'C:/d', belay_cli: 'C:/x/belay.cjs', node: 'C:/n/node.exe', orchestrator_dir: 'C:/o', wake_nonce: 'n1' });
const DELIV = 'C:/o/wakes-delivered.jsonl';
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
const missing = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
const flush = async () => { for (let i = 0; i < 20; i += 1) { for (let j = 0; j < 50; j += 1) await Promise.resolve(); await new Promise((r) => setImmediate(r)); } };

function makeStream() {
  const q = []; let wake = null; let closed = false;
  return {
    push(text) { q.push({ stream: 'stdout', text }); if (wake) { const w = wake; wake = null; w(); } },
    close() { closed = true; if (wake) { const w = wake; wake = null; w(); } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (q.length) { yield q.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

// readFails: how many reads of the delivered file reject with EBUSY before one works (Infinity: all). writeFails: the same for writes of it.
async function run({ file, readFails = 0, writeFails = 0, lines }) {
  const files = { 'C:/copy/belay-run.json': RUNFILE };
  if (file !== undefined) files[DELIV] = file;
  const submits = []; const delivWrites = []; const timers = []; let spawns = 0; let reads = 0; let writes = 0;
  const stream = makeStream();
  const $ = {
    plugin: { root: 'C:/copy' },
    fs: {
      async read(p) {
        if (p === DELIV) { reads += 1; if (reads <= readFails) throw busy(); }
        if (p in files) return files[p];
        throw missing();
      },
      async write(p, c) {
        if (p === DELIV) { writes += 1; if (writes <= writeFails) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); delivWrites.push(c); }
        files[p] = c;
      },
    },
    prompt: { async submit({ text }) { submits.push(text); } },
    process: { spawn() { spawns += 1; return stream; } },
    clock: { after(ms, fn) { timers.push({ ms, fn }); } },
  };
  const { registerWake } = await import(`${MOD}/index.ts`);
  let hook;
  registerWake((ev, matcher, fn) => { hook = fn; });
  await hook($, { cwd: 'C:/w' }, async () => ({}));
  await flush();
  for (const l of lines || []) stream.push(`${l}\n`);
  await flush();
  // Fires the earliest due timer, at most `n` times, letting the hook run after each.
  const fire = async (n) => { for (let i = 0; i < n && timers.length; i += 1) { timers.sort((a, b) => a.ms - b.ms); timers.shift().fn(); await flush(); } };
  return { submits, delivWrites, files, fire, stream, stats: () => ({ spawns, reads, writes, timers: timers.length }) };
}

const prior = '{"id":"A","at":1}\n{"id":"B","at":2}\n{"id":"Z","at":0}\n';
const replay = ['{"id":"A","text":"wake A"}', '{"id":"B","text":"wake B"}'];

test('an unreadable delivered file delivers nothing and writes nothing, however often it is retried', async () => {
  const h = await run({ file: prior, readFails: Infinity, lines: replay });
  await h.fire(8);
  assert.deepStrictEqual(h.submits, [], 'no wake is submitted twice on the strength of a failed read');
  assert.deepStrictEqual(h.delivWrites, [], 'the earlier record is never overwritten');
  assert.strictEqual(h.files[DELIV], prior);
  assert.strictEqual(h.stats().spawns, 0, 'no stream is started either');
  h.stream.close();
});

test('a transient read error is retried briefly: the file is then read, so the replay is skipped and new wakes still go out', async () => {
  const h = await run({ file: prior, readFails: 2, lines: [...replay, '{"id":"C","text":"wake C"}'] });
  await h.fire(8);
  assert.deepStrictEqual(h.submits, ['wake C'], 'A and B were delivered before: only C is new');
  assert.strictEqual(h.delivWrites.length, 1);
  assert.ok(h.files[DELIV].startsWith(prior), 'the new line is appended to the earlier record');
  assert.match(h.files[DELIV].slice(prior.length), /^\{"id":"C","at":\d+\}\n$/);
  h.stream.close();
});

test('a missing file is the one case that means nothing was delivered', async () => {
  const h = await run({ lines: ['{"id":"A","text":"wake A"}'] });
  await h.fire(2);
  assert.deepStrictEqual(h.submits, ['wake A']);
  h.stream.close();
});

test('a failed first write keeps the wake pending and retries it while the stream stays open', async () => {
  const h = await run({ writeFails: 1, lines: ['{"id":"A","text":"wake A"}', '{"hb":1}', '{"hb":2}'] });
  assert.deepStrictEqual(h.submits, [], 'not submitted before its record is written');
  await h.fire(3);
  assert.deepStrictEqual(h.submits, ['wake A'], 'submitted once the write lands');
  assert.match(h.files[DELIV], /^\{"id":"A","at":\d+\}\n$/);
  await h.fire(3);
  assert.deepStrictEqual(h.submits, ['wake A'], 'and only once');
  h.stream.close();
});

test('a write that keeps failing keeps being retried, a replayed line adds no duplicate, and later wakes are not blocked for good', async () => {
  const h = await run({ writeFails: 3, lines: ['{"id":"A","text":"wake A"}'] });
  h.stream.push('{"id":"A","text":"wake A"}\n');
  await flush();
  await h.fire(10);
  assert.deepStrictEqual(h.submits, ['wake A']);
  h.stream.push('{"id":"C","text":"wake C"}\n');
  await flush();
  assert.deepStrictEqual(h.submits, ['wake A', 'wake C']);
  h.stream.close();
});
