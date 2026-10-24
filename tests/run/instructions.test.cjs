'use strict';
// instructions.test.cjs — build step S2-2, ADR 0024 amendment 1: the spawn-time copy of the worktree's
// CLAUDE.md. Pure file-system tests in OS temp; each directory is removed in `finally`.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const I = require('../../src/run/instructions.cjs');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-instructions-'));
  const worktree = path.join(d, 'wt');
  const dir = path.join(d, 'workers', 'w1');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return { d, worktree, dir };
}
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } };

test('instructions: a spawn copies the worktree CLAUDE.md into the data dir as instructions.md, byte for byte, with its sha256', () => {
  const t = tmp();
  try {
    const body = Buffer.concat([Buffer.from('# rules\r\nline two é\n'), Buffer.from([0x00, 0xff, 0x10])]);
    fs.writeFileSync(path.join(t.worktree, 'CLAUDE.md'), body);
    const r = I.snapshotInstructions(t.worktree, t.dir);
    assert.equal(path.basename(r.path), 'instructions.md');
    assert.equal(I.INSTRUCTIONS_FILE, 'instructions.md');
    assert.equal(path.resolve(path.dirname(r.path)), path.resolve(t.dir), 'the copy lives in the data dir');
    assert.ok(fs.readFileSync(r.path).equals(body), 'byte for byte');
    assert.equal(r.bytes, body.length);
    assert.equal(r.sha256, crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(path.resolve(r.source), path.resolve(path.join(t.worktree, 'CLAUDE.md')));
    assert.ok(!r.path.includes('\\'), 'forward slashes');
    // The public fields a spawn returns carry no source.
    assert.deepStrictEqual(Object.keys(I.instructionsFields(r)).sort(), ['bytes', 'path', 'sha256']);
  } finally { rm(t.d); }
});

test('instructions: a worktree with no CLAUDE.md, or a directory named CLAUDE.md, copies nothing and names why', () => {
  const t = tmp();
  try {
    const absent = I.snapshotInstructions(t.worktree, t.dir);
    assert.equal(absent.path, null);
    assert.match(absent.reason, /no CLAUDE\.md/);
    assert.ok(!fs.existsSync(path.join(t.dir, 'instructions.md')), 'nothing written for an absent file');

    fs.mkdirSync(path.join(t.worktree, 'CLAUDE.md'));
    fs.writeFileSync(path.join(t.worktree, 'CLAUDE.md', 'inner.md'), 'inside a directory');
    let dirCase;
    assert.doesNotThrow(() => { dirCase = I.snapshotInstructions(t.worktree, t.dir); }, 'a directory must not throw');
    assert.equal(dirCase.path, null);
    assert.match(dirCase.reason, /not a regular file/);
    assert.notEqual(dirCase.reason, absent.reason, 'the two cases name different reasons');
    assert.deepStrictEqual(fs.readdirSync(t.dir), [], 'nothing written for a directory, contents included');
  } finally { rm(t.d); }
});

test('instructions: existingInstructions never reads the worktree', () => {
  const t = tmp();
  try {
    fs.writeFileSync(path.join(t.worktree, 'CLAUDE.md'), 'ORIGINAL rules');
    const snap = I.snapshotInstructions(t.worktree, t.dir);
    fs.writeFileSync(path.join(t.worktree, 'CLAUDE.md'), 'REWRITTEN by the worker, much longer than before');
    const again = I.existingInstructions(t.dir);
    assert.equal(again.path, snap.path);
    assert.equal(again.sha256, snap.sha256, 'the copy is unchanged');
    assert.equal(again.bytes, snap.bytes);
    assert.equal(fs.readFileSync(again.path, 'utf8'), 'ORIGINAL rules');
    // Even with the worktree gone entirely, the answer is the same.
    fs.rmSync(t.worktree, { recursive: true, force: true });
    assert.equal(I.existingInstructions(t.dir).sha256, snap.sha256);
  } finally { rm(t.d); }
});

test('instructions: adoption with no spawn copy returns path null', () => {
  const t = tmp();
  try {
    fs.writeFileSync(path.join(t.worktree, 'CLAUDE.md'), 'present in the worktree, but never copied');
    const r = I.existingInstructions(t.dir);
    assert.equal(r.path, null);
    assert.equal(r.reason, 'no spawn copy');
    assert.deepStrictEqual(fs.readdirSync(t.dir), [], 'adoption must not create a copy from the worktree');
  } finally { rm(t.d); }
});
