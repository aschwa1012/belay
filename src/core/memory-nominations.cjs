'use strict';
// memory-nominations.cjs — the notes nominated for CLAUDE.md promotion, by code, as the run-close scrubber's third scope item.
// The nomination rule (three or more tasks across two or more runs, counting only writers not shown the note) is the promotion
// step's, and it is not built yet: until it is, nothing is nominated. The scrub scope calls this one function, so wiring the
// rule in changes nothing else.
//
// Returns an array of { id, facts } for notes of the project that are live and nominated; `facts` is the nomination's own
// record (the tasks and runs counted), shown to the scrubber as data. Reads only.

function nominationsForScope(E, project) { // eslint-disable-line no-unused-vars
  return [];
}

module.exports = { nominationsForScope };
