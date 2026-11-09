'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
require('../helpers/tmp.cjs'); // every test process gets its own tmp dir and cleanup, however it is run
// turn-rows-lever.test.cjs — the turn_rows lever: a turn row (type 'turn') is written only when it is true; the default writes none.

const test = require('node:test');
const assert = require('node:assert');

const TR = require('../../src/run/turn-record.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const { parseMemoryBlock } = require('../../src/core/memory-levers.cjs');

async function turn(levers) {
  const stored = [];
  const ctx = { core: { memory: { store: async (a) => { stored.push(a.type); return { id: 'm' + stored.length }; } } }, shutdownFlags: { closed: false }, memoryLevers: levers };
  const w = { id: 'w1', taskId: 't1', substrate: 'claude-code', pid: 1, turns: 1, costUsd: 0, lastTurnUsage: null, lastAssistantText: 'done' };
  TR.queueMemory(w, { kind: 'turn_end', text: 'done' }, ctx, 4000, null);
  await w.memoryQueue;
  return stored;
}

test('turn_rows is a memory lever that defaults to false', () => {
  assert.strictEqual(DEFAULTS.turn_rows, false);
  assert.strictEqual(parseMemoryBlock({ turn_rows: true }).value.turn_rows, true);
  assert.match(parseMemoryBlock({ turn_rows: 'yes' }).error, /memory\.turn_rows must be true or false/);
});

test('no turn row is written by default, with levers or without', async () => {
  assert.deepStrictEqual(await turn({ ...DEFAULTS }), []);
  assert.deepStrictEqual(await turn(null), []);
});

test('turn_rows true writes the turn row', async () => {
  assert.deepStrictEqual(await turn({ ...DEFAULTS, turn_rows: true }), ['turn']);
});

test('a replace restart with turn_rows off still carries the last turns, from the worker\'s own record; with it on the rows stand', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { restartFirstText } = require('../../src/run/restart.cjs');
  for (const rows of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-turnrows-'));
    try {
      const levers = { ...DEFAULTS, turn_rows: rows };
      const ctx = { core: { memory: { store: async () => ({ id: 'm' }) } }, shutdownFlags: { closed: false }, memoryLevers: levers };
      const w = { id: 'w1', taskId: 't1', dir, turns: 0, costUsd: 0, lastTurnUsage: null, streamPath: dir.split(path.sep).join('/') + '/stream.jsonl' };
      for (const text of ['first turn text', 'the last turn text']) {
        w.turns += 1; w.lastAssistantText = text;
        TR.queueMemory(w, { kind: 'turn_end', text }, ctx, 4000, null);
      }
      await w.memoryQueue;
      const core = { continuity: { resumeDoc: async () => ({ text: '# resume\n' }), resumeLine: async () => ({ text: 'LINE' }) } };
      await restartFirstText(w, 'replace', { core, ctx: { ...ctx, core } });
      const md = fs.readFileSync(path.join(dir, 'resume.md'), 'utf8');
      assert.strictEqual(md.includes('- [w1] the last turn text'), !rows, `turn_rows ${rows}`);
      assert.strictEqual(md.includes('- [w1] first turn text'), !rows);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a restart in a new adapter process (no in-memory turns) reads the last turns from the tail of the stream file, bounded', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { restartFirstText } = require('../../src/run/restart.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-turnrows-'));
  try {
    const streamPath = dir.split(path.sep).join('/') + '/stream.jsonl';
    const lines = [JSON.stringify({ type: 'system', subtype: 'init', pad: 'x'.repeat(300000) })];
    for (let i = 1; i <= 14; i += 1) lines.push(JSON.stringify({ type: 'result', result: `answer ${i} ${'y'.repeat(400)}` }));
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');
    const w = { id: 'w1', taskId: 't1', dir, streamPath };
    const core = { continuity: { resumeDoc: async () => ({ text: '# resume\n' }), resumeLine: async () => ({ text: 'LINE' }) } };
    await restartFirstText(w, 'replace', { core, ctx: { core, memoryLevers: { ...DEFAULTS } } });
    const md = fs.readFileSync(path.join(dir, 'resume.md'), 'utf8');
    const got = md.split('\n').filter((l) => l.startsWith('- [w1] '));
    assert.ok(got.length >= 4 && got.length <= 10, 'the newest turns that fit the section cap');
    assert.ok(got[got.length - 1].startsWith('- [w1] answer 14 '), 'the newest turn is kept, oldest first');
    assert.ok(got.every((l) => l.length <= 160 + '- [w1] '.length), 'each clipped to 160 characters');
    assert.ok(Buffer.byteLength(md) - Buffer.byteLength('# resume\n') <= 1024, 'the section is within its own 1,024 byte cap, on top of the document');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
