'use strict';
// gpu-probe.cjs — the probe before any GPU model loads (ADR 0049 decision 6). It runs at setup, on a settings
// change and at run start, never on a search, and only from the store owner or a CLI verb that writes (it calls
// nvidia-smi, which no read path may do; invariant 9, tests/core/gpu-import-graph.test.cjs). It
//   1. finds a discrete GPU through the Vulkan device list the GPU child reports;
//   2. counts DEDICATED memory only;
//   3. loads the requested models into one child, runs a test batch on each, and measures each one's peak;
//   4. compares the SUM of the peaks plus headroom against free dedicated memory;
//   5. derives the rerank chunk size from the measured cost per pair;
//   6. records each peak keyed by model, settings and driver version.
// It returns a structured result and never throws: no runtime, a missing model file, no GPU, a dead child, a
// failed sanity check or too little memory is { ok: false, refusal: { reason, message, options } }.
//
// Dedicated memory. node-llama-cpp's getVramState sums every Vulkan device's memory heap, and an integrated GPU's
// heap is a slice of system RAM. On the reference laptop (RTX 5060 8 GB beside an AMD iGPU) it reports total
// 25,526,403,072 bytes with unifiedSize 17,243,701,248: the iGPU's shared heap is `unifiedSize`, so
//   dedicated = total - unifiedSize = 8,282,701,824 bytes = 7,899 MiB,
// which is what nvidia-smi reports as the card's free memory (memory.total is 8,151 MiB; the difference is the
// driver's own reservation). `used` is the same aggregate, and an iGPU's use is in it, so free dedicated memory
// is NOT total - unifiedSize - used. With nvidia-smi present (C:/Windows/System32, called here and nowhere on a
// read path) free is its memory.free for the card with the most memory, cross-checked against the Vulkan figure.
// Without it, free is the Vulkan dedicated total minus the aggregate used, which can only under-count.
// A model's peak is its own growth: the aggregate `used` after its load and test batch minus before (the larger
// of that and nvidia-smi's growth when present). The set's measured growth is also reported beside the sum.
//
// Chunk size. A rerank is sent in chunks sized so one submission stays well under the Windows TDR limit (about
// 2 s): chunk = floor(target / (ms per pair x margin)), the pair cost measured warm on 16 notes of ordinary length,
// the margin covering notes twice as long, clamped to 1..50 (the rerank depth).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ggufFor, GGUF_MODELS } = require('./gguf-models.cjs');
const { GpuClient } = require('./gpu.cjs');
const K = require('./model-cache.cjs');
const R = require('./gpu-runtime.cjs');

const MIB = 1048576;
const HEADROOM_MB = 768; // 0.75 GB (the vram_headroom_gb lever's default)
const CHUNK_TARGET_MS = 1000;
const CHUNK_MARGIN = 2;
const CHUNK_MAX = 50;
const NVIDIA_SMI = 'C:/Windows/System32/nvidia-smi.exe';
const PEAKS_FILE = 'probe-peaks.json';

const QUERY = 'how do I stop a worker by its pid';
const SANITY_DOCS = [
  'Stop a process by its exact process id, never by matching a command line.', // relevant
  'The cat sat on the mat and ate lunch.',                                       // filler
  'Kill names the process it means: a pid, its creation time and its image.',   // relevant
  'Recipe: boil water, add pasta and salt, and wait ten minutes.',               // filler
];
const SANITY_RELEVANT = [0, 2];
const FILLER = [
  'The release checklist asks for a changelog entry, a version bump and a tag on the commit that passed CI, then a draft of the notes for the public repository.',
  'A migration that renumbers the ledger files must copy each file first, check its hash, and only then remove the old name, so a crash leaves both.',
  'Journal sidecars appear beside the database whenever it is opened for reading in the plain mode, which is why a reader copies the files and opens the copy.',
  'The embedder is a child process of the owner, so a native crash in the model runtime ends that child and the owner reports a coded failure to the caller.',
  'Budgets are measured through the built command line as a spawned process, against an empty script spawned the same way, interleaved round by round.',
  'A lease is kept alive by the adapter while the worker runs, its pid is alive and its stream is fresh, and it lapses when any one of those stops being true.',
  'Hooks inject at most four hundred bytes per event, so a note that matters must fit in a line and point to the row that holds the rest of it.',
  'When a run pauses, the orchestrator holds its wakes, the parked worker keeps its session, and the run resumes by matching the parks the pause recorded.',
];

const mb = (bytes) => Math.round((bytes / MIB) * 10) / 10;
const fwd = (p) => String(p).split('\\').join('/');

// ---- pure arithmetic (unit-tested without a GPU) ----

