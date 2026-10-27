'use strict';
// cmd-message.cjs — build step 6c, design item 5, ADR
// 0019 decisions 2-5 and amendment 1. `belay message <worker-id> <text...>`: writes a turn to a
// worker's stdin over the worker adapter's own pipe (Codex: a resume process, ADR 0001 §4). The
// contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling
// process.exit.

const fs = require('node:fs');

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const { callWorkerAdapter, messageBoundMs } = require('./adapter-pipe.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay message: ${message}\n\nusage: belay message <worker-id> <text...> [--data <dir>] [--json]\n       text with an option word in it goes after --: belay message <worker-id> -- <text...>\n`,
    json: { error: message },
  };
}

function renderText(receipt) {
  if (!receipt.sent) return `belay message: ${receipt.reason}\n`;
  return `worker ${receipt.worker_id}: ${receipt.bytes} bytes over ${receipt.channel}, turn ${receipt.turn}, pid ${receipt.pid} (${receipt.established_by})\n`;
}

async function run(ctx) {
  if (ctx.argv.length < 1) return usageError('needs a worker id and text to send');
  const workerId = ctx.argv[0];
  if (typeof workerId === 'string' && workerId.startsWith('-')) return usageError(`unknown option ${workerId}`);
  const text = ctx.argv.slice(1).join(' ');
  if (!text.trim()) return usageError('needs text to send, and it must not be only whitespace');

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode C: never creates the data dir.
  if (!fs.existsSync(dataDir)) {
    const receipt = { worker_id: workerId, sent: false, reason: `no such data dir: ${dataDir}`, error: null, ladder: [], last: null };
    return { code: 1, text: renderText(receipt), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const caller = { role: 'operator', run_id: 'cli', pid: process.pid };
    const { success, ...rest } = await callWorkerAdapter(core, dataDir, {
      workerId, method: 'worker.message',
      params: { worker_id: workerId, text, caller },
      boundMs: messageBoundMs(),
    });
    const receipt = { ...rest, sent: success };
    return { code: success ? 0 : 1, text: renderText(receipt), json: receipt };
  } finally {
    // Never elects on this path (worker.get and run.list are reads), kept for symmetry with the rest.
    if (core.isOwner()) { try { await require('./release-owner.cjs').releaseOwnerOf(core); } catch { /* best effort */ } }
    await core.close();
  }
}

module.exports = { run };
