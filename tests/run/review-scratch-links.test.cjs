'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// review-scratch-links.test.cjs — ADR 0054 amendment 1: the scratch folder's make, measure and delete never follow a link. The
// layout is <data>/scratch/<run id>/<worker id>. A run folder planted as a junction to a folder outside the data directory is
// not read, measured or emptied; a worker's folder that is itself a junction is named and left alone and not measured; a
// junction inside a real scratch folder is removed as a link, its target kept and not counted; a <data>/scratch that is itself
// a junction is never followed. mklink /J needs no elevation.

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
const NAMES = ['rD', 'rS', 'rX', 'rY', 'rE', 'rW'];
// The victim stands in for a run folder somewhere else: it has a folder per name a test links to, each with a file to keep.
function sandbox() {
  const top = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-scratch-links-')));
  const data = `${top}/data`, victim = `${top}/victim`;
  fs.mkdirSync(`${data}/scratch`, { recursive: true });
  for (const n of NAMES) {
    fs.mkdirSync(`${victim}/${n}`, { recursive: true });
    fs.writeFileSync(`${victim}/${n}/precious2.txt`, 'keep me');
  }
  fs.writeFileSync(`${victim}/precious.txt`, 'keep me too');
  return { top, data, victim, rm: () => fs.rmSync(top, { recursive: true, force: true }) };
}
const kept = (s, n) => fs.readFileSync(`${s.victim}/${n}/precious2.txt`, 'utf8');
// rmSync of the sandbox must not follow the junctions either: links are removed first.
const unlinkAll = (s, links) => { for (const l of links) { try { fs.rmSync(l, { recursive: false, force: true }); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } } s.rm(); };

test('a run folder that is a junction is never read, measured or emptied at run close', () => {
  const s = sandbox();
  const link = `${s.data}/scratch/run-L`;
  junction(link, s.victim);
  try {
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-L', {}), {}, 'its folders are not listed through the junction');
    assert.strictEqual(kept(s, 'rD'), 'keep me', 'the target is untouched');
    assert.strictEqual(SD.facts(s.data, 'run-L', 'rD'), null, 'nothing is measured through it');
    assert.strictEqual(RS.ensure(s.data, 'rD', 'run-L'), null, 'no folder is made or emptied through it');
    assert.ok(fs.existsSync(`${s.victim}/rD/precious2.txt`));
  } finally { unlinkAll(s, [link]); }
});

test('a scratch folder that is a junction is named and left alone, not measured, and not emptied by a later spawn', () => {
  const s = sandbox();
  const rd = `${s.data}/scratch/run-L`;
  fs.mkdirSync(rd);
  junction(`${rd}/rS`, `${s.victim}/rS`);
  try {
    assert.strictEqual(SD.facts(s.data, 'run-L', 'rS'), null, 'no over-report through the junction');
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed, f.bytes]), [['rS', false, 0]]);
    assert.match(out.folders[0].error, /not a real directory/);
    assert.strictEqual(RS.ensure(s.data, 'rS', 'run-L'), null);
    assert.strictEqual(kept(s, 'rS'), 'keep me');
  } finally { unlinkAll(s, [`${rd}/rS`]); }
});

test('a junction inside a real scratch folder is removed as a link: its target is kept and not counted', () => {
  const s = sandbox();
  const dir = RS.ensure(s.data, 'rI', 'run-L');
  assert.ok(dir, 'a real folder is made');
  fs.writeFileSync(`${dir}/probe.cjs`, 'x'.repeat(10));
  junction(`${dir}/out`, s.victim);
  try {
    assert.deepStrictEqual([SD.facts(s.data, 'run-L', 'rI').bytes, SD.facts(s.data, 'run-L', 'rI').files], [10, 1], 'the link is not walked');
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed, f.bytes]), [['rI', true, 10]]);
    assert.ok(!fs.existsSync(dir));
    assert.strictEqual(fs.readFileSync(`${s.victim}/precious.txt`, 'utf8'), 'keep me too', 'the junction target survives');
  } finally { unlinkAll(s, [`${dir}/out`]); }
});

