'use strict';
require('../helpers/tmp.cjs');
// proc-gone.cjs heldAmong / identifyTree: a set is judged from one snapshot and by identity, not by pid number.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const G = require('../helpers/proc-gone.cjs');

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });

test('identifyTree names a live process and heldAmong holds it until it exits', { timeout: 60000 }, async () => {
  const child = sleeper();
  try {
    const tree = await G.identifyTree([child.pid]);
    const me = tree.find((i) => i.pid === child.pid);
    assert.ok(me && me.created != null, 'the root is identified with a creation time');
    assert.deepStrictEqual((await G.heldAmong([me])).map((i) => i.pid), [child.pid]);
    assert.deepStrictEqual(await G.heldAmong([{ pid: me.pid, created: me.created + 5000 }]), [], 'another creation time is another process');
    assert.deepStrictEqual(await G.heldAmong([{ pid: me.pid, created: null }]), [], 'nothing held the pid when it was identified');
    await assert.rejects(() => G.heldAmong([G.recorded(me.pid, null)]), /cannot be told from a reused number/);
    child.kill();
    assert.ok(await G.childExited(child));
    assert.deepStrictEqual(await G.heldAmong([me]), [], 'gone once it has exited');
  } finally { if (child.exitCode === null) child.kill(); }
});

test('a timed sample counts a process that exits while the snapshot runs as held; a plain check does not', { timeout: 60000 }, async () => {
  const ID = require('../../src/core/proc-identity.cjs');
  const orig = ID.processSnapshot;
  const run = async (opts) => {
    const child = sleeper();
    try {
      const me = (await G.identifyTree([child.pid])).find((i) => i.pid === child.pid);
      ID.processSnapshot = async (o) => { child.kill(); await new Promise((r) => child.once('exit', r)); return orig(o); }; // it ends during the snapshot's latency
      return (await G.heldAmong([me], opts)).map((i) => i.pid);
    } finally { ID.processSnapshot = orig; if (child.exitCode === null) child.kill(); }
  };
  assert.strictEqual((await run({ sampled: true })).length, 1, 'alive when asked, so held at the sample');
  assert.strictEqual((await run({})).length, 0, 'a plain check judges it by the snapshot');
});
