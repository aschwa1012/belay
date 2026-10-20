// fake-core-note-rows.cjs — fake-core-memory.cjs whose memory reads return a row of type `note` when the id or query says "note",
// and a row of type `fact` otherwise, so a test can see which results the adapter frames as data (data-notice.cjs).
'use strict';

const base = require('./fake-core-memory.cjs');

async function openCore(opts) {
  const core = await base.openCore(opts);
  const row = (id) => ({ id, type: /note/.test(id) ? 'note' : 'fact', status: 'unverified', title: `title of ${id}`, text: `text of ${id}` });
  core.memory.get = async (a = {}) => (Array.isArray(a.ids)
    ? { rows: a.ids.map((id) => ({ ...row(id), found: true })), found: a.ids.length, missing: [] }
    : { ...row(a.id), found: true });
  core.memory.search = async (a = {}) => ({ warning: null, results: [row(`${/note/.test(a.query || '') ? 'note' : 'fact'}-hit`)], modes_run: ['keyword'], modes_failed: [], absence_established: false });
  core.memory.list = async (a = {}) => ({ rows: [row(a.namespace === 'notes' ? 'note-1' : 'fact-1')], total: 1 });
  core.memory.timeline = async (a = {}) => ({ anchor: row(a.anchor_id), before: [], after: [row('fact-after')], scope: 'namespace', scope_key: 'ns' });
  return core;
}

module.exports = { ...base, openCore };
