'use strict';
// run-spec-id.test.cjs — a spec's run_id names the run's directories (the orchestrator dir, the job ids built from it), so it takes
// the one id rule: a path-shaped run_id is refused when the spec is read, before anything is written.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSpec } = require('../../src/cli/run-spec.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');

test('a spec whose run_id is a path is refused; a plain one is kept', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-specid-')));
  try {
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/p.md`, 'x');
    const at = (run_id) => {
      fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: 'p.md', run_id }));
      return parseSpec(`${dir}/spec.json`, dir, { found: { found: false } });
    };
    for (const bad of ['../../escape', 'a/b', 'CON']) assert.match(at(bad).error || '', /run_id must be a letter or digit/, bad);
    const ok = at('run-7');
    assert.strictEqual(ok.error, undefined, ok.error);
    assert.strictEqual(ok.runId, 'run-7');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
