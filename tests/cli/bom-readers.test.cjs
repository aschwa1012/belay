'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// bom-readers.test.cjs — a spec or config saved with a UTF-8 BOM (Windows PowerShell's `Set-Content -Encoding utf8`) is read, not refused as invalid JSON.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../../src/cli/config.cjs');
const { parseSpec } = require('../../src/cli/run-spec.cjs');

const BOM = String.fromCharCode(0xFEFF);
const fwd = (p) => String(p).split(path.sep).join('/');
const sandbox = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-bom-')));

test('a belay.config.json with a leading BOM parses', () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(`${dir}/.git`);
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, BOM + JSON.stringify({ claude_exe: 'x' }), 'utf8');
    const r = C.discover(dir);
    assert.strictEqual(r.parse_error, null);
    assert.strictEqual(r.config.claude_exe, 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a run spec with a leading BOM parses, and only one BOM is stripped', () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(`${dir}/.git`); fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'do the thing');
    const specPath = `${dir}/spec.json`;
    const body = JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, orchestrator_dir: `${dir}/orch` });
    fs.writeFileSync(specPath, BOM + body, 'utf8');
    assert.ifError(parseSpec(specPath, dir).error);
    fs.writeFileSync(specPath, BOM + BOM + body, 'utf8');
    assert.match(parseSpec(specPath, dir).error, /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a BOM config still takes a settings write (the compare-and-swap sees the file as it is on disk)', () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(`${dir}/.git`);
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, BOM + JSON.stringify({ mod: { pane: 'docked' } }), 'utf8');
    const found = C.discover(dir);
    assert.strictEqual(found.raw.charCodeAt(0), 0xFEFF, 'raw is kept unstripped');
    const w = require('../../src/cli/cmd-settings.cjs').writeSetting(found, 'mod.band', 'minimal', { cwd: dir });
    assert.strictEqual(w.code, 0, w.text);
    assert.strictEqual(JSON.parse(fs.readFileSync(`${dir}/${C.CONFIG_NAME}`, 'utf8')).mod.band, 'minimal');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a memory import JSONL file saved with a BOM reads its first line', () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(`${dir}/seed.jsonl`, `${BOM}${JSON.stringify({ text: 'one', namespace: 'n' })}\n${JSON.stringify({ text: 'two', namespace: 'n' })}\n`, 'utf8');
    const r = require('../../src/cli/cmd-memory.cjs').readImport({ cwd: dir }, { positional: ['seed.jsonl'], opts: { namespaces: ['n'] } });
    assert.deepStrictEqual(r.refused, []);
    assert.strictEqual(r.items.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
