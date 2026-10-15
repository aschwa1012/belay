'use strict';
// spawn-bounds.cjs — the one bound the run manager and the CLI's pipe bounds share: how long a spawn, a restart or a resume waits
// for the first-message index's query embedding (memory.embedQuery) before it builds the index from keywords alone. The CLI's
// bounds for a restart and a resume add it, so those verbs are never reported failed after they took effect.
module.exports = { SPAWN_EMBED_MS: 12000 };
