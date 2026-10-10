'use strict';
// ADR 0041 §2: capture fields on tool_use and tool_result, and the proof that capture off changes
// nothing. The off-hashes were taken from the parser at the base commit (Date.now fixed to 1,
// sha256 of JSON.stringify of every event), so they pin the pre-capture output byte for byte.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createParser } = require('../../src/run/parsers.cjs');
const CF = require('../../src/run/capture-fields.cjs');

const lines = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').trim().split('\n');
const ident = (t) => t;

function run(substrate, ls, opts) {
  const p = createParser(substrate, opts);
  const events = [];
  for (const l of ls) for (const e of p.pushLine(l)) events.push(e);
  return events;
}
const hashOf = (events) => crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex');

const OFF_HASHES = {
  'claude-stream.jsonl': ['claude-code', 'fb8f7e6c1bfb6390aa18b8b19666dc674d4142aedb13ed73ab0270fccafb9ada'],
  'codex-stream.jsonl': ['codex', 'b997add34aa0aa029aaf7143695f9be853b8fd3a2ac28fdda15743422c75df75'],
  'capture-claude.jsonl': ['claude-code', '2b393349f3dbf7060eb0a4e51c953c191557492a82d474bfe8efa3d7aaa8d6cf'],
  'capture-codex.jsonl': ['codex', '388fa489c8f9cfe4fe13671d436b1bc3b24d6612a3a61bfbb6dead7b1618faf9'],
};

test('capture off (default, false, or an empty options object) leaves every fixture identical to the base parser', () => {
  const realNow = Date.now;
  Date.now = () => 1;
  try {
    for (const [f, [sub, want]] of Object.entries(OFF_HASHES)) {
      for (const opts of [undefined, {}, { capture: false }]) {
        assert.strictEqual(hashOf(run(sub, lines(f), opts)), want, f + ' ' + JSON.stringify(opts));
      }
    }
  } finally {
    Date.now = realNow;
  }
});

test('capture off adds no capture field to any tool event and keeps no state', () => {
  const p = createParser('claude-code');
  assert.strictEqual(p.capture, null);
  const ev = run('claude-code', lines('capture-claude.jsonl'));
  for (const e of ev.filter((x) => x.kind === 'tool_use' || x.kind === 'tool_result')) {
    for (const k of ['tool_use_id', 'command', 'exit_code', 'exit_code_source', 'head', 'tail', 'files']) assert.ok(!(k in e), k);
  }
});

test('capture on changes only the added fields: the rest of every event is the same', () => {
  for (const [f, [sub]] of Object.entries(OFF_HASHES)) {
    const off = run(sub, lines(f));
    const on = run(sub, lines(f), { capture: true, redact: ident });
    assert.strictEqual(on.length, off.length);
    on.forEach((e, i) => {
      const strip = { ...e, at: 0 };
      if (e.kind === 'tool_use') { delete strip.tool_use_id; delete strip.command; }
      if (e.kind === 'tool_result') for (const k of ['tool_use_id', 'exit_code', 'exit_code_source', 'head', 'tail', 'files', 'redaction']) delete strip[k];
      assert.deepStrictEqual(strip, { ...off[i], at: 0 }, f + ' event ' + i);
    });
  }
});

const results = (ev) => ev.filter((e) => e.kind === 'tool_result');
const uses = (ev) => ev.filter((e) => e.kind === 'tool_use');

test('Claude Code: ids, command, no-error exit 0, reported exit code, files', () => {
  const ev = run('claude-code', lines('capture-claude.jsonl'), { capture: true, redact: ident });
  const u = uses(ev);
  const r = results(ev);
  assert.strictEqual(u[0].tool, 'Bash');
  assert.match(u[0].tool_use_id, /^toolu_/);
  assert.strictEqual(u[0].command, "node -e \"console.log('auto-probe-ok')\"");
  assert.strictEqual(r[0].tool_use_id, u[0].tool_use_id);
  assert.deepStrictEqual([r[0].exit_code, r[0].exit_code_source], [0, 'no-error']);
  assert.strictEqual(r[0].head, 'auto-probe-ok');
  assert.strictEqual(r[0].tail, '');
  // an error that is not a Bash exit has no exit code
  assert.deepStrictEqual([r[1].exit_code, r[1].exit_code_source, r[1].is_error], [null, null, true]);
  assert.deepStrictEqual(r[1].files, [u[1].args.file_path]);
  // reported
  assert.deepStrictEqual([r[2].exit_code, r[2].exit_code_source], [127, 'reported']);
  assert.strictEqual(r[2].head, 'Exit code 127\nl1\nl2');
  assert.strictEqual(r[2].tail, 'l5\nl6\nl7');
  // Edit: tool_use_result.filePath wins; Read: the matching tool_use args
  assert.deepStrictEqual(r[3].files, ['C:/work/a.txt']);
  assert.deepStrictEqual(r[4].files, ['C:/work/b.txt']);
  assert.deepStrictEqual([r[4].exit_code, r[4].exit_code_source], [null, null]);
  assert.ok(Buffer.byteLength(r[4].head) <= CF.MAX_BYTES && Buffer.byteLength(r[4].tail) <= CF.MAX_BYTES);
});

