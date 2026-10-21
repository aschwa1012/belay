'use strict';
// gpu-probe.cjs — the probe before any GPU model loads (ADR 0049 decision 6). It runs at setup, on a settings
// change and at run start, never on a search, and only from the store owner or a CLI verb that writes (it calls
// nvidia-smi, which no read path may do; invariant 9, tests/core/gpu-import-graph.test.cjs). It
//   1. starts the GPU child and lets it initialise Vulkan, then finds a discrete GPU in the device list it reports;
//   2. counts DEDICATED memory only, and reads free memory AFTER the child is up, so the child's own overhead is
//      not counted as room the models can use;
//   3. loads the requested models into that child, runs a test batch on each, and measures each one's peak by
//      SAMPLING the meters while the load and the batch run;
//   4. compares the SUM of the peaks plus headroom against free dedicated memory;
//   5. sizes a rerank's chunks from the measured cost per token, and bounds one submission with the context's
//      batch size, whose full-batch time it measures (gpu-chunk.cjs says what each bound does and does not give);
//   6. records each peak keyed by model, settings and driver version.
// It returns a structured result and never throws: no runtime, a missing model file, no GPU, a dead child, a
// failed sanity check, an allocation failure or too little memory is { ok: false, refusal: { reason, message, options } }.
//
// Dedicated memory. node-llama-cpp's getVramState sums every Vulkan device's memory heap, and an integrated GPU's
// heap is a slice of system RAM. On the reference laptop (RTX 5060 8 GB beside an AMD iGPU) it reports total
// 25,526,403,072 bytes with unifiedSize 17,243,701,248: the iGPU's shared heap is `unifiedSize`, so
//   dedicated = total - unifiedSize = 8,282,701,824 bytes = 7,899 MiB,
// which is what nvidia-smi reports as the card's free memory (memory.total is 8,151 MiB; the difference is the
// driver's own reservation). `used` is the same aggregate, and an iGPU's use is in it, so free dedicated memory
// is NOT total - unifiedSize - used. With nvidia-smi present (C:/Windows/System32, called here and nowhere on a
// read path, asynchronously so the owner's loop is never blocked) free is its memory.free for the card with the
// most memory, cross-checked against the Vulkan figure. Without it, free is the Vulkan dedicated total minus the
// aggregate used, which can only under-count.
//
// Peak. A model's peak is the most its load and test batch took above the level just before it, from samples of
// the Vulkan meter and nvidia-smi taken every ~100 ms while they ran (a sample takes as long as the meter's
// call, so nvidia-smi's cadence is slower), and never less than the steady growth afterwards. It is the highest
// SAMPLED value, so a spike shorter than a sample can be missed; the headroom is there for that.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ggufFor, GGUF_MODELS } = require('./gguf-models.cjs');
const { GpuClient } = require('./gpu.cjs');
const C = require('./gpu-chunk.cjs');
const K = require('./model-cache.cjs');
const R = require('./gpu-runtime.cjs');

const MIB = 1048576;
const HEADROOM_MB = 768; // 0.75 GB (the vram_headroom_gb lever's default)
const CHUNK_TARGET_MS = 1000;
const BATCH_TOKENS = 512; // tokens in one decode of a reranker (its context's batchSize)
const SAMPLE_MS = 100;
const SMI_BOUND_MS = 5000;
const NVIDIA_SMI = 'C:/Windows/System32/nvidia-smi.exe';
const PEAKS_FILE = 'probe-peaks.json';
const OOM = /out of (device |gpu )?memory|failed to allocate|unable to allocate|cannot allocate|VK_ERROR_OUT_OF|not enough (gpu |device )?memory|insufficient (gpu |device )?memory/i;

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
const r1 = (x) => Math.round(x * 10) / 10;
const fwd = (p) => String(p).split('\\').join('/');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  return { free_mb: free, source: 'nvidia-smi', cross_check: { smi_total_mb: smi.total_mb, smi_free_mb: smi.free_mb, vulkan_dedicated_mb: ded.total_mb, reserved_mb: r1(smi.total_mb - ded.total_mb), agree } };
}

