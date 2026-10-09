'use strict';
// src/run — the orchestrator adapter's worker runtime. Contract §1 and §5.
// createRunManager({ core, dataDir, runId, paths }) → RunManager.

const { createRunManager, POLL_MS, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS } = require('./manager.cjs');
const { createWorkerControl } = require('./control.cjs');
const launch = require('./launch.cjs');
const parsers = require('./parsers.cjs');
const proc = require('./process.cjs');
const { CoreError } = require('./errors.cjs');

module.exports = {
  createRunManager,
  createWorkerControl,
  CoreError,
  launch,
  parsers,
  process: proc,
  pidAlive: proc.pidAlive,
  POLL_MS,
  CLAUDE_RESUME_WINDOW_MS,
  CODEX_RESUME_WINDOW_MS,
};
