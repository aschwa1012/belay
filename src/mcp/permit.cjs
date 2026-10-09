'use strict';
// permit.cjs — build step 6d, design item 3, ADR 0020
// decision 3. The worker adapter's answer to Claude Code's `--permission-prompt-tool` call: write a
// permission.request row, then wait on it in slices bounded by the client's own 30,000 ms deadline,
// until a verdict lands or this adapter's own `waitMs` bound passes — at which point it writes the
// `expired` row itself, so the substrate is refused rather than told the system is broken (the
// measured cost of a channel that outlives MCP_TOOL_TIMEOUT, ADR 0020 §Context).

const WAIT_SLICE_MS = 25000;

function verdictAnswer(state, input, reason) {
  if (state === 'allowed') {
    return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: input == null ? {} : input }) }], isError: false };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: reason || 'denied' }) }], isError: false };
}

function errResult(field) {
  const body = { error: 'E_ARGS', message: `permit needs ${field}` };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// createPermit({ openCore, caller, waitMs, log }). `openCore()` returns this adapter's own core
// (worker role); `log(line)` is the adapter's wire-log sink. Returns { call(args, rpcId), cancel(rpcId),
// inFlight() }.
function createPermit({ openCore, caller, waitMs = 600000, log = () => {} }) {
  const inFlight = new Map(); // rpcId -> { id, answered }

  async function call(args, rpcId) {
    const toolName = args && args.tool_name;
    const toolUseId = args && args.tool_use_id;
    if (typeof toolName !== 'string' || !toolName) return errResult('tool_name');
    if (typeof toolUseId !== 'string' || !toolUseId) return errResult('tool_use_id');
    const input = args.input == null ? null : args.input;
    const entry = { id: toolUseId, answered: false };
    inFlight.set(rpcId, entry);
    const c = await openCore();

    let requestRow;
    try {
      requestRow = await c.permission.request({ id: toolUseId, tool: toolName, input });
    } catch (e) {
      // A request nobody can see must not hold a worker: deny at once, naming the code and message.
      log('##', `permit ${toolUseId} ${toolName} request failed: ${e.code}: ${e.message}`);
      entry.answered = true;
      return verdictAnswer('denied', input, `belay: the permission request could not be written (${e.code}: ${e.message})`);
    }
    log('##', `permit ${toolUseId} ${toolName} requested`);

    const startedAt = Date.now();
    let verdictRow = requestRow;
    let waitFault = null; // the last permission.wait failure, if the real clock is still what ends this
    for (;;) {
      if (entry.cancelled) return null; // cancel() already answered (or dropped) this call
      const remaining = waitMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const slice = Math.max(1, Math.min(WAIT_SLICE_MS, remaining));
      let w;
      try {
        w = await c.permission.wait({ id: toolUseId, timeout_ms: slice });
        waitFault = null;
      } catch (e) {
        // One failed wait establishes nothing about the full bound (a client-side deadline, a
        // transport fault, or the owner momentarily gone all look the same from here): keep trying
        // while the real clock still has budget left, so "no verdict within waitMs ms" stays true
        // the moment it is finally said, rather than being claimed after only one slice.
        waitFault = e;
        log('!!', `permit ${toolUseId} wait failed: ${e.code}: ${e.message}`);
        const backoffLeft = waitMs - (Date.now() - startedAt);
        if (backoffLeft <= 0) break;
        await sleep(Math.min(500, backoffLeft));
        continue;
      }
      verdictRow = w.request || verdictRow;
      if (!w.timed_out) break;
    }
    if (entry.cancelled) return null;

    if (verdictRow && verdictRow.state !== 'pending') {
      entry.answered = true;
      log('##', `permit ${toolUseId} ${toolName} ${verdictRow.state} by ${verdictRow.verdict_by}`);
      return verdictAnswer(verdictRow.state, input, verdictRow.reason);
    }

    // The bound, genuinely reached on the real clock (the retries above kept it honest). A verdict
    // landing in the same instant as this expire is answered from that verdict instead, re-read:
    // permission.decide's own E_ARGS on an already-decided row is expected here.
    const reason = `belay: no verdict within ${waitMs} ms`;
    try {
      const decided = await c.permission.decide({ id: toolUseId, verdict: 'expire', reason });
      entry.answered = true;
      log('##', `permit ${toolUseId} ${toolName} expired by the adapter's own bound`);
      return verdictAnswer(decided.verdict.state, input, decided.verdict.reason);
    } catch (e) {
      if (e.code === 'E_ARGS' && e.detail) {
        const rows = await c.permission.list({ states: ['allowed', 'denied', 'expired'] }).catch(() => null);
        const landed = rows && rows.requests.find((r) => r.id === toolUseId);
        if (landed) {
          entry.answered = true;
          log('##', `permit ${toolUseId} ${toolName} ${landed.state} (raced the adapter's own bound)`);
          return verdictAnswer(landed.state, input, landed.reason);
        }
      }
      // The store itself could not be reached to record the expiry, so the row is left exactly as
      // it was (most often still pending: a verdict that lands once the owner returns can still be
      // read by belay pending and belay approve|deny). The substrate is told the fact that was
      // actually established — the store was unreachable — never the bound, which nothing confirmed.
      entry.answered = true;
      const cause = waitFault ? `${waitFault.code}: ${waitFault.message}` : `${e.code}: ${e.message}`;
      const unreachable = `belay: no verdict could be recorded within ${waitMs} ms: the store is unreachable (${cause})`;
      log('!!', `permit ${toolUseId} expire failed: ${e.code}: ${e.message}`);
      return verdictAnswer('denied', input, unreachable);
    }
  }

  // notifications/cancelled for an in-flight rpcId: expire the row if it is still pending, and never
  // write an answer to stdout — the substrate has already moved on.
  async function cancel(rpcId) {
    const entry = inFlight.get(rpcId);
    if (!entry || entry.answered) return;
    entry.cancelled = true;
    try {
      const c = await openCore();
      await c.permission.decide({ id: entry.id, verdict: 'expire', reason: 'cancelled by the substrate' });
      log('##', `permit ${entry.id} expired: cancelled by the substrate`);
    } catch (e) {
      log('!!', `permit ${entry.id} cancel failed: ${e.code || 'E_INTERNAL'}: ${e.message}`);
    }
  }

  return { call, cancel, inFlight: () => inFlight, caller, waitMs };
}

module.exports = { createPermit, verdictAnswer };
