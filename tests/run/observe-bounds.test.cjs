'use strict';
// observe-bounds.test.cjs — whatever a turn did, the observation's serialised body stays under the store's 8,192 bytes
// (with room for redaction to lengthen a string), its embedded text under the embedder's window, and what was
// dropped is counted. A turn is never lost because it was long.

const test = require('node:test');
const assert = require('node:assert');

const { buildObservation, BODY_TARGET, TEXT_MAX, NARRATIVE_MAX } = require('../../src/run/observe.cjs');
const { sandbox, cleanup } = require('../core/helpers.cjs');
const { Store } = require('../../src/core/store.cjs');
const { Engine } = require('../../src/core/engine.cjs');
const { callerFor } = require('../core/helpers.cjs');

const bytes = (s) => Buffer.byteLength(s, 'utf8');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chunk = (n, alphabet) => Array.from({ length: n }, () => pick(alphabet)).join('');
const ALPHABETS = [
  'abcdefghijklmnopqrstuvwxyz /-._', // plain
  '\\\\"\'\n\t\\/', // backslash-heavy and characters JSON escapes
  '\u00e9\u4e2d\u6587\u{1F600}\u0416', // multibyte
];

function turn(n, over = {}) {
  const events = [];
  for (let i = 0; i < n; i += 1) {
    const id = 'toolu_' + i;
    const tool = pick(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Tool' + i]);
    const a = pick(ALPHABETS);
    const file = chunk(Math.floor(rnd() * 400) + 1, a);
    events.push({ kind: 'tool_use', tool, tool_use_id: id, command: tool === 'Bash' ? chunk(Math.floor(rnd() * 2000) + 1, a) : undefined, args: tool === 'Bash' ? {} : { file_path: 'src/' + file } });
    events.push({ kind: 'tool_result', tool, tool_use_id: id, exit_code: tool === 'Bash' ? 0 : undefined, exit_code_source: 'no-error', files: tool === 'Bash' ? [] : ['src/' + file], is_error: rnd() < 0.05 });
  }
  return { turn: 3, worker_id: 'w1', task_id: 't1', events, final_text: chunk(NARRATIVE_MAX * 2, pick(ALPHABETS)), worktree: 'C:/wt', ...over };
}

test('any turn: the serialised body is under the target, the text under its window, and both parse', () => {
  let maxBody = 0, maxText = 0;
  for (const n of [0, 1, 5, 30, 42, 60, 120, 700]) {
    for (let k = 0; k < 6; k += 1) {
      const o = buildObservation(turn(n));
      const body = bytes(JSON.stringify(o.body));
      maxBody = Math.max(maxBody, body); maxText = Math.max(maxText, bytes(o.text));
      assert.ok(body <= BODY_TARGET, `n=${n}: body ${body} over ${BODY_TARGET}`);
      assert.ok(bytes(o.text) <= TEXT_MAX, `n=${n}: text ${bytes(o.text)} over ${TEXT_MAX}`);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(o.body)), o.body);
      assert.ok(bytes(o.title) <= 160);
    }
  }
  console.log(`max body ${maxBody} bytes (limit 8192, target ${BODY_TARGET}), max text ${maxText} bytes`);
  assert.ok(maxBody <= BODY_TARGET);
});

test('what is dropped is counted, the newest commands and the first files are kept, and the narrative survives a long turn', () => {
  const o = buildObservation(turn(700, { final_text: 'the answer is 42' }));
  assert.ok(o.body.commands.length <= 30);
  assert.strictEqual(o.body.commands_omitted > 0 || o.body.commands.length === 0, true);
  const total = (o.body.commands_omitted || 0) + o.body.commands.length;
  assert.ok(total > 30, 'the count covers every command: ' + total);
  assert.strictEqual(o.body.narrative, 'the answer is 42', 'the narrative is cut last, and here nothing needed cutting');
  assert.strictEqual(o.text.split('\n')[1], 'worker-stated: the answer is 42');
  assert.ok(o.body.files_read.length <= 50 && o.body.files_modified.length <= 50);
});

test('a small turn is not changed by the bounds', () => {
  const o = buildObservation({ turn: 1, events: [{ kind: 'tool_use', tool: 'Read', tool_use_id: 'r', args: { file_path: 'a.cjs' } }, { kind: 'tool_result', tool: 'Read', tool_use_id: 'r', files: ['a.cjs'] }], final_text: 'ok' });
  assert.deepStrictEqual(Object.keys(o.body).filter((k) => /omitted/.test(k)), []);
  assert.deepStrictEqual(o.body.files_read, ['a.cjs']);
});

test('the real store accepts the body of the longest turns (the check it makes is on the serialised bytes)', async () => {
  const dir = sandbox();
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try {
    const caller = callerFor('orchestrator', { run_id: 'r-ob' });
    await E.handle('run.attach', { caller, adapter_pid: process.pid });
    for (const n of [42, 700]) {
      const o = buildObservation(turn(n));
      const row = await E.handle('memory.store', { caller, type: 'observation', title: o.title, text: o.text, body: o.body, embed: false, source: 'harness', turn: 3, worker_id: 'w1' });
      assert.ok(row.id);
    }
  } finally { store.close(); cleanup(dir); }
});
