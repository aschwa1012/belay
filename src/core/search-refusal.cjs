'use strict';
// search-refusal.cjs — a search the engine refused or failed is a row in the search log too (ADR 0050 decision 7: the log is the full account of
// the searches the owner served, and a call that reached the engine and was refused is one of them). The row is the search row with `ok` 0, the error's
// code in `code`, and the refusal as the only entry of `fallback.failed` (mode 'refused'); it carries no ranks. Only a search that parsed and
// was asked to log is recorded (the same lever, owner and internal-search rules as a served one); a bad argument is not a search. Never throws.

const SL = require('./search-log.cjs');

function wrap(searchRun) {
  return async function search(E, caller, args, internal = {}) {
    const st = {};
    const t0 = Date.now();
    try {
      return await searchRun(E, caller, args, internal, st);
    } catch (e) {
      try {
        const abandoned = args && args[Symbol.for('belay.search.abandoned')];
        const { o, lv } = st;
        if (o && lv && lv.search_log && E.owner && internal.log !== false && !(abandoned && abandoned.abandoned)) {
          SL.record(E, caller, {
            kind: 'search', tier: o.tier, query: o.query, mode: o.mode, namespaces: o.namespaces, k: o.k, offset: o.offset, ms: { total: Date.now() - t0 }, capMb: lv.search_log_cap_mb,
            ranks: [], code: e.code || 'E_INTERNAL', fallback: { failed: [{ mode: 'refused', code: e.code || 'E_INTERNAL', message: String(e.message || e) }] },
          });
        }
      } catch { /* the log is a record, never the search's failure */ }
      throw e;
    }
  };
}

module.exports = { wrap };
