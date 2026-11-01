'use strict';
// permit.cjs — build step 6d, design item 3, ADR 0020
// decision 3. The worker adapter's answer to Claude Code's `--permission-prompt-tool` call: write a
// permission.request row, then wait on it in slices bounded by the client's own 30,000 ms deadline,
// until a verdict lands or this adapter's own `waitMs` bound passes — at which point it writes the
// `expired` row itself, so the substrate is refused rather than told the system is broken (the
// measured cost of a channel that outlives MCP_TOOL_TIMEOUT, ADR 0020 §Context).

const WAIT_SLICE_MS = 25000;
const RECONCILE_MAX_MS = 20000; // the most an unknown-outcome reconcile may spend, inside the substrate's margin

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

  // A request that was sent and not answered may be committed. Reconcile it, so no live-looking
  // pending row survives a deny the worker has already acted on: expire it (E_NOT_FOUND means it was
  // never written; an already-decided row is answered from its verdict).
  function unknownOutcome(e) {
    return !!(e && (e.code === 'E_OWNER_LOST' || e.code === 'E_TIMEOUT') && e.detail && e.detail.may_have_committed);
  }

  async function unknownAnswer(c, e, toolUseId, toolName, input) {
    const reason = `belay: the permission request outcome is unknown (${e.code}: ${e.message}); it was expired`;
    let last = null;
    // The whole reconcile stays inside the substrate's own limit (MCP_TOOL_TIMEOUT is waitMs + 60000):
    // no attempt starts, and none is waited on, past this deadline.
    const deadline = Date.now() + Math.min(waitMs, RECONCILE_MAX_MS);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        if (deadline - Date.now() <= 250) break;
        await sleep(250);
      }
      try {
        const left = Math.max(1, deadline - Date.now());
        let timer;
        const cutoff = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`no answer within the ${left} ms left for reconciling`), { code: 'E_TIMEOUT' })), left);
          if (timer.unref) timer.unref();
        });
        let decided;
        try { decided = await Promise.race([c.permission.decide({ id: toolUseId, verdict: 'expire', reason }), cutoff]); }
        finally { clearTimeout(timer); }
        log('##', `permit ${toolUseId} ${toolName} expired after an unknown request outcome`);
        return verdictAnswer(decided.verdict.state, input, decided.verdict.reason);
      } catch (e2) {
        last = e2;
        if (e2.code === 'E_NOT_FOUND') {
          return verdictAnswer('denied', input, `belay: the permission request could not be written (${e.code}: ${e.message})`);
        }
        if (e2.code === 'E_ARGS' && e2.detail) {
          const rows = await c.permission.list({ states: ['allowed', 'denied', 'expired'] }).catch(() => null);
          const landed = rows && rows.requests.find((r) => r.id === toolUseId);
          if (landed) return verdictAnswer(landed.state, input, landed.reason);
        }
      }
    }
    last = last || { code: 'E_TIMEOUT', message: 'no time left to reconcile' };
    log('!!', `permit ${toolUseId} reconcile failed: ${last.code}: ${last.message}`);
    return verdictAnswer('denied', input, `belay: the permission request outcome is unknown and could not be reconciled (${e.code}: ${e.message}; ${last.code}: ${last.message})`);
  }

  async function expireCancelled(c, entry) {
    if (entry.expired) return;
    try {
      await c.permission.decide({ id: entry.id, verdict: 'expire', reason: 'cancelled by the substrate' });
      entry.expired = true;
      log('##', `permit ${entry.id} expired: cancelled by the substrate`);
    } catch (e) {
      if (e.code === 'E_ARGS' && e.detail && e.detail.state === 'expired') { entry.expired = true; return; } // a racing expire already landed
      log('!!', `permit ${entry.id} cancel failed: ${e.code || 'E_INTERNAL'}: ${e.message}`);
    }
  }

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
      if (unknownOutcome(e)) return unknownAnswer(c, e, toolUseId, toolName, input);
      return verdictAnswer('denied', input, `belay: the permission request could not be written (${e.code}: ${e.message})`);
    }
    log('##', `permit ${toolUseId} ${toolName} requested`);
    if (entry.cancelled) {
      // A cancel that landed before the row existed found nothing to expire: apply it now.
      await expireCancelled(c, entry);
      return null;
    }

    const startedAt = Date.now();
    let verdictRow = requestRow;
    let waitFault = null; // the last permission.wait failure, if the real clock is still what ends this
    for (;;) {
      if (entry.cancelled) { await expireCancelled(c, entry); return null; } // cancel() may have failed to expire the row
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
    if (entry.cancelled) { await expireCancelled(c, entry); return null; }

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
    let c;
    try {
      c = await openCore();
    } catch (e) {
      log('!!', `permit ${entry.id} cancel failed: ${e.code || 'E_INTERNAL'}: ${e.message}`);
      return;
    }
    // A failure here (E_NOT_FOUND: the row is not written yet) is retried by call() once it can.
    await expireCancelled(c, entry);
  }

  return { call, cancel, inFlight: () => inFlight, caller, waitMs };
}

module.exports = { createPermit, verdictAnswer };
