'use strict';
// memory-promote.test.cjs — `belay memory promote` and the nominations in `belay memory proposals`. The built CLI as a
// subprocess against a sandbox store planted straight into the tables, with a sandbox working directory standing in for
// the project (the instruction files live there). proposals is a read (no process, no file); promote writes and leaves
// no owner behind; belay never writes the instruction file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../../src/core/store.cjs');
const { CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const run = (args, dataDir, cwd) => spawnSync(process.execPath, [CLI, 'memory', ...args, '--data', dataDir, '--json'], { cwd, windowsHide: true, encoding: 'utf8' });
const runText = (args, dataDir, cwd) => spawnSync(process.execPath, [CLI, 'memory', ...args, '--data', dataDir], { cwd, windowsHide: true, encoding: 'utf8' });
const listDir = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length)); } };
  walk(dir);
  return out.sort();
};
const body = (dataDir, id) => { const db = new DatabaseSync(`${dataDir}/memory.db`); try { const r = db.prepare('SELECT body FROM memory_entries WHERE id = ?').get(id); return r ? JSON.parse(r.body) : null; } finally { db.close(); } };

// A nominated note with its nomination and a draft; `drafted` false leaves the draft out.
function plant(dataDir, { drafted = true, rule = 'Mock the gate in unit tests.', target = 'CLAUDE.md' } = {}) {
  const store = new Store(`${dataDir}/memory.db`, { stamp: true });
  const put = (ns, type, title, b) => store.storeIn({ namespace: ns, worker_id: 'w1', type, text: `${title} ${Math.random()}`, title, body: b, run_id: 'r1', source: type === 'note' ? 'model' : 'harness', written_by: type === 'note' ? 'worker:w1' : 'harness' }).id;
  const note = put('project/acme', 'note', 'gate lesson', { kind: 'lesson', state: 'live', seen_in: [], seen_total: 0 });
  const nom = put('nomination/acme', 'nomination', `nomination: ${note}`, { state: 'nominated', note_id: note, counts: { tasks: 3, runs: 2, sightings: 3, excluded: 0 }, keys: ['t1|worker:w1', 't2|worker:w2', 't3|worker:w3'] });
  const draft = drafted ? put('draft/acme', 'draft', 'draft rule', { state: 'draft', note_id: note, rule, target }) : null;
  store.close();
  return { note, nom, draft };
}

test('proposals lists the nominations with their drafts and whether the text is already in the file; it is a read', () => {
  const dir = sandbox(), cwd = sandbox();
  try {
    const p = plant(dir);
    fs.writeFileSync(`${cwd}/CLAUDE.md`, '# Rules\n\n- Mock the gate\n  in unit tests.\n');
    const before = listDir(dir), cwdBefore = listDir(cwd);
    const r = run(['proposals'], dir, cwd);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.counts.nominations, 1);
    assert.strictEqual(j.nominations[0].body.note_id, p.note);
    assert.deepStrictEqual([j.nominations[0].drafts[0].id, j.nominations[0].drafts[0].present], [p.draft, 'present']);
    assert.deepStrictEqual(j.promoted_check.removed, []);
    const t = runText(['proposals', '--project', 'acme'], dir, cwd);
    assert.match(t.stdout, /nominated for an instruction file/);
    assert.match(t.stdout, /3 tasks across 2 runs/);
    assert.match(t.stdout, /draft \(draft\) -> CLAUDE\.md: Mock the gate in unit tests\.\s+\[already in the file\]/);
    assert.deepStrictEqual(listDir(dir), before, 'a read creates nothing in the data dir');
    assert.deepStrictEqual(listDir(cwd), cwdBefore);
  } finally { cleanup(dir); cleanup(cwd); }
});

