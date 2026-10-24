'use strict';
// message.cjs — worker_message, moved verbatim out of manager.cjs to keep that file under its line budget. A Claude Code worker takes
// the text on its stdin; a Codex worker, whose previous process has exited by design, gets a new resume process. Refused E_BUSY while
// a stop, restart or resume holds the worker (lifecycle.cjs).

const P = require('./process.cjs');
const PI = require('./pid-identity.cjs'); // ADR 0039
const W = require('./worker.cjs');
const LC = require('./lifecycle.cjs');
const { fail } = require('./errors.cjs');
const { holdForLaunch } = require('./restart.cjs');

const now = () => Date.now();

function createMessage({ core, ctx, forWorker, refuseIfPaused, sendStdin, launch, guarded, writeRow }) {
  return async function message({ worker_id, text }) {
    const w = await forWorker(worker_id);
    refuseIfPaused(w); LC.refuseMessageDuringOp(w);
    if (typeof text !== 'string' || !text) fail('E_ARGS', 'message needs text');
    if (w.substrate === 'claude-code') {
      W.assertTakesMessage(w, fail, P.pidAlive); // live stdin, and no harness /compact in flight (E_BUSY)
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
    await holdForLaunch(w, core); LC.refuseMessageDuringOp(w); // before the checks below: they and the spawn stay one tick, so two concurrent messages still start one process
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
    await guarded(w, async () => {
      w.parser.noteStdinWrite();
      await writeRow(w, 'running');
    });
    return { worker_id, channel: 'codex-resume', bytes: Buffer.byteLength(text, 'utf8'), pid: w.pid, turn: w.turns + 1 };
  };
}

module.exports = { createMessage };
