'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// memory-reembed.test.cjs — `belay memory embed --reembed --template v2`: the operator rebuilds the vector of a note embedded
// before the `when` field from its title and When: line, only where a `when` exists. A v1 note without one stays v1 and the
// receipt says so. The listing and the dry run write nothing and elect no owner; a real run is the only write. The command
// modules run in process over the real core; the owner's embedder is a fake that records the text it was asked for.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');

const memory = require('../../src/cli/cmd-memory.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { Store } = require('../../src/core/store.cjs');
const { sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const DIM = 16;
const vecOf = (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  if (text.includes('When:')) v[DIM - 2] = 0.5;
  return v;
};
const asked = [];
let down = null;
const fakeEmbedder = { embed: async (text) => { asked.push(text); return { embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM }; } };
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
const ctxOf = (argv, json = false) => ({ argv, cwd: dir, dataDir, dataDirGiven: true, json, openCore: fakeOpen });
const embed = (...argv) => memory.run(ctxOf(['embed', ...argv]));
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(`${dataDir}/memory.db`)).digest('hex');
const withStore = (fn) => { const s = new Store(`${dataDir}/memory.db`); try { return fn(s); } finally { s.close(); } };
const snap = (id) => withStore((s) => { const r = s.p('SELECT embedding, text_template, text, updated_at FROM memory_entries WHERE id = ?').get(id); return { embedding: Buffer.from(r.embedding).toString('hex'), tpl: r.text_template, text: r.text, updated_at: r.updated_at }; });

const legacy = (marker) => `the ${marker} legacy note\napplies to: src/${marker}.js\nevidence: src/${marker}.js - saw it`;
const ids = {};
const put = (s, marker, project, when, template) => {
  const text = legacy(marker);
  const body = { kind: 'lesson', basis: 'observed', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [], ...(when ? { when } : {}) };
  return s.store({ namespace: `project/${project}`, worker_id: 'w1', type: 'note', title: `the ${marker} legacy note`, text, body, source: 'model', written_by: 'worker:w1', run_id: 'r1', embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM, text_template: template }).id;
};

before(() => {
  dir = sandbox();
  dataDir = `${dir}/.belay`;
  const s = new Store(`${dataDir}/memory.db`, { stamp: true });
  try {
    ids.plain = put(s, 'K1', 'acme', null, undefined); // an old note: no when, v1
    ids.withWhen = put(s, 'K2', 'acme', 'rebuild the K2 index', 'v1'); // has a when, still a whole-text vector
    ids.done = put(s, 'K3', 'acme', 'rotate the K3 keys', 'v2'); // already v2
    ids.other = put(s, 'K4', 'other', 'repair the K4 cache', 'v1'); // another project's
  } finally { s.close(); }
});
after(() => cleanup(dir));

test('--template needs --reembed, and --reembed needs --template v2 and a project; each is refused before anything runs', async () => {
  const names = listRecursive(dataDir);
  const a = await embed('--project', 'acme', '--template', 'v2');
  assert.strictEqual(a.code, 2, a.text);
  assert.match(a.text, /--template goes with --reembed/);
  const b = await embed('--project', 'acme', '--reembed');
  assert.strictEqual(b.code, 2, b.text);
  assert.match(b.text, /needs --template v2/);
  const c = await embed('--project', 'acme', '--reembed', '--template', 'v1');
  assert.strictEqual(c.code, 2, c.text);
  const d = await embed('--reembed', '--template', 'v2');
  assert.strictEqual(d.code, 2, d.text);
  assert.match(d.text, /no project/);
  assert.deepStrictEqual(listRecursive(dataDir), names);
});

test('--dry-run lists what would be rebuilt and what stays v1, writes nothing and elects no owner', async () => {
  const names = listRecursive(dataDir), hash = sha(), n = asked.length;
  const r = await embed('--project', 'acme', '--reembed', '--template', 'v2', '--dry-run');
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /dry run: project acme, template v2: 3 embedded notes; 1 already v2, 1 would be rebuilt, 1 stays v1 \(no when\)/);
  assert.match(r.text, new RegExp(`would rebuild ${ids.withWhen}`));
  assert.match(r.text, new RegExp(`stays v1 ${ids.plain}\\s+no when to build it from`));
  assert.match(r.text, /nothing was written/);
  assert.deepStrictEqual(listRecursive(dataDir), names, 'no file was created');
  assert.strictEqual(sha(), hash, 'memory.db is byte for byte what it was');
  assert.strictEqual(asked.length, n, 'the embedder was not asked');
});

test('a real run rebuilds only the note with a when, leaves the v1 note without one and the other project alone, and says so', async () => {
  const before = { plain: snap(ids.plain), withWhen: snap(ids.withWhen), done: snap(ids.done), other: snap(ids.other) };
  asked.length = 0;
  const r = await memory.run(ctxOf(['embed', '--project', 'acme', '--reembed', '--template', 'v2'], true));
  assert.strictEqual(r.code, 0, r.text);
  assert.deepStrictEqual(r.json.rebuilt.map((n) => [n.id, n.from, n.to]), [[ids.withWhen, 'v1', 'v2']]);
  assert.deepStrictEqual(r.json.stays.map((n) => [n.id, n.reason]), [[ids.plain, 'no_when']]);
  assert.deepStrictEqual([r.json.failed, r.json.skipped], [[], []]);
  assert.match(r.text, new RegExp(`rebuilt ${ids.withWhen}`));
  assert.match(r.text, new RegExp(`stays v1 ${ids.plain}`));
  assert.deepStrictEqual(asked, ['the K2 legacy note\nWhen: rebuild the K2 index']);
  const after = { plain: snap(ids.plain), withWhen: snap(ids.withWhen), done: snap(ids.done), other: snap(ids.other) };
  assert.deepStrictEqual(after.plain, before.plain, 'the v1 note without a when is untouched');
  assert.deepStrictEqual(after.done, before.done);
  assert.deepStrictEqual(after.other, before.other, 'another project is not touched');
  assert.strictEqual(after.withWhen.tpl, 'v2');
  assert.notStrictEqual(after.withWhen.embedding, before.withWhen.embedding);
  assert.strictEqual(after.withWhen.text, before.withWhen.text);
});

test('running it again finds nothing to rebuild', async () => {
  asked.length = 0;
  const r = await embed('--project', 'acme', '--reembed', '--template', 'v2');
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /2 already v2, 0 to rebuild, 1 stays v1/);
  assert.deepStrictEqual(asked, []);
});

test('with the embedder unable to load, nothing is rebuilt or written and the run says so', async () => {
  down = 'the model is not on this machine';
  try {
    const r = await embed('--project', 'other', '--reembed', '--template', 'v2');
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /embedder cannot load, so nothing was rebuilt or written/);
  } finally { down = null; }
  assert.strictEqual(snap(ids.other).tpl, 'v1');
});