// Dedicated memory from the aggregate Vulkan state; total/unified/used are bytes.
function dedicatedFrom(v) {
  const dedicated = Math.max(0, v.total - (v.unified || 0));
  return { total_mb: mb(dedicated), shared_mb: mb(v.unified || 0), aggregate_total_mb: mb(v.total), aggregate_used_mb: mb(v.used), estimate_free_mb: mb(Math.max(0, dedicated - v.used)) };
}

// Free dedicated memory and where it came from. `smi` is the nvidia-smi row for the card with the most memory,
// or null. Both figures must be sound for nvidia-smi to be trusted: its total is the card's, the Vulkan
// dedicated figure is the card's minus the driver's reservation, so the Vulkan one is at most smi's and not
// below 85% of it. A disagreement counts the smaller free figure.
function freeDedicated(ded, smi) {
  if (!smi) return { free_mb: ded.estimate_free_mb, source: 'vulkan-estimate', cross_check: null };
  const agree = ded.total_mb <= smi.total_mb && ded.total_mb >= smi.total_mb * 0.85;
  const free = agree ? Math.min(smi.free_mb, ded.total_mb) : Math.min(smi.free_mb, ded.total_mb, ded.estimate_free_mb);
  return { free_mb: free, source: 'nvidia-smi', cross_check: { smi_total_mb: smi.total_mb, smi_free_mb: smi.free_mb, vulkan_dedicated_mb: ded.total_mb, reserved_mb: Math.round((smi.total_mb - ded.total_mb) * 10) / 10, agree } };
}

// ms per pair -> pairs per submission.
function deriveChunk(msPerPair, { targetMs = CHUNK_TARGET_MS, margin = CHUNK_MARGIN, max = CHUNK_MAX } = {}) {
  if (!(msPerPair > 0)) return max;
  return Math.max(1, Math.min(max, Math.floor(targetMs / (msPerPair * margin))));
}

// A model's peak: the larger growth of the two meters, never negative; the hint when neither moved.
function peakFrom({ vulkanDelta, smiDelta, hint }) {
  const d = [vulkanDelta, smiDelta].filter(x => Number.isFinite(x) && x > 0);
  if (d.length) return { peak_mb: Math.round(Math.max(...d) * 10) / 10, source: d.length === 2 && smiDelta > vulkanDelta ? 'nvidia-smi' : 'vulkan' };
  return { peak_mb: hint, source: 'hint' };
}

function needed(peaks, headroomMb) {
  const sum = Object.values(peaks).reduce((n, p) => n + p.peak_mb, 0);
  return { sum_mb: Math.round(sum * 10) / 10, headroom_mb: headroomMb, needed_mb: Math.round((sum + headroomMb) * 10) / 10 };
}

// The recorded key: model, the settings the peak was measured at, and the driver.
function peakKey(model, settings, driver) {
  const s = Object.keys(settings).sort().map(k => `${k}=${settings[k]}`).join(',');
  return `${model}|${s}|driver=${driver || 'unknown'}`;
}

// ---- recording ----

function peaksFile(env = process.env) { return path.join(R.baseDir(env), PEAKS_FILE); }

function readPeaks(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.entries ? j : { version: 1, entries: {} }; } catch { return { version: 1, entries: {} }; }
}

function recordPeaks(file, rows) {
  const cur = readPeaks(file);
  for (const [k, v] of Object.entries(rows)) cur.entries[k] = v;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return Object.keys(rows).length;
}

// The recorded peak for this model, settings and driver, or null. A read: it creates nothing.
function recordedPeak(model, settings, driver, file = peaksFile()) {
  const e = readPeaks(file).entries[peakKey(model, settings, driver)];
  return e || null;
}

// ---- nvidia-smi (the probe only) ----

function defaultSmi() {
  if (!fs.existsSync(NVIDIA_SMI)) return null;
  try {
    const out = execFileSync(NVIDIA_SMI, ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    const rows = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l) => {
      const [name, driver, total, used, free] = l.split(',').map(x => x.trim());
      return { name, driver, total_mb: Number(total), used_mb: Number(used), free_mb: Number(free) };
    }).filter(r => Number.isFinite(r.total_mb) && Number.isFinite(r.free_mb));
    return rows.length ? rows.sort((a, b) => b.total_mb - a.total_mb)[0] : null;
  } catch { return null; }
}

// ---- the probe ----

const refuse = (reason, message, options, extra = {}) => ({ ok: false, ...extra, refusal: { reason, message, options } });
const finite = (v) => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);

