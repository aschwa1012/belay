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
