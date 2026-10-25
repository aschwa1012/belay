'use strict';
// review-scratch-links.test.cjs — ADR 0054 amendment 1: the scratch folder's make, measure and delete never follow a link. A
// worker directory planted as a junction to a folder outside the data directory (with a marker naming the run and a scratch/
// inside it) is not read, measured or emptied; a scratch/ that is itself a junction is named and left alone and not measured;
// a junction inside a real scratch folder is removed as a link, its target kept and not counted. mklink /J needs no elevation.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RS = require('../../src/run/review-scratch.cjs');
const SD = require('../../src/core/scratch-dir.cjs');

const win = process.platform === 'win32';
const junction = (link, target) => {
  const r = win ? spawnSync('cmd', ['/c', 'mklink', '/J', link.split('/').join('\\'), target.split('/').join('\\')], { encoding: 'utf8', windowsHide: true }) : spawnSync('ln', ['-s', target, link]);
  assert.strictEqual(r.status, 0, `link ${link}: ${r.stdout}${r.stderr}`);
};
const fwd = (p) => String(p).split(path.sep).join('/');
function sandbox() {
  const top = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-scratch-links-')));
  const data = `${top}/data`, victim = `${top}/victim`;
  fs.mkdirSync(`${data}/workers`, { recursive: true });
  fs.mkdirSync(`${victim}/scratch`, { recursive: true });
  fs.writeFileSync(`${victim}/scratch/precious2.txt`, 'keep me');
  fs.writeFileSync(`${victim}/scratch-run.txt`, 'run-L');
  fs.writeFileSync(`${victim}/precious.txt`, 'keep me too');
  return { top, data, victim, rm: () => fs.rmSync(top, { recursive: true, force: true }) };
}
// rmSync of the sandbox must not follow the junctions either: links are removed first.
const unlinkAll = (s, links) => { for (const l of links) { try { fs.rmSync(l, { recursive: false, force: true }); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } } s.rm(); };

test('a worker directory that is a junction is never read, measured or emptied at run close', () => {
  const s = sandbox();
  const link = `${s.data}/workers/rD`;
  junction(link, s.victim);
  try {
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-L', {}), {}, 'its marker is not read through the junction');
    assert.strictEqual(fs.readFileSync(`${s.victim}/scratch/precious2.txt`, 'utf8'), 'keep me', 'the target\'s scratch/ is untouched');
    assert.strictEqual(SD.facts(s.data, 'rD'), null, 'nothing is measured through it');
    assert.strictEqual(RS.ensure(s.data, 'rD', 'run-L'), null, 'no folder is made or emptied through it');
    assert.ok(fs.existsSync(`${s.victim}/scratch/precious2.txt`));
    assert.strictEqual(fs.readFileSync(`${s.victim}/scratch-run.txt`, 'utf8'), 'run-L', 'its marker is not rewritten');
  } finally { unlinkAll(s, [link]); }
});

test('a scratch folder that is a junction is named and left alone, not measured, and not emptied by a later spawn', () => {
  const s = sandbox();
  const wd = `${s.data}/workers/rS`;
  fs.mkdirSync(wd);
  fs.writeFileSync(`${wd}/scratch-run.txt`, 'run-L');
  junction(`${wd}/scratch`, `${s.victim}/scratch`);
  try {
    assert.strictEqual(SD.facts(s.data, 'rS'), null, 'no over-report through the junction');
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed, f.bytes]), [['rS', false, 0]]);
    assert.match(out.folders[0].error, /not a real directory/);
    assert.strictEqual(RS.ensure(s.data, 'rS', 'run-M'), null);
    assert.strictEqual(fs.readFileSync(`${s.victim}/scratch/precious2.txt`, 'utf8'), 'keep me');
  } finally { unlinkAll(s, [`${wd}/scratch`]); }
});

test('a junction inside a real scratch folder is removed as a link: its target is kept and not counted', () => {
  const s = sandbox();
  const dir = (() => { fs.mkdirSync(`${s.data}/workers/rI`); return RS.ensure(s.data, 'rI', 'run-L'); })();
  assert.ok(dir, 'a real folder is made');
  fs.writeFileSync(`${dir}/probe.cjs`, 'x'.repeat(10));
  junction(`${dir}/out`, s.victim);
  try {
    assert.deepStrictEqual([SD.facts(s.data, 'rI').bytes, SD.facts(s.data, 'rI').files], [10, 1], 'the link is not walked');
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed, f.bytes]), [['rI', true, 10]]);
    assert.ok(!fs.existsSync(dir));
    assert.strictEqual(fs.readFileSync(`${s.victim}/precious.txt`, 'utf8'), 'keep me too', 'the junction\'s target survives');
  } finally { unlinkAll(s, [`${dir}/out`]); }
});

test('a junction to another worker\'s directory, inside the data directory, is not taken for a worker of its own', () => {
  const s = sandbox();
  fs.mkdirSync(`${s.data}/workers/rY`);
  const dir = RS.ensure(s.data, 'rY', 'run-L');
  fs.writeFileSync(`${dir}/probe.cjs`, 'x');
  const link = `${s.data}/workers/rX`;
  junction(link, `${s.data}/workers/rY`);
  try {
    assert.strictEqual(SD.workerDir(s.data, 'rX'), null);
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-L', { keep_review_scratch: true }).review_scratch.folders.map((f) => f.worker_id), ['rY'], 'only the real directory');
  } finally { unlinkAll(s, [link]); }
});
