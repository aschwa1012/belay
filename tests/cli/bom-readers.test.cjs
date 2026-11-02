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