test('promote --approve records promoted_to, reports the file state, and never edits the file', () => {
  const dir = sandbox(), cwd = sandbox();
  try {
    const p = plant(dir);
    fs.writeFileSync(`${cwd}/CLAUDE.md`, '# Rules\n');
    const r = run(['promote', p.note, '--approve', '--reason', 'three workers found it'], dir, cwd);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.decision, j.receipt.by, j.receipt.reason, j.promoted_to.target, j.promoted_to.text], ['approve', 'operator', 'three workers found it', 'CLAUDE.md', 'Mock the gate in unit tests.']);
    assert.strictEqual(j.text_check.state, 'absent', 'the text is not in the file yet');
    assert.deepStrictEqual(body(dir, p.note).promoted_to, j.promoted_to);
    assert.strictEqual(body(dir, p.nom).state, 'promoted');
    assert.strictEqual(fs.readFileSync(`${cwd}/CLAUDE.md`, 'utf8'), '# Rules\n', 'belay does not edit the instruction file');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'no owner outlives the command');
    // once the operator adds the text the proposals read says so, and removing it is listed
    const text = runText(['promote', p.note, '--approve'], dir, cwd);
    assert.strictEqual(text.status, 1);
    assert.match(text.stderr, /not nominated/);
    const removed = JSON.parse(run(['proposals'], dir, cwd).stdout).promoted_check;
    assert.deepStrictEqual(removed.removed.map(x => x.note_id), [p.note]);
    fs.writeFileSync(`${cwd}/CLAUDE.md`, '# Rules\n\nMock the gate in unit tests.\n');
    assert.deepStrictEqual(JSON.parse(run(['proposals'], dir, cwd).stdout).promoted_check.removed, []);
    assert.match(runText(['proposals'], dir, cwd).stdout, /promoted notes whose text was removed from its file: 0 of 1/);
  } finally { cleanup(dir); cleanup(cwd); }
});

test('promote --approve says the text is already present when it is, and refuses without a draft', () => {
  const dir = sandbox(), cwd = sandbox();
  try {
    const nodraft = plant(dir, { drafted: false });
    const refused = run(['promote', nodraft.note, '--approve'], dir, cwd);
    assert.strictEqual(refused.status, 1);
    assert.match(JSON.parse(refused.stderr).error.message, /no drafted rule/);
    assert.strictEqual(body(dir, nodraft.note).promoted_to, undefined);
    const p = plant(dir, { rule: 'Keep fixtures sorted.', target: 'rules/RULES.md' });
    fs.mkdirSync(`${cwd}/rules`);
    fs.writeFileSync(`${cwd}/rules/RULES.md`, 'Keep fixtures sorted.\n');
    const t = runText(['promote', p.note, '--approve'], dir, cwd);
    assert.strictEqual(t.status, 0, t.stderr);
    assert.match(t.stdout, /the text is already in rules\/RULES\.md/);
  } finally { cleanup(dir); cleanup(cwd); }
});

test('promote --reject closes the nomination with a receipt and changes no note', () => {
  const dir = sandbox(), cwd = sandbox();
  try {
    const p = plant(dir);
    const r = run(['promote', p.note, '--reject', '--reason', 'too specific'], dir, cwd);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.decision, j.receipt.kind, j.receipt.reason, j.nomination.body.state], ['reject', 'reject', 'too specific', 'rejected']);
    assert.strictEqual(body(dir, p.nom).state, 'rejected');
    assert.strictEqual(body(dir, p.note).promoted_to, undefined);
    assert.match(runText(['promote', p.note, '--reject'], dir, cwd).stderr, /not nominated/);
    assert.ok(!fs.existsSync(`${dir}/owner.lock`));
  } finally { cleanup(dir); cleanup(cwd); }
});

test('promote needs one decision, one id, and an existing data dir', () => {
  const dir = sandbox(), cwd = sandbox();
  try {
    const both = runText(['promote', 'abc', '--approve', '--reject'], dir, cwd);
    assert.strictEqual(both.status, 2);
    assert.match(both.stderr + both.stdout, /exactly one of --approve or --reject/);
    assert.strictEqual(runText(['promote', 'abc'], dir, cwd).status, 2);
    assert.strictEqual(runText(['promote', '--approve'], dir, cwd).status, 2);
    const nowhere = runText(['promote', 'abc', '--approve'], `${dir}/missing`, cwd);
    assert.strictEqual(nowhere.status, 1);
    assert.ok(!fs.existsSync(`${dir}/missing`), 'a write verb never creates the data dir');
  } finally { cleanup(dir); cleanup(cwd); }
});
