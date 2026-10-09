'use strict';
// embedder-bounds.cjs — ADR 0034. What `belay resume` and the run's own resume agree on: the embedder re-load a
// resume of an embedder-failure pause asks for at most RESUME_WARM_MS, and the CLI adds it plus a margin to its own
// bound for that resume. Required by cmd-pause.cjs (which must not reach src/run) and cmd-run.cjs. Requires nothing.

const RESUME_WARM_MS = 100000;
const RESUME_MARGIN_MS = 15000;

module.exports = { RESUME_WARM_MS, RESUME_MARGIN_MS };
