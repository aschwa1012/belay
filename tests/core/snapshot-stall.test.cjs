'use strict';
// snapshot-stall.test.cjs — ADR 0048 decision 6 and 7.1: BELAY_TEST_SNAPSHOT_STALL_MS only makes a snapshot slower.
// Unset or invalid, the PowerShell command is byte-identical to the one without the seam.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');

const ID = require('../../src/core/proc-identity.cjs');

test('stallMs accepts an integer from 1 to 30000 and ignores everything else', () => {
  for (const [raw, want] of [['1', 1], ['1000', 1000], ['30000', 30000], [' 250 ', 250], ['30001', 0], ['0', 0], ['-5', 0], ['1.5', 0], ['abc', 0], ['', 0], ['1e3', 0], ['0x10', 0], [undefined, 0], [null, 0]]) {
    assert.strictEqual(ID.stallMs(raw), want, `stallMs(${JSON.stringify(raw)})`);
  }
});

test('the PowerShell command is byte-identical when the seam is unset or invalid, and only prefixed by a sleep when valid', () => {
  const base = ID.psArgs(0);
  assert.strictEqual(base[3].startsWith('Get-CimInstance'), true);
  for (const raw of [undefined, '', 'abc', '0', '-1', '99999', '2.5']) {
    assert.deepStrictEqual(ID.psArgs(ID.stallMs(raw)), base, `invalid value ${JSON.stringify(raw)} changed the command`);
  }
  const slow = ID.psArgs(ID.stallMs('1000'));
  assert.deepStrictEqual(slow.slice(0, 3), base.slice(0, 3));
  assert.strictEqual(slow[3], `Start-Sleep -Milliseconds 1000; ${base[3]}`, 'the seam can only add a sleep in front');
});

test('with BELAY_TEST_SNAPSHOT_STALL_MS=1000 a real snapshot takes at least 1000 ms and still parses', { skip: !ID.IS_WINDOWS && 'snapshots are Windows only' }, async () => {
  const code = 'const ID = require(process.argv[1]); const t0 = Date.now(); ID.processSnapshot().then((m) => process.stdout.write(JSON.stringify({ ms: Date.now() - t0, size: m ? m.size : 0, own: m ? m.has(process.pid) : false })));';
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', code, require.resolve('../../src/core/proc-identity.cjs')], { env: { ...process.env, BELAY_TEST_SNAPSHOT_STALL_MS: '1000' }, timeout: 40000 }, (e, stdout) => (e ? reject(e) : resolve(JSON.parse(stdout))));
  });
  assert.ok(out.ms >= 1000, `the stalled snapshot took ${out.ms} ms`);
  assert.ok(out.size > 0 && out.own, `the snapshot did not parse: ${JSON.stringify(out)}`);
});
