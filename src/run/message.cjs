'use strict';
// message.cjs — worker_message, moved verbatim out of manager.cjs to keep that file under its line budget. A Claude Code worker takes
// the text on its stdin; a Codex worker, whose previous process has exited by design, gets a new resume process. Refused E_BUSY while
// a stop, restart or resume holds the worker (lifecycle.cjs). During a harness /compact a Claude Code message is queued (ADR 0058,
// compaction.cjs queueIfCompacting), and only after those refusals: a message is never held for a worker that is being stopped.

const P = require('./process.cjs');
const PI = require('./pid-identity.cjs'); // ADR 0039
const W = require('./worker.cjs');
const LC = require('./lifecycle.cjs');
const { fail } = require('./errors.cjs');
const { holdForLaunch, leaseField, leaseNote } = require('./restart.cjs');
const RG = require('./relaunch-guard.cjs'); // ADR 0026 amendment 2: a death during a relaunch keeps its lease

const now = () => Date.now();

function createMessage({ core, ctx, forWorker, refuseIfPaused, sendStdin, launch, guarded, writeRow }) {
  return async function message({ worker_id, text: given }) {
    let text = given;
    const w = await forWorker(worker_id);
    refuseIfPaused(w); LC.refuseMessageDuringOp(w);
    if (typeof text !== 'string' || !text) fail('E_ARGS', 'message needs text');
    if (w.substrate === 'claude-code') {
      const held = W.assertTakesMessage(w, fail, P.pidAlive, text); // live stdin; queued during a harness /compact (ADR 0058)
      if (held && held.queued) return { worker_id, channel: 'queued', ...held, pid: w.pid, turn: w.turns + 1 };
      if (held && held.flush) text = [...held.flush, text].join('\n\n'); // left queued behind an expired compaction: written first
      // A message starts a turn, mid-turn again until the next `result` (`launch` resets this per process).
      // 5b fix round, finding 4: the send runs INSIDE turnStarted, before its own await, so no window is
      // left between the liveness check above and the write for a death to land in.
      const { sent: bytes } = await W.turnStarted(w, ctx, () => sendStdin(w, text));
      w.lastEventAt = now();
      return { worker_id, channel: 'stdin', bytes, pid: w.pid, turn: w.turns + 1 };
    }
    // Codex: the previous process has exited by design, so a message is a new resume process
    // (ADR 0001 §4, ADR 0008 §6). Returns at once with the new pid; the turn lands later.
    if (!w.sessionId) fail('E_SUBSTRATE', 'codex worker has no thread id to resume', { worker_id, substrate: w.substrate, state: w.state });
    const foreign = !w.child && await PI.verifiedLive(w); // by identity, never the pid number alone: an idle worker's pid is free for reuse
    // ADR 0026 amendment 2 (proposed): from here until launch() has moved w.launches, a death of this worker keeps its lease.
    LC.refuseMessageDuringOp(w); RG.refuseIfRelaunching(w, 'message'); // ADR 0026 amendment 2: one relaunch at a time, checked in the tick the flag is set
    const hold = await RG.relaunching(w, writeRow, async () => {
      await w.queue; // the previous turn's rows land first (a death meanwhile keeps the lease: relaunch-guard.cjs)
      const held = await holdForLaunch(w, core);
      LC.refuseMessageDuringOp(w); text += leaseNote(held); // ADR 0026 amendment 2 // before the checks below: they and the spawn stay one tick, so two concurrent messages still start one process
      // An adopted worker whose process is still alive is one a previous adapter owns. belay is not
      // its parent (invariant 1), so it cannot see that turn end, and starting a second process on
      // the same worktree is the one thing one-process-per-turn exists to prevent. Stop it first.
      if (!w.child && foreign) {
        fail('E_SUBSTRATE', 'codex worker is a live process this adapter did not spawn, so it cannot be given a turn; stop it first', { worker_id, substrate: w.substrate, state: w.state, pid: w.pid, adopted: true });
      }
      if (w.child && P.pidAlive(w.pid)) {
        fail('E_SUBSTRATE', 'codex worker is mid-turn; one process per turn', { worker_id, substrate: w.substrate, state: w.state, pid: w.pid });
      }
      await launch(w, { resume: w.sessionId, prompt: text });
      return held;
    });
    await guarded(w, async () => {
      w.parser.noteStdinWrite();
      await writeRow(w, 'running');
    });
    return { worker_id, channel: 'codex-resume', bytes: Buffer.byteLength(text, 'utf8'), pid: w.pid, turn: w.turns + 1, ...leaseField(hold) };
  };
}

module.exports = { createMessage };
