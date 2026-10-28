'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-brief.test.cjs — a spec's brief_file: belay's shipped template around the operator's brief; prompt_file stays for a custom
// prompt; both, neither, an unreadable or an empty brief is a usage error.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSpec } = require('../../src/cli/run-spec.cjs');
const { stripMarkers } = require('../../src/cli/run-levers.cjs');
const { appendBrief, shippedTemplate, HEADING } = require('../../src/cli/run-brief.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');
const NOCONF = { found: false };
const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } };

function sandbox(spec, files = {}) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-brief-')));
  fs.mkdirSync(`${dir}/wt`);
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(`${dir}/${n}`, t);
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, run_id: `brief-${Date.now()}`, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...spec }));
  return { dir, specPath };
}
const parse = (s) => parseSpec(s.specPath, s.dir, { found: NOCONF });

test('spec validation: exactly one of prompt_file and brief_file, and the brief must be readable and non-empty', () => {
  const both = sandbox({ prompt_file: 'p.md', brief_file: 'b.md' }, { 'p.md': 'x', 'b.md': 'y' });
  const neither = sandbox({});
  const missing = sandbox({ brief_file: 'nope.md' });
  const empty = sandbox({ brief_file: 'b.md' }, { 'b.md': ' \n' });
  const ok = sandbox({ brief_file: 'b.md' }, { 'b.md': 'Build the thing.\n' });
  try {
    const e1 = parse(both).error;
    assert.match(e1, /"prompt_file"/); assert.match(e1, /"brief_file"/); assert.match(e1, /both/);
    const e2 = parse(neither).error;
    assert.match(e2, /"prompt_file"/); assert.match(e2, /"brief_file"/);
    assert.match(parse(missing).error, /brief_file .*nope\.md could not be read/);
    assert.match(parse(empty).error, /brief_file .* is empty/);
    const p = parse(ok);
    assert.strictEqual(p.error, undefined);
    assert.strictEqual(p.briefText, 'Build the thing.\n');
    assert.strictEqual(p.promptText, null);
  } finally { for (const s of [both, neither, missing, empty, ok]) cleanup(s.dir); }
});

test('a prompt_file spec parses as before', () => {
  const s = sandbox({ prompt_file: 'p.md' }, { 'p.md': 'custom prompt' });
  try {
    const p = parse(s);
    assert.strictEqual(p.promptText, 'custom prompt');
    assert.strictEqual(p.briefText, null);
  } finally { cleanup(s.dir); }
});

test('appendBrief puts the brief under its heading after the template', () => {
  const t = appendBrief('TEMPLATE\n\n', '\n  the brief \n');
  assert.strictEqual(t, `TEMPLATE\n\n${HEADING}\n\nthe brief\n`);
  for (const mode of ['headless', 'interactive']) assert.match(shippedTemplate(mode).text, /belay-prompt/);
});

function go(spec, files, extra = []) {
  const s = sandbox(spec, files);
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-brief' };
  const r = spawnSync(process.execPath, [CLI, 'run', s.specPath, '--data', `${s.dir}/.belay`, '--json', ...extra], { cwd: s.dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { ...s, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('belay run with brief_file: the orchestrator is given belay\'s template with the brief appended, and no prompt warning', () => {
  const r = go({ brief_file: 'brief.md', memory: { notes: false } }, { 'brief.md': 'Add the frobnicator.\n{{max_fix_rounds}} stays as written.\n' });
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    const rc = JSON.parse(r.stdout);
    assert.deepStrictEqual(rc.prompt_warnings || [], []);
    const prompt = fs.readFileSync(`${r.dir}/orch/prompt.txt`, 'utf8');
    const tpl = shippedTemplate('headless').text;
    assert.ok(prompt.startsWith(stripMarkers(tpl).slice(0, 200)), 'starts with the shipped template, less its header markers (read by belay, not shown to the model)');
    assert.ok(!prompt.includes('belay-prompt') && !prompt.includes('belay-mode'), 'no marker reaches the orchestrator');
    assert.ok(!/\{\{max_fix_rounds\}\}\s+fix rounds/.test(prompt.split(HEADING)[0]), 'template levers substituted');
    assert.ok(prompt.endsWith(`${HEADING}\n\nAdd the frobnicator.\n{{max_fix_rounds}} stays as written.\n`), 'brief appended, not substituted');
  } finally { cleanup(r.dir); }
});

test('belay run --interactive with brief_file passes the marker check from the shipped interactive template', () => {
  const r = go({ brief_file: 'brief.md', memory: { notes: false } }, { 'brief.md': 'x\n' }, ['--interactive']);
  try {
    assert.doesNotMatch(r.stderr + r.stdout, /needs an interactive prompt/);
  } finally { cleanup(r.dir); }
});

test('belay run with both fields is exit 2 naming both, and nothing is created', () => {
  const r = go({ prompt_file: 'p.md', brief_file: 'b.md' }, { 'p.md': 'x', 'b.md': 'y' });
  try {
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr + r.stdout, /prompt_file/); assert.match(r.stderr + r.stdout, /brief_file/);
    assert.ok(!fs.existsSync(`${r.dir}/.belay`));
  } finally { cleanup(r.dir); }
});

test('brief_file resolves against the spec\'s directory, not the cwd, and an empty prompt_file counts as not given', () => {
  const s = sandbox({ brief_file: 'b.md', prompt_file: '' }, { 'b.md': 'from the spec dir\n' });
  try {
    const p = parseSpec(s.specPath, os.tmpdir(), { found: NOCONF });
    assert.strictEqual(p.error, undefined);
    assert.strictEqual(p.briefFile, `${s.dir}/b.md`);
    assert.strictEqual(p.briefText, 'from the spec dir\n');
  } finally { cleanup(s.dir); }
});

test('belay run --interactive with brief_file: prompt.txt is the interactive template with the brief appended', () => {
  const r = go({ brief_file: 'brief.md', memory: { notes: false } }, { 'brief.md': 'Interactive brief.\n' }, ['--interactive']);
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    const prompt = fs.readFileSync(`${r.dir}/orch/prompt.txt`, 'utf8');
    assert.ok(prompt.startsWith(stripMarkers(shippedTemplate('interactive').text).slice(0, 200)), 'starts with the interactive template, less its header markers');
    assert.ok(!prompt.includes('belay-prompt') && !prompt.includes('belay-mode'), 'neither the version nor the mode marker reaches the orchestrator');
    assert.ok(prompt.endsWith(`${HEADING}\n\nInteractive brief.\n`), 'brief appended');
  } finally { cleanup(r.dir); }
});
