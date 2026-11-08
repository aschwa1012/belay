'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// rerank-cpu-smoke.cjs — a real run of the CPU rerank tier on this machine. NOT part of npm test: it loads the two real
// ONNX rerankers (jina-reranker-v1-tiny-en and gte-reranker-modernbert-base, int8) through belay's pinned transformers.js
// in the forked child, so run it only when the machine is free.
// Usage: node tests/smoke/rerank-cpu-smoke.cjs <bench cache dir> <receipt dir> <notes.json>
// <bench cache dir> is a transformers.js cache holding <org>/<name>/{config.json,tokenizer.json,tokenizer_config.json,
// onnx/model_int8.onnx} for both models (the GPU bench's cache). <notes.json> is a JSON file of notes and is required.
// The model cache is a sandbox directory (BELAY_MODEL_CACHE); the bench files are hard-linked (or copied) into it and
// must pass the sha256 verify of `belay embedder verify --reranker` before anything loads. Per model it ranks 50 real
// notes for three queries (three keyword-overlap notes are the relevant ones, the rest is a fixed seeded filler) and
// checks that the relevant notes beat the filler, that the scores are not flat, and that the child ends on close. The
// receipt holds no absolute path of this machine: the sandbox, the repository, the bench, the temp and home
// directories are replaced by placeholders.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const [BENCH, OUT, NOTES] = [process.argv[2], process.argv[3], process.argv[4]];
if (!BENCH || !OUT || !NOTES) { console.error('usage: node tests/smoke/rerank-cpu-smoke.cjs <bench cache dir> <receipt dir> <notes.json>'); process.exit(2); }
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rerank-smoke-')).split(path.sep).join('/');
process.env.BELAY_MODEL_CACHE = `${SANDBOX}/models`;
const { ONNX_RERANKER_TABLE } = require(path.join(ROOT, 'src/core/onnx-rerankers.cjs'));
const embedderCmd = require(path.join(ROOT, 'src/cli/cmd-embedder.cjs'));
const K = require(path.join(ROOT, 'src/core/model-cache.cjs'));
const { CpuRerankClient, cpuRerankProvider } = require(path.join(ROOT, 'src/core/rerank-cpu.cjs'));
const { pidAlive } = require(path.join(ROOT, 'src/core/lock.cjs'));
const G = require(path.join(ROOT, 'tests/helpers/proc-gone.cjs'));

const QUERIES = [
  'stop a worker process safely by its pid',
  'how does the store owner get elected without a daemon',
  'why does a read command create journal files in the database',
];
const DEPTH = 50;
const receipt = { invocation: `node ${process.argv.slice(1).join(' ')}`, started: new Date().toISOString(), node: process.version, steps: [], models: [], checks: [] };
const step = async (name, fn) => { const t0 = Date.now(); try { const r = await fn(); receipt.steps.push({ name, ok: true, ms: Date.now() - t0, ...r }); return r; } catch (e) { receipt.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message }); throw e; } };
const check = (name, ok, detail) => { receipt.checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); return !!ok; };

