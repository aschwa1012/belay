'use strict';
// reserved-ids.cjs — pure. The worker ids a model cannot choose: the knowledge agent's (knowledge-<run>) and belay's own read-only jobs
// (job-ids.cjs). The MCP boundary (worker_spawn) and a task's plan (policy.review.spawn.worker_id) read this one list.
const { isJobId } = require('./job-ids.cjs');

const KNOWLEDGE_PREFIX = 'knowledge-';
const isReservedWorkerId = (id) => typeof id === 'string' && (id.startsWith(KNOWLEDGE_PREFIX) || isJobId(id));

module.exports = { KNOWLEDGE_PREFIX, isReservedWorkerId };