// A model's peak: the largest growth any meter showed (a sampled maximum above the level before the model, or the
// steady growth after it), never negative; the table's hint when no meter moved.
function peakFrom({ vulkanDelta, smiDelta, hint }) {
  const d = [vulkanDelta, smiDelta].filter(x => Number.isFinite(x) && x > 0);
  if (d.length) return { peak_mb: r1(Math.max(...d)), source: d.length === 2 && smiDelta > vulkanDelta ? 'nvidia-smi' : 'vulkan' };
  return { peak_mb: hint, source: 'hint' };
}

function needed(peaks, headroomMb) {
  const sum = Object.values(peaks).reduce((n, p) => n + p.peak_mb, 0);
  return { sum_mb: r1(sum), headroom_mb: headroomMb, needed_mb: r1(sum + headroomMb) };
}

// The recorded key: model, the settings the peak was measured at, and the driver.
function peakKey(model, settings, driver) {
  const s = Object.keys(settings).sort().map(k => `${k}=${settings[k]}`).join(',');
  return `${model}|${s}|driver=${driver || 'unknown'}`;
}

// ---- sampling ----

// Calls `fn` (async, returns a number) back to back with `intervalMs` between calls until stop(), which resolves
// { max, n }. A call that does not answer in 2 s is dropped so a wedged meter cannot hold the probe.
function sampler(fn, intervalMs = SAMPLE_MS) {
  let stopped = false, max = null, n = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const v = await Promise.race([fn(), sleep(2000).then(() => NaN)]);
        if (Number.isFinite(v)) { max = max === null ? v : Math.max(max, v); n += 1; }
      } catch { /* a failed sample is a missing sample */ }
      if (!stopped) await sleep(intervalMs);
    }
  })();
  return { stop: async () => { stopped = true; await loop; return { max, n }; } };
}

// ---- recording ----

function peaksFile(env = process.env) { return path.join(R.baseDir(env), PEAKS_FILE); }

function readPeaks(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.entries ? j : { version: 1, entries: {} }; } catch { return { version: 1, entries: {} }; }
}

