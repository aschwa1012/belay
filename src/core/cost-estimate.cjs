'use strict';
// cost-estimate.cjs — what a worker's last turn cost when its life ended without a `result` event (ADR 0062, proposed).
// Claude Code reports cost and tokens only on a turn's `result` line. A worker killed or closed mid-turn never writes one, so its
// row would say $0 for work it did. On a terminal write the core reads the worker's own stream, takes the assistant messages after
// its last `result` line, and prices them from their per-message usage (usage-price.cjs). The figure is added to what the row
// reported, and the row says so: `cost_estimate` holds the estimated part and `cost_source` names it. A later reported `result`
// supersedes it (the next non-terminal write clears both), and the same stream is never counted twice because the estimate is
// recomputed from the last `result` line on every terminal write, not accumulated.

const fs = require('node:fs');
const path = require('node:path');
const { PRICES, messageUsd } = require('./usage-price.cjs');

const SOURCE = 'transcript_estimate';
const SOURCE_PLUS = 'reported+transcript_estimate';
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const FIELDS = ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The usage of one assistant line, or null when it carries none the estimate can use.
function lineUsage(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || j.type !== 'assistant' || j.isSidechain === true || !j.message || typeof j.message.usage !== 'object' || !j.message.usage) return null;
  const msg = j.message;
  if (typeof msg.model !== 'string' || msg.model === '<synthetic>') return null;
  const uu = msg.usage;
  const cc = num(uu.cache_creation_input_tokens);
  const split = uu.cache_creation && typeof uu.cache_creation === 'object' && !Array.isArray(uu.cache_creation);
  return {
    id: typeof msg.id === 'string' && msg.id ? msg.id : null, model: msg.model,
    u: {
      input: num(uu.input_tokens), output: num(uu.output_tokens), cache_read: num(uu.cache_read_input_tokens), cache_creation: cc,
      cc5m: split ? num(uu.cache_creation.ephemeral_5m_input_tokens) : cc, cc1h: split ? num(uu.cache_creation.ephemeral_1h_input_tokens) : 0,
    },
  };
}

// The lines after the last `result` line (all of them when there is none). A line is a result only if it parses as one.
function tailLines(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"type":"result"')) continue;
    try { if (JSON.parse(lines[i]).type === 'result') return lines.slice(i + 1); } catch { /* a cut line: not a result */ }
  }
  return lines;
}

// estimateLines(lines) -> null when no message is left, else { messages, usd, tokens, unpriced_models }.
// One API message spans several lines; the last line of an id has its final output count, and each id is counted once.
function estimateLines(lines, prices = PRICES) {
  const byId = new Map();
  const anon = [];
  for (const line of lines) {
    if (!line.includes('"type":"assistant"')) continue;
    const m = lineUsage(line);
    if (!m) continue;
    if (m.id) byId.set(m.id, m); else anon.push(m);
  }
  const msgs = [...byId.values(), ...anon];
  if (!msgs.length) return null;
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const unpriced = new Set();
  let usd = 0;
  for (const m of msgs) {
    tokens.input += m.u.input; tokens.output += m.u.output; tokens.cache_read += m.u.cache_read; tokens.cache_creation += m.u.cache_creation;
    const d = messageUsd(prices, m.model, m.u);
    if (d === null) unpriced.add(m.model); else usd += d;
  }
  return { messages: msgs.length, usd: unpriced.size ? null : usd, tokens, unpriced_models: [...unpriced] };
}

// The estimate for a worker's stream file, or null when there is nothing to add (no stream, none unreported).
function estimateStream(streamPath, prices = PRICES) {
  let text;
  try {
    if (fs.statSync(streamPath).size > MAX_STREAM_BYTES) return null;
    text = fs.readFileSync(streamPath, 'utf8');
  } catch { return null; }
  return estimateLines(tailLines(text), prices);
}

const estimateOf = (row) => (row && row.cost_estimate && typeof row.cost_estimate === 'object' ? row.cost_estimate : null);

// The estimate's contribution to the row's numbers, as the fields it was added to.
function addedBy(est) {
  if (!est) return {};
  return {
    cost_usd: num(est.usd), input_tokens: num(est.input_tokens), output_tokens: num(est.output_tokens),
    cache_read_tokens: num(est.cache_read_tokens), cache_creation_tokens: num(est.cache_creation_tokens),
  };
}

// Applied by the core to a worker row about to be written (`merged` = prev + args). `args` is what the caller sent: a field it
// sent is the REPORTED figure; a field it left out is inherited, with any earlier estimate taken back out first. A live row
// carries no estimate; a stopped or dead claude-code row gets one for the messages after its last result line.
function apply(dataDir, prev, merged, args) {
  const prevAdd = addedBy(estimateOf(prev));
  for (const f of FIELDS) {
    const sent = args && args[f] !== undefined;
    if (!sent && prevAdd[f]) merged[f] = Math.max(0, num(merged[f]) - prevAdd[f]);
  }
  merged.cost_estimate = null;
  merged.cost_source = null;
  const terminal = merged.state === 'stopped' || merged.state === 'dead';
  if (!terminal || merged.substrate !== 'claude-code' || typeof merged.id !== 'string' || !SAFE_ID.test(merged.id)) return merged;
  const est = estimateStream(path.join(dataDir, 'workers', merged.id, 'stream.jsonl'));
  if (!est) return merged;
  const reported = num(merged.cost_usd) > 0 || num(merged.turns) > 0;
  merged.cost_estimate = {
    source: SOURCE, messages: est.messages, usd: est.usd, unpriced_models: est.unpriced_models,
    input_tokens: est.tokens.input, output_tokens: est.tokens.output,
    cache_read_tokens: est.tokens.cache_read, cache_creation_tokens: est.tokens.cache_creation,
  };
  merged.input_tokens = num(merged.input_tokens) + est.tokens.input;
  merged.output_tokens = num(merged.output_tokens) + est.tokens.output;
  merged.cache_read_tokens = num(merged.cache_read_tokens) + est.tokens.cache_read;
  merged.cache_creation_tokens = num(merged.cache_creation_tokens) + est.tokens.cache_creation;
  if (est.usd !== null) merged.cost_usd = num(merged.cost_usd) + est.usd;
  merged.cost_source = reported ? SOURCE_PLUS : SOURCE;
  return merged;
}

module.exports = { apply, estimateLines, estimateStream, tailLines, estimateOf, SOURCE, SOURCE_PLUS };
