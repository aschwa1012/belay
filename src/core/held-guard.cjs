'use strict';
// held-guard.cjs — nothing changes a held note's visibility or status except the operator and the archive review's cited outcome.
//
// What decides whether a note is seen: its namespace, its status, another row's `supersedes`, its body's `state` / `promoted_to`, its
// existence and its `ttl_at` (no note carries one). Every write of these goes through a store method (store.cjs), and each of those calls
// `store.guard(op, id, detail)` inside its own transaction, before its write, after every await of the calling method. This module is that
// hook. It throws E_HELD when the row is a note in project/<p> that is held now (isHeldNow: the pointer on the note, or an active harness hold
// row of any kind, an unsupported queue row included) and the call has no authority for it.
//
// Authority is the call's context, carried by AsyncLocalStorage: the engine runs every write method inside `runAs(caller, ...)`, so it follows
// the method across its awaits and never leaks into another call. Two authorities, nothing else:
//   - the explicit operator: role operator and not the harness channel (the test memory.notePromote already uses). The human's own CLI command.
//     The run's close stages run as the operator on the harness channel and get no blanket authority;
//   - the archive review, one note at a time: `grant(kind, noteId, fn)` wraps ONE synchronous transaction of methods-memory-review.cjs, after
//     its cites and bindings were checked, and covers ops on that one note. The token expires when the wrapper returns: a timer or an
//     unawaited promise created inside it inherits the context but finds the token dead, so it has no authority (it cannot reuse one).
// A caller with neither, or no context at all (a store used directly), is refused. A hostile process of the same user can still run the
// operator's own commands; belay's identity is the process's.

const { AsyncLocalStorage } = require('node:async_hooks');
const { err } = require('./errors.cjs');
const { isHeldNow, parse } = require('./memory-facts.cjs');

const als = new AsyncLocalStorage();

const explicitOperator = (caller) => !!caller && caller.role === 'operator' && caller.channel !== 'harness';

// Runs fn with the call's caller as its context. The engine does this for every write-kind method.
function runAs(caller, fn) { return als.run({ caller, grant: null }, fn); }

// Runs the synchronous fn with the archive review's authority over `noteId`. The token dies when fn returns or throws.
function grant(kind, noteId, fn) {
  const parent = als.getStore();
  const token = { kind, note: noteId, live: true };
  try {
    const out = als.run({ caller: parent ? parent.caller : null, grant: token }, fn);
    if (out && typeof out.then === 'function') throw new Error('held-guard grant() wraps a synchronous transaction; it was given an asynchronous one');
    return out;
  } finally { token.live = false; }
}

function authorised(id) {
  const ctx = als.getStore();
  if (!ctx) return false;
  if (explicitOperator(ctx.caller)) return true;
  const g = ctx.grant;
  return !!(g && g.live && g.note === id);
}

// The hook the engine installs on its store. `op` names the write: move, supersede, status, delete, body.
function check(E, op, id, detail = {}) {
  if (authorised(id)) return;
  const row = E.store.p('SELECT id, namespace, type, body FROM memory_entries WHERE id = ?').get(id);
  if (!row || row.type !== 'note' || !String(row.namespace).startsWith('project/')) return;
  const note = { ...row, b: parse(row.body) };
  if (!isHeldNow(E, note)) return;
  const hold = E.store.p("SELECT id FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness' AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.state') IN ('held', 'queued') ORDER BY created_at DESC LIMIT 1").get(`held/${row.namespace.slice(8)}`, id);
  const heldRow = hold ? hold.id : (note.b.held ? note.b.held.row : null);
  throw err('E_HELD', `note ${id} is held for the archive review (row ${heldRow}); only the archive review or the operator settles it, so this ${op} is refused`, { id, held_row: heldRow, op, ...detail });
}

module.exports = { runAs, grant, check, explicitOperator };
