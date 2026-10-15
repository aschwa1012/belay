'use strict';
// job-prefixes.cjs — pure. The worker ids belay gives its own short read-only jobs: the note review job, the run-close scrubber and the
// archive reviewer. A job gets no memory preface, no notes contract and no belay tool, its death wakes nobody, and a model cannot spawn
// a worker with one of these ids.
const PREFIXES = Object.freeze(['notereview-', 'scrub-', 'archreview-']);
const isJobId = (id) => typeof id === 'string' && PREFIXES.some((p) => id.startsWith(p));
module.exports = { PREFIXES, isJobId };
