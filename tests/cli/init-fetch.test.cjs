'use strict';
require('../helpers/tmp.cjs');
// init-fetch.test.cjs — `belay init` offers to fetch the embedding model (prompt only in a terminal, one line otherwise, --fetch and
// --no-fetch for scripts) and the run refusal says how to run without the embedder. No test makes a network request: the fetch is a fake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INIT = require('../../src/cli/cmd-init.cjs');
const M = require('../../src/core/models.cjs');
const CLI = path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-initfetch-'));
  fs.mkdirSync(path.join(d, '.git'));
  const cache = path.join(d, 'cache');
  fs.mkdirSync(cache);
  process.env.BELAY_MODEL_CACHE = cache; // an empty cache: the model is missing
  return d.split(path.sep).join('/');
}
const rm = (d) => { delete process.env.BELAY_MODEL_CACHE; fs.rmSync(d, { recursive: true, force: true }); };
function fakes() {
  const f = { asked: [], fetched: 0 };
  f.prompt = (answer) => async (q) => { f.asked.push(q); return answer; };
  f.fetchModel = async (c) => { f.fetched++; f.argv = c.argv; return { code: 0, json: { model: M.DEFAULT_MODEL } }; };
  return f;
}

test('in a terminal init asks once with the real size, and yes runs the fetch', async () => {
  const d = sandbox(), f = fakes();
  try {
    const r = await INIT.run({ argv: [], cwd: d, dataDir: `${d}/.belay`, json: false, interactive: true, prompt: f.prompt('y'), fetchModel: f.fetchModel });
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(f.asked.length, 1);
    const mb = Math.round(M.MODELS[M.DEFAULT_MODEL].files.reduce((n, x) => n + x.bytes, 0) / 1e6);
    assert.match(f.asked[0], new RegExp(`Download the embedding model now \\(about ${mb} MB, one time\\)\\? \\[Y/n\\]`));
    assert.strictEqual(f.fetched, 1);
    assert.deepStrictEqual(f.argv, ['fetch', '--model', M.DEFAULT_MODEL]);
    assert.strictEqual(r.json.embedder.action, 'fetched');
  } finally { rm(d); }
});

test('an empty answer means yes; no prints the command to run later and fetches nothing', async () => {
  const d = sandbox(), f = fakes();
  try {
    const yes = await INIT.run({ argv: [], cwd: d, dataDir: `${d}/.belay`, json: false, interactive: true, prompt: f.prompt(''), fetchModel: f.fetchModel });
    assert.strictEqual(yes.json.embedder.action, 'fetched');
    const no = await INIT.run({ argv: [], cwd: d, dataDir: `${d}/.belay`, json: false, interactive: true, prompt: f.prompt('n'), fetchModel: f.fetchModel });
    assert.strictEqual(f.fetched, 1);
    assert.strictEqual(no.json.embedder.action, 'declined');
    assert.match(no.text, /fetch it later with: belay embedder fetch --model /);
  } finally { rm(d); }
});

test('with no terminal, or --json, init never asks and never fetches; it prints one line', async () => {
  const d = sandbox(), f = fakes();
  try {
    const text = await INIT.run({ argv: [], cwd: d, dataDir: `${d}/.belay`, json: false, interactive: false, prompt: f.prompt('y'), fetchModel: f.fetchModel });
    assert.match(text.text, /the embedding model is missing; fetch it with: belay embedder fetch --model /);
    const json = await INIT.run({ argv: [], cwd: d, dataDir: `${d}/.belay`, json: true, interactive: true, prompt: f.prompt('y'), fetchModel: f.fetchModel });
    assert.strictEqual(json.json.embedder.action, 'not_asked');
    assert.strictEqual(f.asked.length + f.fetched, 0);
  } finally { rm(d); }
});

test('--fetch fetches without asking, --no-fetch never asks or fetches, both together are a usage error', async () => {
  const d = sandbox(), f = fakes();
  try {
    const yes = await INIT.run({ argv: ['--fetch'], cwd: d, dataDir: `${d}/.belay`, json: true, interactive: false, prompt: f.prompt('n'), fetchModel: f.fetchModel });
    assert.strictEqual(yes.json.embedder.action, 'fetched');
    assert.strictEqual(f.fetched, 1);
    const no = await INIT.run({ argv: ['--no-fetch'], cwd: d, dataDir: `${d}/.belay`, json: false, interactive: true, prompt: f.prompt('y'), fetchModel: f.fetchModel });
    assert.strictEqual(f.fetched, 1);
    assert.strictEqual(f.asked.length, 0);
    assert.match(no.text, /--no-fetch/);
    const both = await INIT.run({ argv: ['--fetch', '--no-fetch'], cwd: d, dataDir: `${d}/.belay`, json: true });
    assert.strictEqual(both.code, 2);
  } finally { rm(d); }
});

test('a failed fetch is exit 1 and names the retry command; the config is still written', async () => {
  const d = sandbox();
  try {
    const r = await INIT.run({ argv: ['--fetch'], cwd: d, dataDir: `${d}/.belay`, json: false, fetchModel: async () => ({ code: 1, json: { error: 'offline' } }) });
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /download failed: offline; retry with: belay embedder fetch/);
    assert.ok(fs.existsSync(`${d}/belay.config.json`));
  } finally { rm(d); }
});

test('the built CLI with piped output prints the missing-model line and makes no fetch', () => {
  const d = sandbox();
  try {
    const r = spawnSync(process.execPath, [CLI, 'init'], { cwd: d, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, BELAY_MODEL_CACHE: `${d}/cache` } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /the embedding model is missing; fetch it with: belay embedder fetch/);
  } finally { rm(d); }
});

test('the run refusal for an embedder that cannot load names how to run without it', () => {
  const E = require('../../src/core/embedder-mode.cjs');
  const t = E.withoutEmbedderAdvice();
  assert.match(t, /belay settings memory\.on_embedder_failure keyword/);
  assert.match(t, /no semantic search/);
  assert.match(t, /or off \(notes are off for the run\)/);
  for (const v of ['keyword', 'off']) assert.ok(E.MODES.includes(v), v);
});