// Read, change, write by temp file and rename. Limit: the file is machine-wide and there is no lock, so two probes that finish at the same
// moment can lose one update (the last rename wins). Both writers are the store owner's probe and the record is a hint for the menu, so it is
// not worth a lock; a lost row is measured again by the next probe.
function writeRecord(file, cur) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}
`);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* a leftover temp file is harmless */ }
    throw e;
  }
}

function recordPeaks(file, rows) {
  const cur = readPeaks(file);
  for (const [k, v] of Object.entries(rows)) cur.entries[k] = v;
  writeRecord(file, cur);
  return Object.keys(rows).length;
}

// The recorded peak for this model, settings and driver, or null. A read: it creates nothing.
function recordedPeak(model, settings, driver, file = peaksFile()) {
  const e = readPeaks(file).entries[peakKey(model, settings, driver)];
  return e || null;
}

// ---- nvidia-smi (the probe only; async, so the owner's loop is never blocked) ----

function defaultSmi() {
  if (!fs.existsSync(NVIDIA_SMI)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(NVIDIA_SMI, ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { timeout: SMI_BOUND_MS, windowsHide: true, encoding: 'utf8' }, (e, out) => {
      if (e) return resolve(null);
      const rows = String(out).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l) => {
        const [name, driver, total, used, free] = l.split(',').map(x => x.trim());
        return { name, driver, total_mb: Number(total), used_mb: Number(used), free_mb: Number(free) };
      }).filter(r => Number.isFinite(r.total_mb) && Number.isFinite(r.free_mb));
      resolve(rows.length ? rows.sort((a, b) => b.total_mb - a.total_mb)[0] : null);
    });
  });
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

// A reranker's batch: a sanity rank (relevant above filler; it also warms the model), a timed rank of 16 notes for
// the cost per token, and one document that fills the context's batch. That document is ranked once cold (a shape
// the GPU has not run yet pays a first-use cost; recorded, not judged) and three times warm. The model is judged on
// the SLOWEST warm run: a run over the target is confirmed by one more run, and only a second run over the target
// refuses (a single 2.05 s run was seen once on the 4B reranker, against 0.2 s in all the others). Every run is
// recorded. The slowest warm run is the longest single submission the probe observes.
async function batchReranker(client, entry, { targetMs, batchTokens }) {
  const t0 = Date.now();
  const s = await client.rank(entry.id, QUERY, SANITY_DOCS);
  if (!finite(s.scores) || s.scores.length !== SANITY_DOCS.length) return { ok: false, why: 'the sanity rank returned no usable scores' };
  const rel = SANITY_RELEVANT.map(i => s.scores[i]), fill = s.scores.filter((_, i) => !SANITY_RELEVANT.includes(i));
  if (!(Math.min(...rel) > Math.max(...fill))) return { ok: false, why: `relevant notes did not outrank filler (relevant ${rel.map(x => x.toFixed(4))}, filler ${fill.map(x => x.toFixed(4))})` };
  const docs = [SANITY_DOCS[0], SANITY_DOCS[2], ...FILLER, ...FILLER.slice(0, 6)]; // 16 notes
  const r = await client.rank(entry.id, QUERY, docs);
  const tokens = r.pair_tokens.reduce((x, y) => x + y, 0);
  const msPerToken = Math.round((r.ms / tokens) * 1000) / 1000; // rounded once, so the recorded cost and the chunk bound agree
  let big = FILLER.join(' ');
  while (big.length < batchTokens * 5) big += ` ${FILLER.join(' ')}`; // ~4 characters a token: enough to fill the batch, the child caps it to the context
  const full = [big.slice(0, batchTokens * 4)];
  const cold = await client.rank(entry.id, QUERY, full);
  const warm = [];
  for (let i = 0; i < 3; i += 1) warm.push(await client.rank(entry.id, QUERY, full));
  const runs = warm.map(w => w.ms), slowest = Math.max(...runs);
  const rerun = slowest > targetMs ? (await client.rank(entry.id, QUERY, full)).ms : null;
  return {
    ok: true, batch_ms: Date.now() - t0, sanity_scores: s.scores,
    rerank: { ms_per_token: msPerToken, chunk_tokens: C.deriveChunkTokens(msPerToken, { targetMs }), max_pairs: C.CHUNK_MAX_PAIRS, batch_size: batchTokens, ubatch_tokens: warm[0].pair_tokens[0], ubatch_ms: slowest, ubatch_runs: runs, ubatch_rerun_ms: rerun, ubatch_first_ms: cold.ms, ubatch_refused: rerun !== null && rerun > targetMs, target_ms: targetMs, margin: C.CHUNK_MARGIN },
  };
}

// probe({ models: [ids], headroomMb?, chunkTargetMs?, batchTokens?, contextSizes?, cacheDir?, runtimeDir?, record?, smi?, table?, clientOpts? })
// `smi` is an (async) function returning the nvidia-smi row (tests), or false to skip it. `table`, `clientOpts` and
// `runtimeDir` are the test seams (a fake child, a fake table); `record` is the peaks file or false.
async function probeInner(opts = {}) {
  const ids = opts.models || [];
  const headroomMb = opts.headroomMb === undefined ? HEADROOM_MB : opts.headroomMb;
  const targetMs = opts.chunkTargetMs || CHUNK_TARGET_MS, batchTokens = opts.batchTokens || BATCH_TOKENS;
  const table = opts.table || GGUF_MODELS;
  const cacheDir = opts.cacheDir || K.cacheRoot();
  const smiFn = opts.smi === false ? null : (opts.smi || defaultSmi);
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
      if (!c.ok) return refuse('no_runtime', `the GPU runtime is missing or wrong (${c.problems.slice(0, 3).join('; ')})`, [`install it: ${R.INSTALL_COMMAND}`, 'or keep the CPU profiles, which need no runtime']);
      runtimeDir = c.dir;
    }
    for (const e of entries) {
      const chk = K.checkPresent(e, cacheDir);
      if (!chk.present) return refuse('model_absent', `${e.id} is not fetched or is wrong (${[...chk.missing, ...chk.wrong_size].join(', ')})`, [`fetch it: belay embedder fetch --gpu --model ${e.id}`]);
    }
    client = new GpuClient({ ...(opts.clientOpts || {}), runtimeDir, cacheDir, table });
    client.start();
    let base;
    try { base = await client.vram({ gpu: 'vulkan' }); } // initialises Vulkan in the child: its own overhead is now in every meter
    catch (e) { return refuse('no_gpu', `no usable Vulkan GPU: ${e.message}`, ['update the display driver (Vulkan comes with it)', 'use a CPU profile']); }
    const smiRow = smiFn ? await smiFn() : null; // after the child is up, so free memory excludes what the child itself holds
    const driver = smiRow ? smiRow.driver : null;
    const names = base.devices || [];
    const ded = dedicatedFrom(base);
    if (base.gpu !== 'vulkan' || !names.length || ded.total_mb < 1024) {
      return refuse('no_discrete_gpu', `no discrete GPU with dedicated memory: Vulkan devices ${JSON.stringify(names)}, ${ded.total_mb} MiB dedicated and ${ded.shared_mb} MiB shared with the CPU`, ['use a CPU profile', 'a GPU profile needs a discrete card with a Vulkan driver'], { device: { names }, dedicated: ded });
    }
    const fd = freeDedicated(ded, smiRow);
    const device = { name: smiRow ? smiRow.name : names[names.length - 1], names, source: smiRow ? 'nvidia-smi' : 'vulkan' };
    const dedicated = { total_mb: ded.total_mb, free_mb: fd.free_mb, shared_mb: ded.shared_mb, source: fd.source, cross_check: fd.cross_check };
    const peaks = {}, rerank = {};
    let before = base, beforeSmi = smiRow;
    for (const e of entries) {
      const ctxSize = (opts.contextSizes && opts.contextSizes[e.id]) || e.context_size;
      const vs = sampler(async () => (await client.vramSample()).used / MIB); // its own short bound: a missed sample never marks the child hung
      const ss = smiFn && smiRow ? sampler(async () => { const r = await smiFn(); return r ? r.used_mb : NaN; }) : null;
      let loaded, batch;
      const sampled = { vulkan: null, smi: null };
      try {
        loaded = await client.load(e.id, { gpu: 'vulkan', contextSize: ctxSize, ...(e.kind === 'reranker' ? { batchSize: batchTokens } : {}) });
        batch = e.kind === 'embedder' ? await batchEmbedder(client, e) : await batchReranker(client, e, { targetMs, batchTokens });
      } catch (x) {
        sampled.vulkan = await vs.stop(); if (ss) sampled.smi = await ss.stop();
        if (!OOM.test(String(x && x.message))) throw x;
        const n = needed({ ...peaks, [e.id]: { peak_mb: e.vram_mb_ref } }, headroomMb);
        return refuse('insufficient_vram', `the GPU ran out of memory loading ${e.id}: ${x.message}. The set needs about ${n.needed_mb} MiB (the table's hint for this model, plus headroom) and ${fd.free_mb} MiB of dedicated memory is free on ${device.name}`,
          ['choose smaller models', 'close other programs that use the GPU', 'lower the vram_headroom_gb lever'], { device, dedicated, peaks, needed_mb: n.needed_mb, free_mb: fd.free_mb, cause: 'allocation_failed' });
      }
      sampled.vulkan = await vs.stop(); if (ss) sampled.smi = await ss.stop();
      if (!batch.ok) return refuse('sanity_failed', `${e.id} failed its test batch: ${batch.why}`, [`re-fetch the model with belay embedder fetch --gpu --model ${e.id}`, 'choose another model'], { device, dedicated });
      if (batch.rerank && batch.rerank.ubatch_refused) return refuse('submission_too_long', `${e.id} took ${batch.rerank.ubatch_ms} ms and then ${batch.rerank.ubatch_rerun_ms} ms for one full batch of ${batch.rerank.ubatch_tokens} tokens, over the ${targetMs} ms target; one GPU submission could approach the Windows TDR limit`, ['choose a smaller reranker', 'use the CPU reranker'], { device, dedicated });
      const after = await client.vram({ gpu: 'vulkan' });
      const afterSmi = smiFn && smiRow ? await smiFn() : null;
      const steadyVulkan = (after.used - before.used) / MIB, steadySmi = smiRow && afterSmi && beforeSmi ? afterSmi.used_mb - beforeSmi.used_mb : NaN;
      const sampledVulkan = sampled.vulkan && sampled.vulkan.max !== null ? sampled.vulkan.max - before.used / MIB : NaN;
      const sampledSmi = sampled.smi && sampled.smi.max !== null && beforeSmi ? sampled.smi.max - beforeSmi.used_mb : NaN;
      const top = (...xs) => Math.max(...xs.filter(Number.isFinite), -Infinity);
      const p = peakFrom({ vulkanDelta: top(steadyVulkan, sampledVulkan), smiDelta: top(steadySmi, sampledSmi), hint: e.vram_mb_ref });
      peaks[e.id] = { kind: e.kind, peak_mb: p.peak_mb, peak_source: p.source, steady_mb: r1(top(steadyVulkan, steadySmi)), samples: { vulkan: sampled.vulkan && sampled.vulkan.n, smi: sampled.smi && sampled.smi.n }, hint_mb: e.vram_mb_ref, load_ms: loaded.load_ms, batch_ms: batch.batch_ms, context_size: ctxSize };
      if (batch.rerank) { rerank[e.id] = batch.rerank; peaks[e.id].sanity_scores = batch.sanity_scores; }
      before = after; beforeSmi = afterSmi || beforeSmi;
      if (needed(peaks, headroomMb).needed_mb > fd.free_mb) break; // no point loading the rest: the set cannot fit
    }
    const n = needed(peaks, headroomMb);
    const result = { device, dedicated, driver, headroom_mb: headroomMb, peaks, sum_mb: n.sum_mb, needed_mb: n.needed_mb, free_mb: fd.free_mb, measured_set_mb: mb(before.used - base.used), rerank, models: ids, ms: Date.now() - t0 };
    if (Object.keys(peaks).length < entries.length || n.needed_mb > fd.free_mb) {
      const detail = Object.entries(peaks).map(([id, p]) => `${id} ${p.peak_mb} MiB`).join(' + ');
      return refuse('insufficient_vram', `the set needs ${n.needed_mb} MiB (${detail}${Object.keys(peaks).length < entries.length ? ' and more not loaded' : ''}, plus ${headroomMb} MiB headroom) and ${fd.free_mb} MiB of dedicated memory is free on ${device.name}`,
        ['choose smaller models', 'close other programs that use the GPU', 'lower the vram_headroom_gb lever (the headroom is a safety margin, not a measurement)'], result);
    }
    if (opts.record !== false) {
      const file = opts.record || peaksFile(opts.env || process.env);
      const rows = {};
      for (const [id, p] of Object.entries(peaks)) {
        const settings = { gpu: 'vulkan', context: p.context_size, ...(rerank[id] ? { batch: rerank[id].batch_size } : {}) };
        rows[peakKey(id, settings, driver)] = { model: id, settings, driver, peak_mb: p.peak_mb, peak_source: p.peak_source, chunk_tokens: rerank[id] ? rerank[id].chunk_tokens : null, device: device.name, measured_at: new Date().toISOString() };
      }
      try { result.recorded = { file: fwd(file), rows: recordPeaks(file, rows) }; } catch (e) { result.recorded = { file: fwd(file), error: e.message }; }
    }
    return { ok: true, ...result };
  } catch (e) {
    const cause = e && e.detail && e.detail.cause;
    return refuse(cause === 'dead' ? 'child_died' : cause === 'timeout' ? 'child_hung' : 'probe_failed', `the probe failed: ${e && e.message}`, ['run it again', 'use a CPU profile'], { code: e && e.code });
  } finally { if (client) await client.close(); }
}