test('a junction to another run folder, inside the data directory, is not taken for a run of its own', () => {
  const s = sandbox();
  const dir = RS.ensure(s.data, 'rY', 'run-L');
  fs.writeFileSync(`${dir}/probe.cjs`, 'x');
  const link = `${s.data}/scratch/run-X`;
  junction(link, `${s.data}/scratch/run-L`);
  try {
    assert.strictEqual(SD.runDir(s.data, 'run-X'), null);
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-X', { keep_review_scratch: true }), {}, 'the link lists nothing');
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-L', { keep_review_scratch: true }).review_scratch.folders.map((f) => f.worker_id), ['rY'], 'only the real directory');
  } finally { unlinkAll(s, [link]); }
});

test('a scratch root that is itself a junction is never followed, while a data directory reached through a junction works', () => {
  const s = sandbox();
  const data = `${s.top}/d5`;
  fs.mkdirSync(data);
  fs.mkdirSync(`${s.victim}/run-L/rW`, { recursive: true });
  fs.writeFileSync(`${s.victim}/run-L/rW/precious.txt`, 'keep');
  junction(`${data}/scratch`, s.victim);
  const real = `${s.top}/d3real`;
  fs.mkdirSync(real);
  junction(`${s.top}/d3link`, real);
  try {
    assert.deepStrictEqual(RS.closeRun(data, 'run-L', {}), {}, 'nothing is read through the junctioned scratch root');
    assert.strictEqual(fs.readFileSync(`${s.victim}/run-L/rW/precious.txt`, 'utf8'), 'keep');
    assert.strictEqual(RS.ensure(data, 'rN', 'run-L'), null, 'and nothing is made through it');
    const made = RS.ensure(`${s.top}/d3link`, 'rZ', 'run-L');
    assert.ok(made, 'a data directory under a junction higher up still gets a folder');
    const out = RS.closeRun(`${s.top}/d3link`, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed]), [['rZ', true]]);
    assert.ok(!fs.existsSync(`${real}/scratch/run-L/rZ`));
  } finally { unlinkAll(s, [`${data}/scratch`, `${s.top}/d3link`]); }
});

// The seam: SD.measure runs between the rename and the remove, so a swap there is the interleaving a racing process could make.
function withMeasureSeam(swap, fn) {
  const orig = SD.measure;
  let fired = false;
  SD.measure = (dir) => { const m = orig(dir); if (!fired) { fired = true; swap(dir); } return m; };
  try { return fn(); } finally { SD.measure = orig; }
}

test('a run folder swapped for a junction during the close is not followed: the moved-aside folder is what is removed', () => {
  const s = sandbox();
  const dir = RS.ensure(s.data, 'rX', 'run-L');
  fs.writeFileSync(`${dir}/p`, '1');
  const rd = `${s.data}/scratch/run-L`;
  try {
    const out = withMeasureSeam(() => { fs.rmSync(rd, { recursive: true, force: true }); junction(rd, s.victim); }, () => RS.closeRun(s.data, 'run-L', {}).review_scratch);
    assert.strictEqual(kept(s, 'rX'), 'keep me', 'the junction target is untouched');
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed, f.bytes]), [['rX', true, 1]]);
    assert.deepStrictEqual(fs.readdirSync(`${s.data}/scratch`).filter(SD.isGone), [], 'nothing left aside');
    assert.ok(fs.existsSync(`${s.victim}/precious.txt`), 'the run folder removal did not follow the link');
  } finally { unlinkAll(s, [rd]); }
});

test('a folder swapped for a junction after it was moved aside is moved back and left alone, named in the receipt', () => {
  const s = sandbox();
  const dir = RS.ensure(s.data, 'rY', 'run-L');
  try {
    const out = withMeasureSeam((moved) => { fs.rmSync(moved, { recursive: true, force: true }); junction(moved, `${s.victim}/rY`); }, () => RS.closeRun(s.data, 'run-L', {}).review_scratch);
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed]), [['rY', false]]);
    assert.match(out.folders[0].error, /changed between the check and the removal/);
    assert.strictEqual(kept(s, 'rY'), 'keep me');
  } finally { unlinkAll(s, [dir]); }
});

