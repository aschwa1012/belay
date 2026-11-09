'use strict';
// init-embedder.cjs — `belay init` offers to fetch the default embedding model. It asks only in an interactive terminal without --json;
// anywhere else it prints one line and fetches nothing, unless --fetch says to. The fetch is `belay embedder fetch`'s own code, loaded
// only when a fetch is made. Seams for tests: ctx.interactive, ctx.prompt(question) and ctx.fetchModel(ctx).

const M = require('../core/models.cjs');
const K = require('../core/model-cache.cjs');

const mb = (n) => Math.max(1, Math.round(n / 1e6));

// Strips --fetch / --no-fetch from argv. { rest, fetch: true | false | null } or { error }.
function takeFlags(argv) {
  const rest = argv.filter((a) => a !== '--fetch' && a !== '--no-fetch');
  const yes = argv.includes('--fetch'), no = argv.includes('--no-fetch');
  if (yes && no) return { error: '--fetch and --no-fetch cannot be used together' };
  return { rest, fetch: yes ? true : no ? false : null };
}

// Resolves the typed line (an empty Enter is ''), or null when the input ended or was interrupted with no answer. Settled once.
function defaultPrompt(question, io = {}) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    const rl = require('node:readline').createInterface({ input: io.input || process.stdin, output: io.output || process.stdout, terminal: io.terminal });
    rl.once('close', () => settle(null));
    rl.once('SIGINT', () => { settle(null); rl.close(); });
    rl.question(question, (a) => { settle(a); rl.close(); });
  });
}

// Returns { model, present, action, bytes?, line?, fetch? } where action is present | fetched | fetch_failed | declined | not_asked.
async function offer(ctx, want) {
  const entry = M.MODELS[M.DEFAULT_MODEL];
  const bytes = entry && Array.isArray(entry.files) ? entry.files.reduce((n, f) => n + f.bytes, 0) : null;
  const out = { model: M.DEFAULT_MODEL, present: false, action: 'not_asked', ...(bytes ? { bytes } : {}) };
  if (!entry || K.checkPresent(entry).present) return { ...out, present: !!entry, action: 'present' };
  const cmd = `belay embedder fetch --model ${M.DEFAULT_MODEL}`;
  const interactive = ctx.interactive !== undefined ? ctx.interactive : !!(process.stdin.isTTY && process.stdout.isTTY);
  let go = want;
  if (go === null && interactive && !ctx.json) {
    const size = bytes ? ` (about ${mb(bytes)} MB, one time)` : ' (one time)';
    const typed = await (ctx.prompt || defaultPrompt)(`Download the embedding model now${size}? [Y/n] `);
    const answer = typed === null || typed === undefined ? null : String(typed).trim().toLowerCase(); // null: no answer was given, which is no
    go = answer === '' || answer === 'y' || answer === 'yes';
    if (!go) return { ...out, action: 'declined', line: `the embedding model was not downloaded; fetch it later with: ${cmd}` };
  }
  if (go === false) return { ...out, line: `the embedding model is missing and was not downloaded (--no-fetch); fetch it later with: ${cmd}` };
  if (go === null) return { ...out, line: `the embedding model is missing; fetch it with: ${cmd}` };
  const fetchModel = ctx.fetchModel || ((c) => require('./cmd-embedder.cjs').run(c));
  const r = await fetchModel({ ...ctx, argv: ['fetch', '--model', M.DEFAULT_MODEL] });
  const ok = r.code === 0;
  const error = ok ? null : (r.json && r.json.error) || 'the fetch failed';
  return { ...out, present: ok, action: ok ? 'fetched' : 'fetch_failed', fetch: r.json, ...(ok ? {} : { line: `the embedding model download failed: ${error}; retry with: ${cmd}` }) };
}

module.exports = { offer, takeFlags, defaultPrompt };
