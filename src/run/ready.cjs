'use strict';
// The ADR 0001 §8 ready gate, one function. It is asked once per launch, after the ready event and
// before any `running` row: a worker that cannot reach its own belay MCP server cannot write to the
// store, and what a worker writes is the whole point of a worker. The two substrates offer
// different evidence, so this is the only place that knows the difference.

const L = require('./launch.cjs');
const S = require('./surface.cjs'); // ADR 0024, build step S2: the surface gate.

const WIRE_LOG_POLL_MS = 50;  // how often the Codex adapter log is re-read while waiting for tools/list
const SETTLED_GRACE_MS = 300; // how much longer that log is read after the worker itself has died
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ADR 0021 amendment 3: the operator's floor. Opus 5.5 is served only from this build on, and an
// older binary would start a worker that cannot run the production roster.
const MIN_CLAUDE_CODE_VERSION = '2.1.280';

// Compares the leading dotted numbers of two version strings ('2.1.281', '2.1.280-fake'): -1, 0, 1.
function compareVersions(a, b) {
  const nums = (v) => String(v).split(/[^0-9.]/)[0].split('.').map((n) => Number(n) || 0);
  const x = nums(a); const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The whole Claude Code branch of the ready gate, entirely synchronous, in one fixed order: version,
// then `mcp_servers`, then the ADR 0024 surface. Factored out (S2 fix round 3, review 2 should-fix) so
// the orchestrator can call it directly, synchronously, from `handleEvent` — fix round 2's own
// synchronous pre-check called `checkSurface` alone, ahead of this order, so a belay connection failure
// (whose real init lists no `mcp__belay__*` tools either, same as a worker's) was reported as "no
// mcp__belay__* tool is listed" instead of the true cause. `verifyReady` below calls this unchanged, so
// a worker's `spawn`/`restart`/`resume` keep exactly the order and evidence they already had.
function verifyClaudeReady(w, ready) {
  const version = ready && ready.claude_code_version;
  if (version && compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    return { ok: false, reason: `the session reported Claude Code ${version} in its system/init, and belay needs ${MIN_CLAUDE_CODE_VERSION} or later (ADR 0021 amendment 3); set BELAY_CLAUDE_EXE to a newer install` };
  }
  const servers = ready && ready.mcp_servers;
  if (!Array.isArray(servers)) {
    return { ok: false, reason: `the ${L.MCP_SERVER_NAME} MCP server was not verified at ready: the system/init event carried no mcp_servers list (ADR 0001 §8)` };
  }
  const seen = servers.map((s) => ({ name: s && s.name, status: s && s.status }));
  const belay = seen.find((s) => s.name === L.MCP_SERVER_NAME);
  if (!belay || belay.status !== 'connected') {
    return { ok: false, reason: `the system/init event listed mcp_servers ${JSON.stringify(seen)}, and ADR 0001 §8 requires ${L.MCP_SERVER_NAME} there with status connected` };
  }
  // ADR 0024, build step S2: a surface other than the one it allows fails this same gate, for a
  // fresh launch, a restart, a resume and the orchestrator alike (extends the gate; adds no new one).
  const surface = S.checkSurface(ready, { permissionPrompt: !!(w && w.permissionPrompt), tools: (w && w.tools) || null, job: !!(w && require('./job-prefixes.cjs').isJobId(w.id)), nativeMemory: (w && w.nativeMemory) || null });
  if (!surface.ok) return { ok: false, reason: surface.reason };
  return { ok: true, evidence: { mcp_servers: seen, ...surface.evidence } };
}

async function verifyReady(w, ready, deadline) {
  if (w.substrate === 'claude-code') return verifyClaudeReady(w, ready);
  const logPath = w.adapterLogPath;
  let settledAt = null;
  for (;;) {
    const hit = L.wireLogHasToolsList(logPath, w.adapterLogBytes || 0);
    if (hit.seen) return { ok: true, evidence: { adapter_log: logPath, tools_list_lines: hit.count } };
    // A worker that has died is not going to connect, so the wait ends early rather than burning
    // the whole window — but the adapter is a separate process writing a separate file, so it is
    // given a short grace to finish flushing what it wrote before the worker went. Evidence in
    // the log is evidence; whether the worker is still alive is the next check's question, not
    // this one's.
    if (w.settled && settledAt === null) settledAt = now();
    const spent = settledAt === null ? 0 : now() - settledAt;
    if (now() >= deadline || spent >= SETTLED_GRACE_MS) {
      return {
        ok: false,
        reason: `the worker adapter logged no tools/list to ${logPath} inside the startup window, so nothing establishes that the ${L.MCP_SERVER_NAME} MCP server connected (ADR 0001 §8): ${hit.reason || 'no such line in ' + hit.new_bytes + ' bytes'}`,
      };
    }
    await sleep(WIRE_LOG_POLL_MS);
  }
}

// ADR 0021 decisions 3 and 4: the permission mode a Claude Code launch asked for beside the one its
// system/init says it got, and the substrate's version. A mismatch is reported, never refused: `auto`
// falls back to `default` on a model without auto mode, which is stricter, not looser. All null when
// the ready event carried no mode (Codex, or an init that omits it), so nothing is claimed.
function initFacts(requested, ready) {
  const effective = (ready && ready.permission_mode) || null;
  return {
    permission_mode_requested: effective ? requested : null,
    permission_mode_effective: effective,
    permission_mode_degraded: effective ? effective !== requested : null,
    claude_code_version: (ready && ready.claude_code_version) || null,
  };
}

module.exports = { verifyReady, verifyClaudeReady, initFacts, compareVersions, MIN_CLAUDE_CODE_VERSION, WIRE_LOG_POLL_MS, SETTLED_GRACE_MS };
