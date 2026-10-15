'use strict';
// spawn-bounds.cjs — the one bound the run manager and the CLI's pipe bounds share: how long a spawn, a restart or a resume waits
// for the first-message index's query embedding (memory.embedQuery) before it builds the index from keywords alone. The CLI's
// bounds for a restart and a resume add it, so those verbs are never reported failed after they took effect.
// NOTE_REVIEW_DRAIN_MS: how long the adapter's graceful shutdown waits for note-review jobs in flight before it stops any worker
// (lifecycle.shutdown's beforeStop). `belay run` adds it to the adapter wait when note review is on, so its close does not
// force-kill an adapter that is still draining.
module.exports = { SPAWN_EMBED_MS: 12000, NOTE_REVIEW_DRAIN_MS: 120000 };