test('Claude Code: a result for an unseen id still parses', () => {
  const ev = run('claude-code', [lines('capture-claude.jsonl')[1]], { capture: true, redact: ident });
  const r = results(ev)[0];
  assert.strictEqual(r.tool, null);
  assert.deepStrictEqual(r.files, []);
  assert.strictEqual(r.exit_code, null);
});

test('Codex: item id, command, reported exit code, null when absent, patch paths', () => {
  const ev = run('codex', lines('capture-codex.jsonl'), { capture: true, redact: ident });
  const u = uses(ev);
  const r = results(ev);
  assert.strictEqual(u[0].tool_use_id, 'item_1');
  assert.match(u[0].command, /Get-Content -LiteralPath input\.md/);
  assert.deepStrictEqual([r[0].tool_use_id, r[0].exit_code, r[0].exit_code_source], ['item_1', 0, 'reported']);
  assert.strictEqual(r[0].head, 'The belay harness is the parent process of every worker.');
  assert.deepStrictEqual([r[1].exit_code, r[1].exit_code_source], [2, 'reported']);
  assert.strictEqual(r[1].head, 'boom\nat x');
  assert.deepStrictEqual([r[2].exit_code, r[2].exit_code_source], [null, null]);
  assert.deepStrictEqual(r[3].files, ['src/a.js', 'src/b.js']);
});

test('head and tail stay within 3 lines and 300 bytes each, on character boundaries', () => {
  const text = Array.from({ length: 10 }, (_, i) => '\u00e9'.repeat(200) + i).join('\n');
  const { head, tail } = CF.headTail(text, ident);
  for (const part of [head, tail]) {
    assert.ok(part.split('\n').length <= 3);
    assert.ok(Buffer.byteLength(part) <= 300);
    assert.ok(!part.includes('\uFFFD'));
  }
  assert.ok(head.startsWith('\u00e9'));
  assert.ok(tail.endsWith('9'));
});

test('capture state does not grow: a result releases its call', () => {
  const p = createParser('claude-code', { capture: true, redact: ident });
  for (const l of lines('capture-claude.jsonl')) p.pushLine(l);
  assert.deepStrictEqual([...p.capture.calls.keys()], ['toolu_orphan']);
});

// Secret-shaped values are assembled at run time so no literal token sits in the repository.
const secret = 'sk' + '-ant-' + 'a'.repeat(40);
const haveRedact = fs.existsSync(path.join(__dirname, '../../src/core/redact.cjs'));

test('head, tail and command are redacted before they leave the parser', { skip: haveRedact ? false : 'src/core/redact.cjs is not present yet' }, () => {
  const out = 'line one ' + secret + '\n' + 'x\n'.repeat(6) + 'last ' + secret;
  const ls = [
    JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -H "x: ' + secret + '"' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: out, is_error: false }] } }),
  ];
  const ev = run('claude-code', ls, { capture: true });
  const all = JSON.stringify([uses(ev)[0].command, results(ev)[0].head, results(ev)[0].tail]);
  assert.ok(!all.includes(secret), all);
  assert.ok(!all.includes('a'.repeat(20)), all);
  assert.strictEqual(results(ev)[0].redaction, 'applied');
});

test('a redactor that throws is not swallowed', () => {
  const ls = [lines('capture-claude.jsonl')[1]];
  assert.throws(() => run('claude-code', ls, { capture: true, redact: () => { throw new Error('boom'); } }), /boom/);
});
