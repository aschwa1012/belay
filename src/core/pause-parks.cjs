'use strict';
// pause-parks.cjs — build step 6i-2 design item 1 (ADR 0023 amendment 4 decisions 1 and 3). Validation
// and read-side parsing for the run row's `pause_parks` column, kept out of methods-run.cjs (257/260
// lines already) rather than compressed onto its lines (R12: new code goes in new modules).

const { err } = require('./errors.cjs');

const MAX_ENTRIES = 500;
// item d (R-review: a 1 MB worker_id was accepted): worker_id and paused_by are identity strings a
// caller composes (`role:pid`) or names, never free text; 256 is generous for either and cheap to bind.
const MAX_ID_LEN = 256;

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN; }

// `parked`/`already_parked`: [{ worker_id, paused_at, paused_by }], amendment 4 decision 1's shape.
function validateParkList(list, field) {
  if (!Array.isArray(list)) throw err('E_ARGS', `run.setPaused's parks.${field} must be an array`, { field });
  if (list.length > MAX_ENTRIES) throw err('E_ARGS', `run.setPaused's parks.${field} carries more than ${MAX_ENTRIES} entries`, { field });
  const idRule = `non-empty string, at most ${MAX_ID_LEN} chars`;
  return list.map((entry, i) => {
    const bad = !entry || typeof entry !== 'object' || !isNonEmptyString(entry.worker_id)
      || !Number.isInteger(entry.paused_at) || !isNonEmptyString(entry.paused_by);
    if (bad) {
      const msg = `run.setPaused's parks.${field}[${i}] needs worker_id (${idRule}), paused_at (integer)`
        + ` and paused_by (${idRule})`;
      throw err('E_ARGS', msg, { field, index: i });
    }
    return { worker_id: entry.worker_id, paused_at: entry.paused_at, paused_by: entry.paused_by };
  });
}

// `unconfirmed`: [worker_id] — a call that failed or timed out carries no confirmed stamp to record.
function validateUnconfirmed(list) {
  if (!Array.isArray(list)) throw err('E_ARGS', "run.setPaused's parks.unconfirmed must be an array", { field: 'unconfirmed' });
  if (list.length > MAX_ENTRIES) {
    throw err('E_ARGS', `run.setPaused's parks.unconfirmed carries more than ${MAX_ENTRIES} entries`, { field: 'unconfirmed' });
  }
  const idRule = `non-empty worker id string, at most ${MAX_ID_LEN} chars`;
  return list.map((id, i) => {
    if (!isNonEmptyString(id)) throw err('E_ARGS', `run.setPaused's parks.unconfirmed[${i}] must be a ${idRule}`, { field: 'unconfirmed', index: i });
    return id;
  });
}

// Validated at the boundary (design item 1): `parks` must be an object; each of its three lists is
// validated and normalised by its own rule, so nothing but the known shape ever reaches storage.
function validateParks(parks) {
  if (!parks || typeof parks !== 'object' || Array.isArray(parks)) {
    throw err('E_ARGS', 'run.setPaused needs parks as an object with parked, already_parked and unconfirmed', { field: 'parks' });
  }
  return {
    parked: validateParkList(parks.parked, 'parked'),
    already_parked: validateParkList(parks.already_parked, 'already_parked'),
    unconfirmed: validateUnconfirmed(parks.unconfirmed),
  };
}

// Fix-up (b): `parks` is accepted only with `paused: true` (design item 1's own rule); given with
// `paused: false` it is refused, not silently dropped. Kept here, one call, so methods-run.cjs's own
// 260-line budget holds `setPaused` to the single line it already had.
function resolveParks(args) {
  if (args.parks !== undefined && !args.paused) {
    throw err('E_ARGS', "run.setPaused's parks may only be given with paused: true", { field: 'parks' });
  }
  return args.paused && args.parks !== undefined ? validateParks(args.parks) : null;
}

// Read side: the run row's pause_parks column is TEXT (rows.cjs's JSON_COLUMNS does not cover `run`,
// unowned this step as it was for paused_at/paused_by), so methods-run.cjs parses it back to an object
// here — bound and returned as `task.acceptance` is, never as a string the caller parses (design item 1).
// item c: `run.attach`'s own `previous` is `rows.current`'s raw row, never itself passed through
// appendRun, so methods-run.cjs's `attach` calls this on it too, or its pause_parks stays unparsed text.
function parseRunRow(row) {
  if (row && typeof row.pause_parks === 'string') {
    try { row.pause_parks = JSON.parse(row.pause_parks); } catch { /* malformed text is surfaced, not hidden */ }
  }
  return row;
}

// item e (R12): the three pause fields a run row carries, built here so methods-run.cjs's own appendRun
// calls (setPaused, end) need not spell all three inline onto one long line each.
function clearedPause() { return { paused_at: null, paused_by: null, pause_parks: null }; }
function pauseFields(paused, at, by, parks) {
  return paused ? { paused_at: at, paused_by: by, pause_parks: parks } : clearedPause();
}

module.exports = { validateParks, resolveParks, parseRunRow, clearedPause, pauseFields };