const tokset = s => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
function pickPairs(notes, qi) { // three keyword-overlap notes are "relevant", the rest a seeded filler: the same proxy the bench used
  const qt = tokset(QUERIES[qi]);
  const sc = notes.map((n, i) => [[...tokset(n.text)].filter(w => qt.has(w)).length, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const rel = sc.slice(0, 3).map(x => x[1]);
  const fill = []; let x = (qi + 1) * 7919;
  while (fill.length < DEPTH - 3) { x = (x * 1103515245 + 12345) % 2147483648; const i = x % notes.length; if (!rel.includes(i) && !fill.includes(i)) fill.push(i); }
  return { rel, ids: [...rel, ...fill] };
}

// Every absolute path of this machine becomes a placeholder, in both slash styles and as escaped in JSON.
function scrub(text) {
  const subs = [[SANDBOX, '<sandbox>'], [ROOT, '<repo>'], [path.resolve(BENCH), '<bench>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']];
  let out = text;
  for (const [from, to] of subs.sort((a, b) => b[0].length - a[0].length)) {
    const fwd = from.split('\\').join('/');
    for (const v of new Set([from, fwd, from.split('\\').join('\\\\')])) out = out.split(v).join(to);
  }
  return out;
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(NOTES, 'utf8'));
  const notes = Object.entries(raw).map(([key, n]) => ({ id: n.id || key, text: n.text }));
  let allOk = true;
  for (const e of Object.values(ONNX_RERANKER_TABLE)) {
    await step(`place ${e.id}`, async () => {
      const dir = K.modelDir(e);
      for (const f of e.files) {
        const dest = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try { fs.linkSync(path.join(BENCH, e.id, f.path), dest); } catch { fs.copyFileSync(path.join(BENCH, e.id, f.path), dest); }
      }
      fs.writeFileSync(path.join(dir, K.MANIFEST), JSON.stringify({ id: e.id, sha: e.sha }));
      return { files: e.files.length };
    });
    await step(`belay embedder verify --reranker ${e.id}`, async () => {
      const r = await embedderCmd.run({ argv: ['verify', '--reranker', e.id] });
      if (r.code !== 0) throw new Error(r.text);
      return { verified: r.json.verified, total_bytes: r.json.total_bytes };
    });
  }
  for (const e of Object.values(ONNX_RERANKER_TABLE)) {
    const m = { model: e.id, sha: e.sha, dtype: e.dtype, max_length: e.max_length, queries: [] };
    receipt.models.push(m);
    const client = new CpuRerankClient({});
    const rerank = cpuRerankProvider({ model: e.id, client });
    let pid = null, pidId = null;
    try {
      await step(`${e.id}: first rerank (starts the child and loads the model)`, async () => {
        const { ids } = pickPairs(notes, 0);
        const out = await rerank({ query: QUERIES[0], docs: ids.map(i => notes[i]), depth: DEPTH, boundMs: 600000 });
        pid = client.pid;
        pidId = await G.identify(pid); // taken while the child is up: "ended" below means this process, not the number
        m.pid_is_child = pid !== process.pid;
        return { pid_alive: pidAlive(pid), scored: out.scores.length, device: out.device };
      });
      for (let qi = 0; qi < QUERIES.length; qi += 1) {
        await step(`${e.id}: query ${qi + 1}`, async () => {
          const { rel, ids } = pickPairs(notes, qi);
          const docs = ids.map(i => notes[i]);
          const out = await rerank({ query: QUERIES[qi], docs, depth: DEPTH, boundMs: 120000 });
          const score = new Map(out.scores.map(s => [s.id, s.score]));
          const relScores = rel.map(i => score.get(notes[i].id)), fillScores = ids.slice(3).map(i => score.get(notes[i].id));
          const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
          const all = out.scores.map(s => s.score), spread = Math.max(...all) - Math.min(...all);
          const top5 = out.scores.slice(0, 5).map(s => s.id), relInTop5 = rel.filter(i => top5.includes(notes[i].id)).length;
          const q = { query: QUERIES[qi], ms: out.ms, relevant_ids: rel.map(i => notes[i].id), relevant_scores: relScores, relevant_mean: mean(relScores), filler_mean: mean(fillScores), spread, relevant_in_top5: relInTop5, warnings: out.warnings || null };
          m.queries.push(q);
          const sorted = out.scores.every((s, i) => i === 0 || out.scores[i - 1].score >= s.score);
          const ok = [
            check(`${e.id} q${qi + 1}: output is sorted best first`, sorted),
            check(`${e.id} q${qi + 1}: the relevant notes beat the filler on average`, q.relevant_mean > q.filler_mean, `${q.relevant_mean.toFixed(3)} against ${q.filler_mean.toFixed(3)}`),
            check(`${e.id} q${qi + 1}: at least two of three relevant notes are in the top five`, relInTop5 >= 2, `${relInTop5} of 3`),
            check(`${e.id} q${qi + 1}: the scores are not flat`, spread > 0.05, `spread ${spread.toFixed(3)}`),
            check(`${e.id} q${qi + 1}: every score is a finite number in [0, 1]`, all.every(v => Number.isFinite(v) && v >= 0 && v <= 1)),
          ].every(Boolean);
          if (!ok) allOk = false;
          return { ok };
        });
      }
      await step(`${e.id}: ping`, async () => { const p = await client.ping(5000); if (!p.ok) throw new Error(p.reason); return { pid: p.pid === pid, models: p.models }; });
    } finally {
      await rerank.close();
      if (pid) check(`${e.id}: the child ended on close`, await G.waitGone(pidId, { deadlineMs: 5000 }));
    }
  }
  receipt.all_ok = allOk && receipt.checks.every(c => c.ok);
})().catch((e) => { receipt.fatal = e.message; receipt.all_ok = false; }).finally(() => {
  receipt.finished = new Date().toISOString();
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `rerank-cpu-smoke-${receipt.started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(f, scrub(`${JSON.stringify(receipt, null, 2)}\n`));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`${receipt.all_ok ? 'ok' : 'FAILED'}: receipt ${path.relative(ROOT, f).split(path.sep).join('/')}`);
  process.exit(receipt.all_ok ? 0 : 1);
});
