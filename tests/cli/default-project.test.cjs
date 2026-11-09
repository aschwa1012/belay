'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// default-project.test.cjs — the project a run or `belay init` takes when none is set: the git remote's owner and repository, read as text from
// the local git config, else the folder name. An explicit setting always wins. Nothing here runs git.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require('../../src/cli/default-project.cjs');
const { parseLevers, substituteLevers, memoryText } = require('../../src/cli/run-levers.cjs');
const { parseMemoryBlock } = require('../../src/core/memory-levers.cjs');

const AT = '@'; // the public export refuses text that reads as an email address, and an ssh remote url reads as one
const ssh = (rest) => `git${AT}host.example:${rest}`;

function repo(name, url) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dp-'));
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '[core]\n\tbare = false\n');
  return { root, dir };
}
const done = (r) => fs.rmSync(r.root, { recursive: true, force: true });

test('the project comes from the origin remote, in every url form', () => {
  for (const url of [ssh('Acme/Widget.git'), 'https://host.example/Acme/Widget.git', `https://user${AT}host.example/Acme/Widget/`, `ssh://git${AT}host.example/Acme/Widget`]) {
    const r = repo('whatever', url);
    try { assert.deepStrictEqual(D.derive(r.dir), { name: 'acme-widget', source: 'git remote origin Acme/Widget' }, url); } finally { done(r); }
  }
});

test('with no remote the project is the folder name, made to fit the project rule', () => {
  const r = repo('My Project', null);
  try {
    const got = D.derive(path.join(r.dir));
    assert.deepStrictEqual(got, { name: 'my-project', source: 'folder name My Project' });
    assert.ok(parseMemoryBlock({ project: got.name }).value);
  } finally { done(r); }
});

test('a linked worktree reads the remote from the shared repository', () => {
  const main = repo('main', ssh('acme/widget.git'));
  try {
    const wt = path.join(main.root, 'wt');
    const gd = path.join(main.dir, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gd, { recursive: true });
    fs.writeFileSync(path.join(gd, 'commondir'), '../..\n');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
    assert.strictEqual(D.derive(wt).name, 'acme-widget');
  } finally { done(main); }
});

test('a run with no memory block derives the project, turns notes on, and records where the name came from', () => {
  const r = repo('x', ssh('acme/widget.git'));
  try {
    const l = parseLevers({}, { projectDir: r.dir });
    assert.strictEqual(l.error, undefined);
    assert.strictEqual(l.memory_levers.project, 'acme-widget');
    assert.strictEqual(l.memory_levers.notes, true);
    assert.deepStrictEqual(l.memory_project, { name: 'acme-widget', source: 'git remote origin acme/widget', derived: true });
    assert.strictEqual(l.memory_sources.project, 'derived: git remote origin acme/widget');
    assert.match(memoryText(l), /project acme-widget \(derived from git remote origin acme\/widget\)/);
    assert.strictEqual(l.memory_notice, null, 'a derived project leaves no "no project" notice');
  } finally { done(r); }
});

test('an explicit setting always wins: a project, notes false, redact false, memory null', () => {
  const r = repo('x', ssh('acme/widget.git'));
  try {
    const named = parseLevers({ memory: { project: 'mine' } }, { projectDir: r.dir });
    assert.strictEqual(named.memory_levers.project, 'mine');
    assert.strictEqual(named.memory_project, undefined);
    const fromConfig = parseLevers({}, { projectDir: r.dir, config: { path: '/c/belay.config.json', memory: { project: 'cfg' } } });
    assert.strictEqual(fromConfig.memory_levers.project, 'cfg');
    for (const spec of [{ memory: { notes: false } }, { memory: { redact: false } }, { memory: null }]) {
      const l = parseLevers(spec, { projectDir: r.dir });
      assert.strictEqual(l.memory_project, undefined, JSON.stringify(spec));
      assert.ok(!l.memory_levers || l.memory_levers.project === null, JSON.stringify(spec));
    }
    assert.strictEqual(parseLevers({}, { projectDir: r.dir, config: { path: '/c', memory: null } }).memory_project, undefined);
  } finally { done(r); }
});

test('the orchestrator prompts teach notes: no legacy store, no verify, and the fix-round counts say what the executor does', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const t = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'prompts', f), 'utf8');
    for (const lv of [{ notes: false }, { notes: true, project: 'p' }]) {
      const out = substituteLevers(t, { max_fix_rounds: 2, fix_cutoff: 'orchestrator', memory_levers: lv }, 0, {}).text;
      assert.ok(!/memory_verify/.test(out), `${f} ${JSON.stringify(lv)} teaches memory_verify`);
      assert.ok(!/it outlives the run/.test(out), `${f} teaches the legacy project write`);
      assert.ok(!/store the outcome in memory/.test(out), f);
      assert.ok(!/A failed acceptance check is not a fix round/.test(out), f);
      assert.match(out, /`fix_eval`, `fix_run`\), counts against the fix-round limit/, f);
    }
  }
});

test('belay init writes memory.project from the git remote and says where it came from', () => {
  const { spawnSync } = require('node:child_process');
  const r = repo('proj', ssh('acme/widget.git'));
  fs.writeFileSync(path.join(r.dir, 'package.json'), '{"name":"p"}');
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs'), 'init', '--json'], { cwd: r.dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.strictEqual(run.status, 0, run.stderr);
    const j = JSON.parse(run.stdout);
    assert.deepStrictEqual([j.project, j.project_source], ['acme-widget', 'git remote origin acme/widget']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'belay.config.json'), 'utf8')).memory, { project: 'acme-widget' });
    const text = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs'), 'init'], { cwd: r.dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.doesNotMatch(text.stdout, /notes project/, 'a kept config is not touched and names no new project');
  } finally { done(r); }
});

test('a folder name with nothing a project key can hold still gets a valid key: transliterated, or a hash of the folder path', () => {
  const accent = repo('Caf\u00e9 Pr\u00f6jekt', null);
  const symbols = repo('___', null);
  const cyrillic = repo('\u043f\u0440\u043e\u0435\u043a\u0442', null);
  try {
    assert.strictEqual(D.derive(accent.dir).name, 'cafe-projekt');
    for (const r of [symbols, cyrillic]) {
      const got = D.derive(r.dir);
      assert.match(got.name, /^project-[0-9a-f]{8}$/, got.source);
      assert.ok(parseMemoryBlock({ project: got.name }).value, 'a valid key');
      assert.match(got.source, /hash of the folder path/);
    }
    assert.notStrictEqual(D.derive(symbols.dir).name, D.derive(cyrillic.dir).name);
    assert.strictEqual(parseLevers({}, { projectDir: symbols.dir }).memory_levers.notes, true, 'notes stay on');
  } finally { done(accent); done(symbols); done(cyrillic); }
});

test('on Windows the hashed key is the same for a path written with either drive-letter case', { skip: process.platform !== 'win32' }, () => {
  const r = repo('___', null);
  try {
    const a = D.derive(r.dir).name;
    const flipped = r.dir[0] === r.dir[0].toLowerCase() ? r.dir[0].toUpperCase() + r.dir.slice(1) : r.dir[0].toLowerCase() + r.dir.slice(1);
    assert.notStrictEqual(flipped, r.dir);
    assert.strictEqual(D.derive(flipped).name, a);
  } finally { done(r); }
});
