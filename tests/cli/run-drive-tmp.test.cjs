'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// The drive-root tmp record: the run receipt names what appeared in the folder while the run was going. A sandbox folder
// stands in for C:\tmp through BELAY_DRIVE_TMP_DIR (test mode only); the real folder is never read or written here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DT = require('../../src/run/drive-tmp.cjs');
const H = require('./stop-helpers.cjs');
const { ROOT, sandbox, cleanup, makeSpec, waitUntil } = H;
const fwd = (p) => String(p).split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_NOREADY = `${ROOT}/tests/run/fakes/fake-claude-noready.cjs`;

// A run that fails to start still writes run.json; the file appears once the owner lock does, which is after the start listing.
async function runWith(dir, tmpDir, extraEnv, during) {
  const dataDir = `${dir}/.belay`;
  const { specPath, orchestratorDir } = makeSpec(dir, { startup_timeout_ms: 8000 });
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE_NOREADY, BELAY_DRIVE_TMP_DIR: tmpDir, ...extraEnv };
  const proc = spawn(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], { cwd: ROOT, env, windowsHide: true });
  let out = ''; let err = '';
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => proc.once('exit', r));
  if (during) {
    assert.ok(await waitUntil(() => fs.existsSync(`${dataDir}/owner.lock`), 30000), 'the run never took the owner lock');
    during();
  }
  await exited;
  const text = fs.readFileSync(`${orchestratorDir}/run.json`, 'utf8');
  return { receipt: JSON.parse(text), stdout: out, stderr: err };
}

test('drive tmp: a file created during a run is in the receipt, an old one is not', async () => {
  const dir = sandbox();
  const tmpDir = `${dir}/drive-tmp`;
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(`${tmpDir}/old.txt`, 'before');
  try {
    const { receipt } = await runWith(dir, tmpDir, {}, () => fs.writeFileSync(`${tmpDir}/made-during.txt`, 'abc'));
    const d = receipt.drive_tmp;
    assert.ok(d, 'the receipt has no drive_tmp block');
    assert.strictEqual(d.scanned, true);
    assert.strictEqual(d.truncated, false);
    assert.deepStrictEqual(d.new_or_changed.map((e) => e.path), ['made-during.txt']);
    assert.strictEqual(d.new_or_changed[0].change, 'new');
    assert.strictEqual(d.new_or_changed[0].size, 3);
    assert.strictEqual(d.new_or_changed_count, 1);
    assert.ok(fs.existsSync(`${tmpDir}/made-during.txt`), 'the record deleted nothing');
  } finally { cleanup(dir); }
});

test('drive tmp: an absent folder gives scanned false and a reason, and the run is otherwise unchanged', async () => {
  const dir = sandbox();
  try {
    const { receipt } = await runWith(dir, `${dir}/no-such-folder`, {});
    assert.strictEqual(receipt.drive_tmp.scanned, false);
    assert.match(receipt.drive_tmp.reason, /does not exist/);
    assert.strictEqual(receipt.drive_tmp.truncated, false);
  } finally { cleanup(dir); }
});

test('drive tmp: a scan past the cap says truncated', async () => {
  const dir = sandbox();
  const tmpDir = `${dir}/drive-tmp`;
  fs.mkdirSync(tmpDir);
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(`${tmpDir}/f${i}.txt`, 'x');
  try {
    const { receipt } = await runWith(dir, tmpDir, { BELAY_DRIVE_TMP_CAP: '3' });
    assert.strictEqual(receipt.drive_tmp.scanned, true);
    assert.strictEqual(receipt.drive_tmp.truncated, true);
    assert.strictEqual(receipt.drive_tmp.entries_at_end, 3);
  } finally { cleanup(dir); }
});

test('drive tmp: new and changed entries are told apart, nested ones are seen, the list is bounded and the count whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-drive-tmp-'));
  try {
    fs.writeFileSync(`${dir}/keep.txt`, 'one');
    fs.writeFileSync(`${dir}/grow.txt`, 'one');
    fs.mkdirSync(`${dir}/sub`);
    const before = DT.snapshot(fwd(dir));
    fs.writeFileSync(`${dir}/grow.txt`, 'one two');
    fs.writeFileSync(`${dir}/sub/inner.txt`, 'x');
    for (let i = 0; i < DT.LISTED + 5; i += 1) fs.writeFileSync(`${dir}/n${i}.txt`, 'x');
    const d = DT.receiptBlock(before, DT.snapshot(fwd(dir))).drive_tmp;
    const paths = d.new_or_changed.map((e) => e.path);
    assert.ok(!paths.includes('keep.txt'));
    assert.ok(d.new_or_changed_count >= DT.LISTED + 5 + 2, `the new files, grow.txt and sub/inner.txt are all counted: ${d.new_or_changed_count}`); // sub itself may or may not show a moved mtime: mkdir, the snapshot and the write can fall in one timestamp tick
    assert.strictEqual(d.new_or_changed.length, DT.LISTED);
    assert.strictEqual(d.listed_truncated, true);
    const solo = DT.receiptBlock(before, DT.snapshot(fwd(dir), 1000)).drive_tmp;
    assert.ok(solo.new_or_changed_count > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drive tmp: a file nested one level down is named in the list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-drive-tmp-'));
  try {
    fs.mkdirSync(`${dir}/sub`);
    const before = DT.snapshot(fwd(dir));
    fs.writeFileSync(`${dir}/sub/inner.txt`, 'x');
    const d = DT.receiptBlock(before, DT.snapshot(fwd(dir))).drive_tmp;
    const inner = d.new_or_changed.find((e) => e.path === 'sub/inner.txt');
    assert.ok(inner, `sub/inner.txt is not in the list: ${JSON.stringify(d.new_or_changed)}`);
    assert.strictEqual(inner.change, 'new');
    assert.ok(d.new_or_changed.length < DT.LISTED);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drive tmp: a link is listed but never followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-drive-tmp-'));
  try {
    fs.mkdirSync(`${dir}/target`);
    fs.writeFileSync(`${dir}/target/inside.txt`, 'x');
    fs.mkdirSync(`${dir}/tmp`);
    fs.symlinkSync(`${dir}/target`, `${dir}/tmp/jct`, 'junction');
    const s = DT.snapshot(fwd(`${dir}/tmp`));
    assert.ok(s.entries.has('jct'), 'the link is listed');
    assert.strictEqual(s.entries.get('jct').link, true);
    assert.strictEqual(s.entries.get('jct').dir, false);
    assert.ok(![...s.entries.keys()].some((k) => k.startsWith('jct/')), 'nothing under the link was read');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drive tmp: the cap stops the read itself, not only the stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-drive-tmp-'));
  const realOpen = fs.opendirSync;
  let reads = 0;
  try {
    fs.mkdirSync(`${dir}/big`);
    for (let i = 0; i < 40; i += 1) fs.writeFileSync(`${dir}/big/f${i}`, 'x');
    fs.opendirSync = (...a) => {
      const d = realOpen(...a);
      const rs = d.readSync.bind(d);
      d.readSync = () => { reads += 1; return rs(); };
      return d;
    };
    const s = DT.snapshot(fwd(dir), 5);
    assert.strictEqual(s.truncated, true);
    assert.ok(s.entries.size <= 5);
    assert.ok(reads <= 5 + 3, `the read went on past the cap: ${reads} reads for 41 names`);
  } finally { fs.opendirSync = realOpen; fs.rmSync(dir, { recursive: true, force: true }); }
});
