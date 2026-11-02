'use strict';
// run-harness.cjs — the belay that wrote a run's row (ADR 0082 decision 1). Each epoch's row records the build of the code that
// wrote it, taken from the store stamp (schema-stamp.cjs) and never from an argument, so a run that spans an upgrade shows both
// builds. The run process also states three facts only it can know and the core cannot read: whether belay's own checkout was
// dirty, the sha-256 of the prompt actually sent to the orchestrator, and the `belay-prompt` version of the copy that prompt came
// from. A fact not stated is carried from the epoch before; none is invented. This records; nothing here refuses a run.

const { err } = require('./errors.cjs');
const ST = require('./schema-stamp.cjs');

const SHA = /^[0-9a-f]{64}$/;

// The run process states them (operator role), as the merge setting is stated; the orchestrator's adapter never does.
function check(h, caller) {
  if (caller.role !== 'operator') throw err('E_ROLE', 'run.attach harness is stated by the process that launched the run, never by the orchestrator', { role: caller.role });
  const bad = (m) => err('E_ARGS', `run.attach harness ${m}`, { harness: h });
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw bad('must be an object');
  for (const k of Object.keys(h)) if (!['dirty', 'prompt_sha', 'prompt_marker', 'run_build'].includes(k)) throw bad(`has no field ${k}`);
  if (h.run_build != null && !(typeof h.run_build === 'string' && /^[A-Za-z0-9_.@+-]{1,100}$/.test(h.run_build))) throw bad('run_build must be a build name or null');
  if (h.dirty != null && typeof h.dirty !== 'boolean') throw bad('dirty must be a boolean or null');
  if (h.prompt_sha != null && !(typeof h.prompt_sha === 'string' && SHA.test(h.prompt_sha))) throw bad('prompt_sha must be a sha-256 in hex or null');
  if (h.prompt_marker != null && !(typeof h.prompt_marker === 'string' && /^[\d.]{1,32}$/.test(h.prompt_marker))) throw bad('prompt_marker must be a version such as 0.4.0 or null');
}

const parsed = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v && typeof v === 'object' ? v : null; };

// -> the object for the row: this build, then each stated fact, else the epoch before's, else null.
function record(given, before) {
  const was = parsed(before) || {};
  const pick = (k) => (given && given[k] !== undefined ? given[k] : was[k] === undefined ? null : was[k]);
  return { build: ST.writtenBy(), schema_version: ST.SCHEMA_VERSION, dirty: pick('dirty'), prompt_sha: pick('prompt_sha'), prompt_marker: pick('prompt_marker'), run_build: pick('run_build') };
}

// One line for a receipt or a status. `build` is the owner's (the process that wrote the row); `run_build`, `dirty` and the prompt are the
// run process's. When the two builds differ the line says which is which, so it never mixes two installs silently.
function line(h) {
  if (!h || typeof h !== 'object' || !h.build) return 'not recorded';
  const dirty = h.dirty === true ? ' (dirty checkout)' : h.dirty === false ? ' (clean checkout)' : '';
  const prompt = h.prompt_sha ? `, prompt ${h.prompt_marker ? `template ${h.prompt_marker} ` : ''}sha ${String(h.prompt_sha).slice(0, 12)}` : '';
  if (h.run_build && h.run_build !== h.build) return `store owner ${h.build}; run process ${h.run_build}${dirty}${prompt}`;
  return `${h.build}${dirty}${prompt}`;
}

module.exports = { check, record, line, parsed };
