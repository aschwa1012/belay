'use strict';
// job-ids.cjs — pure. The worker ids belay gives its own short read-only jobs: the note review job (removed, its prefix stays reserved), the run-close scrubber and the
// archive reviewer. src/run/job-prefixes.cjs re-exports this.
const PREFIXES = Object.freeze(['notereview-', 'scrub-', 'archreview-']);
const isJobId = (id) => typeof id === 'string' && PREFIXES.some((p) => id.startsWith(p));
module.exports = { PREFIXES, isJobId };