async function batchEmbedder(client, entry) {
  const t0 = Date.now();
  const q = await client.embed(entry.id, QUERY, { as: 'query' });
  const d = await client.embed(entry.id, FILLER[0], { as: 'document' });
  const ms = Date.now() - t0;
  for (const [what, r] of [['query', q], ['document', d]]) {
    if (!finite(r.embedding) || r.embedding.length !== entry.dims) return { ok: false, why: `the ${what} vector has ${r.embedding && r.embedding.length} values or a non-number, the table says ${entry.dims}` };
    const n = Math.sqrt(r.embedding.reduce((s, x) => s + x * x, 0));
    if (Math.abs(n - 1) > 1e-3) return { ok: false, why: `the ${what} vector has norm ${n}, not 1` };
  }
  return { ok: true, batch_ms: ms };
}

async function batchReranker(client, entry, targetMs) {
  const t0 = Date.now();
  const s = await client.rank(entry.id, QUERY, SANITY_DOCS);
  const warm = Date.now() - t0;
  if (!finite(s.scores) || s.scores.length !== SANITY_DOCS.length) return { ok: false, why: 'the sanity rank returned no usable scores' };
  const rel = SANITY_RELEVANT.map(i => s.scores[i]), fill = s.scores.filter((_, i) => !SANITY_RELEVANT.includes(i));
  if (!(Math.min(...rel) > Math.max(...fill))) return { ok: false, why: `relevant notes did not outrank filler (relevant ${rel.map(x => x.toFixed(4))}, filler ${fill.map(x => x.toFixed(4))})` };
  const docs = [SANITY_DOCS[0], SANITY_DOCS[2], ...FILLER, ...FILLER.slice(0, 6)]; // 16 notes
  const r = await client.rank(entry.id, QUERY, docs); // warm: the sanity rank paid the first-use cost
  const msPerPair = r.ms / docs.length;
  return { ok: true, batch_ms: warm + r.ms, sanity_scores: s.scores, ms_per_pair: Math.round(msPerPair * 100) / 100, chunk: deriveChunk(msPerPair, { targetMs }) };
}