test('a .gone- entry a crash left is swept under the identity its name records; one whose identity differs is left and named; neither is a run or a worker', () => {
  const s = sandbox();
  const root = `${s.data}/scratch`;
  fs.mkdirSync(`${root}/aside/x`, { recursive: true });
  const id = SD.identity(`${root}/aside`);
  fs.renameSync(`${root}/aside`, `${root}/${SD.goneName(id, 'crash')}`);
  fs.mkdirSync(`${root}/other`);
  const wrong = SD.goneName({ dev: id.dev, ino: id.ino + 12345n }, 'wrong');
  fs.renameSync(`${root}/other`, `${root}/${wrong}`);
  try {
    assert.strictEqual(RS.ensure(s.data, wrong, 'run-L'), null, 'a .gone- name is never a worker');
    assert.strictEqual(RS.ensure(s.data, 'rA', wrong), null, 'nor a run');
    assert.strictEqual(SD.runDir(s.data, wrong), null, 'nor a run directory');
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual(out.swept.map((x) => [x.entry.endsWith('-crash'), x.removed]), [[true, true], [false, false]]);
    assert.deepStrictEqual(out.folders, []);
    assert.ok(fs.existsSync(`${root}/${wrong}`), 'the mismatched entry stays');
  } finally { s.rm(); }
});

test('a run folder swapped for a junction right after the check is caught at the remove: the identity was taken before the check', () => {
  const s = sandbox();
  RS.ensure(s.data, 'rX', 'run-L');
  const rd = `${s.data}/scratch/run-L`;
  const orig = SD.scratchDir;
  SD.scratchDir = (d, run, id) => { const r = orig(d, run, id); if (id === 'rX') { SD.scratchDir = orig; fs.rmSync(rd, { recursive: true, force: true }); junction(rd, s.victim); } return r; };
  try {
    const out = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.strictEqual(kept(s, 'rX'), 'keep me', 'the victim is not deleted');
    assert.deepStrictEqual(out.folders.map((f) => [f.worker_id, f.removed]), [['rX', false]]);
    assert.match(out.folders[0].error, /changed between the check and the removal/);
  } finally { SD.scratchDir = orig; unlinkAll(s, [rd]); }
});

test('a rename refused while a handle is open is tried a bounded number of times; a passing one removes, a lasting one is left and named', () => {
  const s = sandbox();
  const dir = RS.ensure(s.data, 'rB', 'run-L');
  const real = fs.renameSync;
  let calls = 0;
  const busy = (n) => (from, to) => { calls += 1; if (calls <= n) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return real(from, to); };
  try {
    fs.renameSync = busy(2);
    const ok = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual([ok.folders[0].removed, calls], [true, 3], 'two refusals, then the third try moves it');
    const again = RS.ensure(s.data, 'rB', 'run-L');
    assert.ok(again);
    calls = 0;
    fs.renameSync = busy(99);
    const left = RS.closeRun(s.data, 'run-L', {}).review_scratch;
    assert.deepStrictEqual([left.folders[0].removed, calls], [false, 3], 'three tries, then left');
    assert.match(left.folders[0].error, /could not be moved aside \(EPERM\)/);
    assert.ok(fs.existsSync(dir), 'left in place');
  } finally { fs.renameSync = real; s.rm(); }
});

test('ensure takes the leftover folder identity before its check too: a swap right after it deletes nothing', () => {
  const s = sandbox();
  RS.ensure(s.data, 'rE', 'run-L');
  const rd = `${s.data}/scratch/run-L`;
  const orig = SD.scratchDir;
  SD.scratchDir = (d, run, id) => { const r = orig(d, run, id); if (id === 'rE') { SD.scratchDir = orig; fs.rmSync(rd, { recursive: true, force: true }); junction(rd, s.victim); } return r; };
  try {
    assert.strictEqual(RS.ensure(s.data, 'rE', 'run-L'), null, 'no folder is named');
    assert.strictEqual(kept(s, 'rE'), 'keep me');
  } finally { SD.scratchDir = orig; unlinkAll(s, [rd]); }
});

