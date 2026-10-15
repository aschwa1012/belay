'use strict';
// memory-nominations.cjs — the notes nominated for CLAUDE.md promotion, by code, as the run-close scrubber's third scope item.
// The nomination rule (three or more tasks across two or more runs, counting only writers not shown the note) is the promotion
// step's, and it is not built yet: until it is, nothing is nominated. The scrub scope calls this one function, so wiring the
// rule in changes nothing else.
//
// Returns an array of { id, nomination_id, title, text, counts, nominated_at } for nominated notes without a draft (the shape the
// promotion step's own nominationsForScope returns; everything but `id` is shown to the scrubber as data). Synchronous, reads only.
// When the promotion step merges, the one require of this file in methods-memory-stages.cjs is swapped for memory-nominate.cjs.

function nominationsForScope(E, project) { // eslint-disable-line no-unused-vars
  return [];
}

module.exports = { nominationsForScope };
