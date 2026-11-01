'use strict';
require('../helpers/tmp.cjs');
// wake-stream-store-dir.test.cjs — `wake-stream` finds the store the way every other command does: the --data
// override, then the project config's data_dir, then <project root>/.belay. The dispatcher always fills ctx.dataDir with
// <cwd>/.belay and sets ctx.dataDirGiven only for --data, so a command must not read ctx.dataDir directly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const wakeStream = require('../../src/cli/cmd-wake-stream.cjs');
const { wakePipeName } = require('../../src/run/wake-pipe.cjs');

let root;
const fwd = (p) => p.split(path.sep).join('/');
const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return fwd(d); };
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wakedir-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('wake-stream without --data dials the pipe named from the configured store, not from <cwd>/.belay', async () => {
  const proj = mk('pw');
  fs.writeFileSync(path.join(proj, 'belay.config.json'), JSON.stringify({ project: 'acme', data_dir: 'store' }));
  const pipe = wakePipeName(`${proj}/store`, 'r1', 'n1');
  assert.notStrictEqual(pipe, wakePipeName(`${proj}/.belay`, 'r1', 'n1'));
  let connections = 0;
  const server = net.createServer((s) => { connections += 1; s.end('{"id":"x","text":"wake"}\n'); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(pipe, res); });
  try {
    const out = [];
    const res = await wakeStream.run({ argv: ['--run', 'r1', '--nonce', 'n1'], cwd: proj, dataDir: `${proj}/.belay`, dataDirGiven: false, emit: (t) => out.push(t) });
    assert.strictEqual(res.code, 0, res.text);
    assert.strictEqual(connections, 1);
    assert.strictEqual(out.join(''), '{"id":"x","text":"wake"}\n');
    assert.strictEqual(res.json.pipe, pipe);
  } finally { await new Promise((r) => server.close(r)); }
});