test('the scratch root is a real directory of its own: a file where it goes gets no folder and is left as it was', () => {
  const s = sandbox();
  fs.rmSync(`${s.data}/scratch`, { recursive: true });
  fs.writeFileSync(`${s.data}/scratch`, 'not a directory');
  try {
    assert.strictEqual(RS.ensure(s.data, 'rA', 'run-L'), null);
    assert.deepStrictEqual(RS.closeRun(s.data, 'run-L', {}), {});
    assert.strictEqual(fs.readFileSync(`${s.data}/scratch`, 'utf8'), 'not a directory');
  } finally { s.rm(); }
});

test('a run id that differs from a folder only by case is a different run: ensure reuses nothing and a close removes nothing, and names it', { skip: !win && 'needs a case-insensitive file system' }, () => {
  const s = sandbox();
  try {
    const mine = RS.ensure(s.data, 'w1', 'r1');
    fs.writeFileSync(`${mine}/probe.cjs`, 'keep');
    assert.strictEqual(RS.ensure(s.data, 'w2', 'R1'), null, 'a case variant of a run folder is not reused');
    assert.ok(!fs.existsSync(`${s.data}/scratch/r1/w2`), 'and nothing is made in it');
    const out = RS.closeRun(s.data, 'R1', {}).review_scratch;
    assert.deepStrictEqual([out.folders, out.removed_folders], [[], 0]);
    assert.match(out.error, /differs from the run id "R1" only by case/);
    assert.deepStrictEqual(RS.lines({ review_scratch: out }), [`review scratch: ${out.error}`]);
    assert.strictEqual(fs.readFileSync(`${mine}/probe.cjs`, 'utf8'), 'keep', 'the other run\'s folder is whole');
    assert.strictEqual(SD.scratchDir(s.data, 'r1', 'W1'), null, 'a case variant of a worker folder is not that folder');
    assert.ok(SD.scratchDir(s.data, 'r1', 'w1'), 'the exact spelling still is');
  } finally { s.rm(); }
});

test('ensure: a run folder swapped for a junction after its check names no folder and the victim keeps what it had', () => {
  const s = sandbox();
  fs.rmSync(`${s.victim}/rX`, { recursive: true });
  const rd = `${s.data}/scratch/run-L`;
  fs.mkdirSync(rd);
  const orig = SD.runDir;
  let n = 0;
  SD.runDir = (d, run) => { const r = orig(d, run); if (n++ === 0) { fs.rmdirSync(rd); junction(rd, s.victim); } return r; };
  try {
    assert.strictEqual(RS.ensure(s.data, 'rX', 'run-L'), null, 'no folder is named');
    assert.strictEqual(kept(s, 'rY'), 'keep me', 'the victim\'s own folders are untouched');
    assert.strictEqual(fs.readFileSync(`${s.victim}/precious.txt`, 'utf8'), 'keep me too');
  } finally { SD.runDir = orig; unlinkAll(s, [rd]); }
});

test('ensure: a swap between the mkdir and the re-check removes nothing, even an empty folder of the same name that was already in the victim', () => {
  const s = sandbox();
  fs.rmSync(`${s.victim}/rX`, { recursive: true });
  fs.mkdirSync(`${s.victim}/rX`); // empty, pre-existing: the shape an identity read taken after the swap would take for its own
  const rd = `${s.data}/scratch/run-L`;
  fs.mkdirSync(rd);
  const real = fs.mkdirSync;
  const removed = [];
  const realRmdir = fs.rmdirSync;
  fs.mkdirSync = (p, ...a) => {
    const r = real(p, ...a);
    if (path.basename(String(p)) === 'rX') { fs.renameSync(rd, `${rd}.real`); junction(rd, s.victim); }
    return r;
  };
  fs.rmdirSync = (p, ...a) => { removed.push(String(p)); return realRmdir(p, ...a); };
  try {
    assert.strictEqual(RS.ensure(s.data, 'rX', 'run-L'), null);
    assert.ok(fs.existsSync(`${s.victim}/rX`), 'the victim\'s empty folder is still there');
    assert.deepStrictEqual(removed, [], 'no rmdir was made');
  } finally { fs.mkdirSync = real; fs.rmdirSync = realRmdir; unlinkAll(s, [rd]); }
});
