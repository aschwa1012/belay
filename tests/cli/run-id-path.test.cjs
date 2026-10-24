'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-id-path.test.cjs — a spec's run_id names the orchestrator's temp directory and prefixes belay's job worker ids, so parseSpec holds it to the
// id grammar and to 40 characters; `belay worker rm` with a bad id touches nothing outside the data dir.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSpec } = require('../../src/cli/run-spec.cjs');
const { isPathId } = require('../../src/core/path-id.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const fwd = (p) => String(p).split(path.sep).join('/');

function spec(extra) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-runid-')));
  fs.mkdirSync(`${dir}/.git`); fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, 'do the thing');
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, orchestrator_dir: `${dir}/orch`, ...extra }));
  return { dir, specPath };
}

test('parseSpec refuses a traversal, an over-long or a device-name run_id before anything runs, and accepts a UUID and 40 characters', () => {
  const sb = spec({});
  try {
    const run = (run_id) => { fs.writeFileSync(sb.specPath, JSON.stringify({ worktree: `${sb.dir}/wt`, prompt_file: `${sb.dir}/prompt.txt`, orchestrator_dir: `${sb.dir}/orch`, run_id })); return parseSpec(sb.specPath, sb.dir); };
    for (const bad of ['../x', 'a/b', '.hidden', 'x'.repeat(41), 'nul']) assert.match(run(bad).error || '', /run_id/, bad);
    assert.match(run('x'.repeat(41)).error, /limit is 40/);
    for (const ok of [crypto.randomUUID(), 'x'.repeat(40), 'lv-run']) assert.ifError(run(ok).error);
    assert.strictEqual(run(undefined).error, undefined, 'a generated run id is accepted');
    const job = `archreview-${'x'.repeat(40)}-${Date.now().toString(36)}`;
    assert.ok(isPathId(job), 'the longest job id stays inside the grammar');
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('belay worker rm with a traversal id forgets nothing and touches nothing outside the data dir', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rmid-')));
  const dataDir = `${dir}/.belay`;
  fs.mkdirSync(`${dir}/victim`, { recursive: true });
  fs.writeFileSync(`${dir}/victim/keep.txt`, 'keep');
  try {
    const r = spawnSync(process.execPath, [`${ROOT}/src/cli/belay.cjs`, 'worker', 'rm', '../../victim', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.ok(!/"forgotten":\s*true/.test(r.stdout + r.stderr), `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(fs.readFileSync(`${dir}/victim/keep.txt`, 'utf8'), 'keep');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
