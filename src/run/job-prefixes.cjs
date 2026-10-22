'use strict';
// job-prefixes.cjs — pure. The worker ids belay gives its own short read-only jobs: the note review job (removed, its prefix stays reserved), the run-close scrubber and
// the archive reviewer. A job gets no memory preface, no notes contract and no belay tool, its death wakes nobody, and a model cannot
// spawn a worker with one of these ids. The list lives in the core (src/core/job-ids.cjs), which guards the job rows' writes.
module.exports = require('../core/job-ids.cjs');
