'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// memory-embed.test.cjs — notes stored without a vector (on_embedder_failure keyword): `belay status` and `belay notices` show the
// count with a pointer to `belay memory embed`, and `belay memory embed` is the only thing that embeds them. The command modules run
// in process over the real core; the owner's embedder is a fake that gives the notes vectors the test chooses.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');

const memory = require('../../src/cli/cmd-memory.cjs');
const status = require('../../src/cli/cmd-status.cjs');
const notices = require('../../src/cli/cmd-notices.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { Store } = require('../../src/core/store.cjs');
const { sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const DIM = 16;
const vecOf = text => {
  const m = /\bK(\d+)(x?)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  if (!m) v[DIM - 1] = 1; else if (m[2]) { v[Number(m[1])] = 0.99; v[0] = 0.141; } else v[Number(m[1])] = 1;
  return v;
};
let embeds = 0, down = null;
const fakeEmbedder = {
  embed: async (text) => {
    embeds += 1;
    return { embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
  },
};
// The real core; once this process owns the store its embedder is the fake, or refuses to load when `down` names why.
async function fakeOpen(opts) {
  const core = await openCore(opts);
  const ensureWriter = core._ensureWriter.bind(core);
  core._ensureWriter = async () => {
    const r = await ensureWriter();
    if (core.owner && !core.owner.fakeEmbedder) {
      core.owner.fakeEmbedder = true;
      core.owner.getEmbedder = async () => {
        if (down) throw Object.assign(new Error(down), { code: 'E_MODEL_ABSENT', detail: { embedder: true, cause: 'absent' } });
        core.owner.embedInfo = { model: 'fake', load_ms: 1, pid: 1 };
        return fakeEmbedder;
      };
    }
    return r;
  };
  return core;
}

let dir, dataDir;
const ctxOf = (argv) => ({ argv, cwd: dir, dataDir, dataDirGiven: true, json: false, openCore: fakeOpen });
const embed = (...argv) => memory.run(ctxOf(['embed', ...argv]));
// Every memory row as stored: electing an owner touches the file (heartbeat, checkpoint), so a command that elected one is compared by its rows.
const rowsDump = () => JSON.stringify(withStore(s => s.p('SELECT * FROM memory_entries ORDER BY id').all().map(r => ({ ...r, embedding: r.embedding ? Buffer.from(r.embedding).toString('hex') : null }))));
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(`${dataDir}/memory.db`)).digest('hex');
const withStore = (fn) => { const s = new Store(`${dataDir}/memory.db`); try { return fn(s); } finally { s.close(); } };

const noteRow = (marker, project, vec) => ({
  namespace: `project/${project}`, worker_id: 'w1', type: 'note', title: `the ${marker} loader skips unlisted fixtures`, text: `the ${marker} loader skips unlisted fixtures`,
  body: { kind: 'lesson', basis: 'observed', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] }, source: 'model', written_by: 'worker:w1', run_id: 'r1',
  ...(vec ? { embedding: vecOf(marker), embedding_model: 'fake', embedding_revision: 'r', dim: DIM } : {}),
});

before(() => {
  dir = sandbox();
  dataDir = `${dir}/.belay`;
  const s = new Store(`${dataDir}/memory.db`, { stamp: true });
  try {
    s.store(noteRow('K1', 'acme', true)); // a live embedded note
    s.store(noteRow('K1x', 'acme', false)); // a near-duplicate of it, bare
    s.store(noteRow('K2', 'acme', false)); // distinct, bare
    s.store(noteRow('K5', 'other', false)); // another project's bare note
  } finally { s.close(); }
});
after(() => cleanup(dir));

test('status and notices show the count of bare notes with a pointer to belay memory embed, reading nothing into the data dir', async () => {
  const names = listRecursive(dataDir), hash = sha();
  const st = await status.run({ argv: [], cwd: dir, dataDir, dataDirGiven: true });
  assert.strictEqual(st.code, 0, st.text);
  assert.deepStrictEqual([st.json.notes_unembedded.total, st.json.notes_unembedded.by_project], [3, { acme: 2, other: 1 }]);
  assert.match(st.text, /3 notes unembedded \(acme 2, other 1\): embed with belay memory embed --project <p>/);

  const nt = await notices.run({ argv: [], cwd: dir, dataDir, dataDirGiven: true });
  assert.strictEqual(nt.code, 0, nt.text);
  const ev = nt.json.events.find(e => e.kind === 'notes_unembedded');
  assert.ok(ev, 'a notes_unembedded notice');
  assert.deepStrictEqual([ev.count, ev.by_project, ev.command], [3, { acme: 2, other: 1 }, 'belay memory embed']);
  assert.ok(ev.ts > 0);
  assert.match(nt.text, /3 notes unembedded/);

  assert.deepStrictEqual(listRecursive(dataDir), names, 'no file was created');
  assert.strictEqual(sha(), hash, 'memory.db is byte for byte what it was');
});

test('with no bare notes neither status nor notices says anything about them', async () => {
  const d2 = `${dir}/clean/.belay`;
  const s = new Store(`${d2}/memory.db`, { stamp: true });
  try { s.store(noteRow('K1', 'acme', true)); } finally { s.close(); }
  const st = await status.run({ argv: [], cwd: dir, dataDir: d2, dataDirGiven: true });
  assert.strictEqual(st.json.notes_unembedded.total, 0);
  assert.doesNotMatch(st.text, /unembedded/);
  const nt = await notices.run({ argv: [], cwd: dir, dataDir: d2, dataDirGiven: true });
  assert.ok(!nt.json.events.some(e => e.kind === 'notes_unembedded'));
});

test('embed with no project says which projects have bare notes, and elects nothing', async () => {
  const names = listRecursive(dataDir);
  const r = await embed();
  assert.strictEqual(r.code, 2, r.text);
  assert.match(r.text, /no project: pass --project <p>.*acme 2, other 1/);
  assert.deepStrictEqual(listRecursive(dataDir), names);
});

test('--dry-run lists the ids and subjects, writes nothing, and starts no owner', async () => {
  const names = listRecursive(dataDir), hash = sha(), calls = embeds;
  const r = await embed('--project', 'acme', '--dry-run');
  assert.strictEqual(r.code, 0, r.text);
  assert.deepStrictEqual([r.json.dry_run, r.json.found, r.json.notes.length], [true, 2, 2]);
  assert.match(r.text, /K1x loader skips unlisted fixtures/);
  assert.match(r.text, /nothing was written/);
  assert.deepStrictEqual(listRecursive(dataDir), names, 'no owner.lock, no journal');
  assert.strictEqual(sha(), hash);
  assert.strictEqual(embeds, calls);
});

test('the embedder failing to load refuses loudly with the reason and writes nothing', async () => {
  const before = rowsDump();
  down = 'the model files are absent';
  try {
    const r = await embed('--project', 'acme');
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(r.json.error.code, 'E_MODEL_ABSENT');
    assert.match(r.json.error.message, /the embedder cannot load, so nothing was embedded or written: the model files are absent/);
    assert.ok(r.json.error.fix);
    assert.strictEqual(r.json.error.written, 0);
  } finally { down = null; }
  assert.strictEqual(rowsDump(), before, 'every row is exactly as it was');
  assert.ok(!fs.existsSync(`${dataDir}/owner.lock`) && !fs.existsSync(`${dataDir}/owner.json`), 'the elected owner was shut down');
  assert.strictEqual(withStore(s => s.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND embedding IS NULL").get().n), 3);
});

test('a real embed writes the vectors, records the matches the hand-back would, and returns the receipt', async () => {
  const r = await embed('--project', 'acme');
  assert.strictEqual(r.code, 0, r.text);
  const j = r.json;
  assert.deepStrictEqual([j.project, j.found, j.embedded.length, j.failed.length, j.already_embedded.length], ['acme', 2, 2, 0, 0]);
  assert.ok(j.elapsed_ms >= 0);
  const k1x = j.embedded.find(n => /K1x/.test(n.title)), k2 = j.embedded.find(n => /K2 /.test(n.title));
  assert.deepStrictEqual([k1x.state, k1x.namespace, k1x.matches.length], ['stored', 'project/acme', 1], 'it stays live where it was');
  assert.deepStrictEqual([k2.state, k2.namespace, k2.matches], ['stored', 'project/acme', []]);
  assert.deepStrictEqual(j.with_matches, [k1x.id]);
  assert.match(j.embed_run, /^embed-/);
  assert.strictEqual(j.matches_recorded, 1);
  assert.deepStrictEqual([j.levers.notes_match_threshold, j.levers.notes_match_n, j.levers.source], [0.8, 3, 'default']);
  assert.match(r.text, /embedded 2, failed 0/);
  assert.match(r.text, /1 match recorded/);
  assert.match(r.text, /every note stays where it was/);

  assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'the owner this command elected was shut down');
  withStore(s => {
    for (const n of j.embedded) {
      const row = s.p('SELECT embedding, namespace, body FROM memory_entries WHERE id = ?').get(n.id);
      assert.ok(row.embedding, `${n.id} has its vector`);
      assert.strictEqual(row.namespace, n.namespace);
    }
    const body = JSON.parse(s.p('SELECT body FROM memory_entries WHERE id = ?').get(k1x.id).body);
    assert.deepStrictEqual([body.state, body.matches.length], ['live', 1]);
    assert.strictEqual(s.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note'").get().n, 4, 'nothing was merged or deleted');
  });
  // the other project's bare note was not touched
  assert.strictEqual(withStore(s => s.p("SELECT COUNT(*) AS n FROM memory_entries WHERE embedding IS NULL").get().n), 1);
});

test('re-running embeds nothing new and does not even load the embedder', async () => {
  const hash = sha(), calls = embeds;
  down = 'must not be asked'; // a run that asked for the embedder would fail here
  try {
    const r = await embed('--project', 'acme');
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.found, r.json.embedded.length, r.json.failed.length], [0, 0, 0]);
    assert.match(r.text, /no unembedded notes in project acme/);
  } finally { down = null; }
  assert.strictEqual(embeds, calls);
  assert.strictEqual(sha(), hash);
  const st = await status.run({ argv: [], cwd: dir, dataDir, dataDirGiven: true });
  assert.deepStrictEqual(st.json.notes_unembedded.by_project, { other: 1 }, 'status counts what is left');
});

test('the config\'s project and match levers are used when no --project is given', async () => {
  fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ data_dir: '.belay', memory: { project: 'other', notes_match_threshold: 0.999, notes_match_n: 2 } }));
  try {
    const r = await embed();
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.project, r.json.embedded.length], ['other', 1]);
    assert.deepStrictEqual([r.json.levers.notes_match_threshold, r.json.levers.notes_match_n], [0.999, 2]);
    assert.match(r.json.levers.source, /belay\.config\.json$/);
  } finally { fs.rmSync(`${dir}/belay.config.json`); }
});

test('a bad project name is a usage error', async () => {
  const r = await embed('--project', 'Bad Name');
  assert.strictEqual(r.code, 2);
  assert.match(r.text, /--project must be a project name/);
});

test('a malformed config memory block or lever is refused loudly, never replaced by a default', async () => {
  const hash = sha();
  for (const [memory, re] of [[{ notes_match_threshold: 'high' }, /notes_match_threshold must be a number/], [{ notes_match_n: 99 }, /notes_match_n must be an integer/], [{ nonsense: 1 }, /not a known memory lever/]]) {
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ data_dir: '.belay', memory: { project: 'other', ...memory } }));
    try {
      const r = await embed();
      assert.strictEqual(r.code, 2, r.text);
      assert.match(r.json.error.message, re);
      assert.match(r.json.error.message, /belay\.config\.json/);
    } finally { fs.rmSync(`${dir}/belay.config.json`); }
  }
  fs.writeFileSync(`${dir}/belay.config.json`, '{ not json');
  try { assert.strictEqual((await embed('--project', 'other')).code, 2); } finally { fs.rmSync(`${dir}/belay.config.json`); }
  assert.strictEqual(sha(), hash);
});
