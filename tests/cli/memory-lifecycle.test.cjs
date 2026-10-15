'use strict';
// memory-lifecycle.test.cjs — `belay memory proposals|restore|archive purge`. The built CLI as a subprocess against a
// sandbox store planted straight into the tables; proposals and restore --candidates are reads (no process, no file),
// restore and purge write and leave no owner behind.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../../src/core/store.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const cli = (args, dataDir) => spawnSync(process.execPath, [CLI, 'memory', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
const listDir = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length)); } };
  walk(dir);
  return out.sort();
};

function plant(dataDir) {
  const store = new Store(`${dataDir}/memory.db`, { stamp: true });
  const put = (ns, type, title, body) => store.storeIn({ namespace: ns, worker_id: 'w1', type, text: `${title} ${Math.random()}`, title, body, run_id: 'r1', source: 'harness', written_by: 'harness' }).id;
  const out = {
    kept: put('project/acme', 'note', 'kept note', { state: 'live' }),
    dupe: put('archive/acme', 'note', 'archived duplicate', { state: 'archived', archived: { at: Date.now(), kind: 'duplicate', of: null, reason: 'same claim', review: 'review:r1:h1' } }),
    gone: put('archive/acme', 'note', 'archived wrong', { state: 'archived', archived: { at: Date.now(), kind: 'wrong', reason: 'contradicted', review: 'review:r1:h2' } }),
    held: put('held/acme', 'held', 'held wrong: n9', { state: 'held', note_id: 'n9', kind: 'wrong', reason: 'contradicted' }),
    prop: put('proposal/acme', 'proposal', 'proposal: hold n8', { state: 'open', note_id: 'n8', entry: { action: 'hold', kind: 'duplicate', of: 'n1' } }),
  };
  store.db.prepare("UPDATE memory_entries SET body = json_set(body, '$.archived.of', ?) WHERE id = ?").run(out.kept, out.dupe);
  store.close();
  return out;
}
const nsOf = (dataDir, id) => { const db = new DatabaseSync(`${dataDir}/memory.db`); try { const r = db.prepare('SELECT namespace FROM memory_entries WHERE id = ?').get(id); return r ? r.namespace : null; } finally { db.close(); } };

test('proposals lists the held queue, proposals and drafts, and a read creates no file', () => {
  const dir = sandbox();
  try {
    const p = plant(dir);
    const before = listDir(dir);
    const r = cli(['proposals'], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.counts.held, j.counts.proposals, j.counts.drafts], [1, 1, 0]);
    assert.strictEqual(j.held[0].id, p.held);
    assert.strictEqual(j.proposals[0].id, p.prop);
    assert.deepStrictEqual(listDir(dir), before, 'a read creates nothing in the data dir');
    const text = spawnSync(process.execPath, [CLI, 'memory', 'proposals', '--project', 'acme', '--data', dir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(text.stdout, /held \(waiting on the reviewer\)/);
    assert.match(text.stdout, /hold duplicate n8 of n1/);
    assert.deepStrictEqual(listDir(dir), before);
  } finally { cleanup(dir); }
});

test('restore --candidates lists the archived duplicates of a note, as a read', () => {
  const dir = sandbox();
  try {
    const p = plant(dir);
    const before = listDir(dir);
    const r = cli(['restore', p.kept, '--candidates'], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout).candidates.map(c => c.id), [p.dupe]);
    assert.deepStrictEqual(listDir(dir), before);
  } finally { cleanup(dir); }
});

test('restore needs a reason, writes the receipt, and leaves no owner behind', () => {
  const dir = sandbox();
  try {
    const p = plant(dir);
    assert.strictEqual(cli(['restore', p.dupe], dir).status, 2);
    const r = cli(['restore', p.dupe, '--reason', 'the kept note was refuted'], dir);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.id, j.restored, j.receipt.reason], [p.dupe, true, 'the kept note was refuted']);
    assert.strictEqual(nsOf(dir, p.dupe), 'project/acme');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'no owner outlives the command');
    const again = cli(['restore', p.dupe, '--reason', 'again'], dir);
    assert.strictEqual(again.status, 1);
    assert.strictEqual(JSON.parse(again.stderr).error.code, 'E_NOT_FOUND');
  } finally { cleanup(dir); }
});

test('archive purge needs one selector and --confirm, writes the file with its sha256, and removes only archived notes', () => {
  const dir = sandbox();
  try {
    const p = plant(dir);
    assert.strictEqual(cli(['archive', 'purge', '--ids', p.gone], dir).status, 2, 'no --confirm');
    assert.strictEqual(cli(['archive', 'purge', '--confirm'], dir).status, 2, 'no selector');
    assert.strictEqual(cli(['archive', 'purge', '--ids', p.gone, '--older-than', '3', '--confirm'], dir).status, 2, 'two selectors');
    assert.strictEqual(cli(['archive', 'prune', '--ids', p.gone, '--confirm'], dir).status, 2, 'unknown action');
    assert.ok(nsOf(dir, p.gone), 'nothing was removed by the refusals');
    const r = cli(['archive', 'purge', '--ids', `${p.gone},${p.kept}`, '--confirm'], dir);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.count, 1);
    assert.deepStrictEqual(j.skipped, [{ id: p.kept, reason: 'not an archived note' }]);
    assert.strictEqual(j.sha256, crypto.createHash('sha256').update(fs.readFileSync(j.path)).digest('hex'));
    assert.match(j.path, /archive-purged-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.strictEqual(JSON.parse(fs.readFileSync(j.path, 'utf8').trim()).id, p.gone);
    assert.strictEqual(nsOf(dir, p.gone), null);
    assert.strictEqual(nsOf(dir, p.kept), 'project/acme', 'a live note is never purged');
    assert.ok(nsOf(dir, p.dupe), 'unnamed archived notes stay');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`));
  } finally { cleanup(dir); }
});
