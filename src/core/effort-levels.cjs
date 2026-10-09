'use strict';
// The levels Claude Code's --effort takes (ADR 0028 decision 1). src/core cannot import src/run, so the
// list lives here; src/run/launch.cjs keeps its own EFFORT_LEVELS and tests/core/effort.test.cjs asserts
// the two are equal.
module.exports = { EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'] };