// The last device reading any probe took, kept in the peaks file beside the peaks: { device, free_mb, total_mb, ok, reason, models, at }.
// The Memory menu shows it ("probed 14:02"); a probe that never reached the device (no runtime, a model not fetched) records nothing.
function recordLast(file, r, models) {
  if (!r || !r.dedicated || !r.device || !r.device.name) return false;
  try {
    const cur = readPeaks(file);
    cur.last = { device: r.device.name, free_mb: r.dedicated.free_mb, total_mb: r.dedicated.total_mb, ok: r.ok === true, reason: r.ok ? null : (r.refusal && r.refusal.reason) || null, models, at: new Date().toISOString() };
    writeRecord(file, cur);
    return true;
  } catch { return false; }
}

// The last reading, or null. A read: it creates nothing.
function readLast(file = peaksFile()) {
  const l = readPeaks(file).last;
  return l && typeof l === 'object' ? l : null;
}

async function probe(opts = {}) {
  const r = await probeInner(opts);
  if (opts.record !== false) recordLast(opts.record || peaksFile(opts.env || process.env), r, opts.models || []);
  return r;
}

module.exports = {
  probe, readLast, recordLast, dedicatedFrom, freeDedicated, peakFrom, needed, peakKey, sampler, recordedPeak, recordPeaks, readPeaks, peaksFile, defaultSmi,
  deriveChunkTokens: C.deriveChunkTokens, HEADROOM_MB, CHUNK_TARGET_MS, BATCH_TOKENS, SANITY_DOCS, QUERY,
};