// probe({ models: [ids], headroomMb?, chunkTargetMs?, contextSizes?, cacheDir?, runtimeDir?, record?, smi?, table?, clientOpts? })
// `smi` is a function returning the nvidia-smi row (tests), or false to skip it. `table`, `clientOpts` and
// `runtimeDir` are the test seams (a fake child, a fake table); `record` is the peaks file or false.
async function probe(opts = {}) {
  const ids = opts.models || [];
  const headroomMb = opts.headroomMb === undefined ? HEADROOM_MB : opts.headroomMb;
  const table = opts.table || GGUF_MODELS;
  const cacheDir = opts.cacheDir || K.cacheRoot();
  const t0 = Date.now();
  let client = null;
  try {
    if (!ids.length) return refuse('no_models', 'the probe was asked about no models', ['name at least one model from the GPU model table']);
    const entries = [];
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) return refuse('unknown_model', `${JSON.stringify(id)} is not in the GPU model table`, [`use one of: ${Object.keys(table).join(', ')}`]);
      entries.push(ggufFor(id, table));
    }
    const fake = process.env.BELAY_TEST_MODE === '1' && opts.clientOpts && opts.clientOpts.workerPath;
    let runtimeDir = opts.runtimeDir || null;
    if (!runtimeDir && !fake) {
      const c = R.check({ env: opts.env || process.env });
      if (!c.ok) return refuse('no_runtime', `the GPU runtime is missing or wrong (${c.problems.join('; ')})`, [`install it: ${R.INSTALL_COMMAND}`, 'or keep the CPU profiles, which need no runtime']);
      runtimeDir = c.dir;
    }
    for (const e of entries) {
      const chk = K.checkPresent(e, cacheDir);
      if (!chk.present) return refuse('model_absent', `${e.id} is not fetched or is wrong (${[...chk.missing, ...chk.wrong_size].join(', ')})`, [`fetch it: belay embedder fetch --gpu --model ${e.id}`]);
    }
    const smiRow = opts.smi === false ? null : (opts.smi || defaultSmi)();
    const driver = smiRow ? smiRow.driver : null;
    client = new GpuClient({ ...(opts.clientOpts || {}), runtimeDir, cacheDir, table });
    client.start();
    let base;
    try { base = await client.vram({ gpu: 'vulkan' }); }
    catch (e) { return refuse('no_gpu', `no usable Vulkan GPU: ${e.message}`, ['update the display driver (Vulkan comes with it)', 'use a CPU profile']); }
    const names = base.devices || [];
    const ded = dedicatedFrom(base);
    if (base.gpu !== 'vulkan' || !names.length || ded.total_mb < 1024) {
      return refuse('no_discrete_gpu', `no discrete GPU with dedicated memory: Vulkan devices ${JSON.stringify(names)}, ${ded.total_mb} MiB dedicated and ${ded.shared_mb} MiB shared with the CPU`, ['use a CPU profile', 'a GPU profile needs a discrete card with a Vulkan driver'], { device: { names }, dedicated: ded });
    }
    const fd = freeDedicated(ded, smiRow);
    const device = { name: smiRow ? smiRow.name : names[names.length - 1], names, source: smiRow ? 'nvidia-smi' : 'vulkan' };
    const dedicated = { total_mb: ded.total_mb, free_mb: fd.free_mb, shared_mb: ded.shared_mb, source: fd.source, cross_check: fd.cross_check };
    const settings = { gpu: 'vulkan' };
    const peaks = {}, rerank = {};
    let before = base, beforeSmi = smiRow;
    for (const e of entries) {
      const ctxSize = (opts.contextSizes && opts.contextSizes[e.id]) || e.context_size;
      const loaded = await client.load(e.id, { gpu: 'vulkan', contextSize: ctxSize });
      const batch = e.kind === 'embedder' ? await batchEmbedder(client, e) : await batchReranker(client, e, opts.chunkTargetMs);
      if (!batch.ok) return refuse('sanity_failed', `${e.id} failed its test batch: ${batch.why}`, ['re-fetch the model with belay embedder fetch --gpu --model ' + e.id, 'choose another model'], { device, dedicated });
      const after = await client.vram({ gpu: 'vulkan' });
      const afterSmi = opts.smi === false ? null : (opts.smi || defaultSmi)();
      const p = peakFrom({ vulkanDelta: (after.used - before.used) / MIB, smiDelta: smiRow && afterSmi && beforeSmi ? afterSmi.used_mb - beforeSmi.used_mb : NaN, hint: e.vram_mb_ref });
      peaks[e.id] = { kind: e.kind, peak_mb: p.peak_mb, peak_source: p.source, hint_mb: e.vram_mb_ref, load_ms: loaded.load_ms, batch_ms: batch.batch_ms, context_size: ctxSize };
      if (e.kind === 'reranker') { rerank[e.id] = { ms_per_pair: batch.ms_per_pair, chunk: batch.chunk, target_ms: opts.chunkTargetMs || CHUNK_TARGET_MS }; peaks[e.id].sanity_scores = batch.sanity_scores; }
      before = after; beforeSmi = afterSmi;
      const running = needed(peaks, headroomMb);
      if (running.needed_mb > fd.free_mb) break; // no point loading the rest: the set cannot fit
    }
    const n = needed(peaks, headroomMb);
    const grown = before.used - base.used;
    const measured_set_mb = Math.round((grown / MIB) * 10) / 10;
    const result = { device, dedicated, driver, headroom_mb: headroomMb, peaks, sum_mb: n.sum_mb, needed_mb: n.needed_mb, free_mb: fd.free_mb, measured_set_mb, rerank, models: ids, ms: Date.now() - t0 };
    if (Object.keys(peaks).length < entries.length || n.needed_mb > fd.free_mb) {
      const detail = Object.entries(peaks).map(([id, p]) => `${id} ${p.peak_mb} MiB`).join(' + ');
      return refuse('insufficient_vram', `the set needs ${n.needed_mb} MiB (${detail}${Object.keys(peaks).length < entries.length ? ' and more not loaded' : ''}, plus ${headroomMb} MiB headroom) and ${fd.free_mb} MiB of dedicated memory is free on ${device.name}`,
        ['choose smaller models', 'close other programs that use the GPU', 'lower the vram_headroom_gb lever (the headroom is a safety margin, not a measurement)'], result);
    }
    if (opts.record !== false) {
      const file = opts.record || peaksFile(opts.env || process.env);
      const rows = {};
      for (const [id, p] of Object.entries(peaks)) rows[peakKey(id, { ...settings, context: p.context_size }, driver)] = { model: id, settings: { ...settings, context: p.context_size }, driver, peak_mb: p.peak_mb, peak_source: p.peak_source, chunk: rerank[id] ? rerank[id].chunk : null, device: device.name, measured_at: new Date().toISOString() };
      try { result.recorded = { file: fwd(file), rows: recordPeaks(file, rows) }; } catch (e) { result.recorded = { file: fwd(file), error: e.message }; }
    }
    return { ok: true, ...result };
  } catch (e) {
    const cause = e && e.detail && e.detail.cause;
    return refuse(cause === 'dead' ? 'child_died' : cause === 'timeout' ? 'child_hung' : 'probe_failed', `the probe failed: ${e && e.message}`, ['run it again', 'use a CPU profile'], { code: e && e.code });
  } finally { if (client) await client.close(); }
}

module.exports = { probe, dedicatedFrom, freeDedicated, deriveChunk, peakFrom, needed, peakKey, recordedPeak, recordPeaks, readPeaks, peaksFile, defaultSmi, HEADROOM_MB, CHUNK_TARGET_MS, CHUNK_MAX, SANITY_DOCS, QUERY };
