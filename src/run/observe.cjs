'use strict';
const path = require('node:path');
// observe.cjs — the mechanical observation builder (ADR 0041 §3). One observation per turn, never per tool
// call. Pure and deterministic: no clock, no I/O, no model call. Every field is read off the turn's events
// (captured shape, ADR 0041 §2) or the turn's final text; `facts` stays empty because a mechanical builder
// states no facts. The caller stores the result; redaction happens at the store (ADR 0040 §3).

const NARRATIVE_MAX = 1200;
const TITLE_MAX = 160;
const TITLE_FILES = 3;

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Events are the parser's: the discriminator is `kind` (parsers.cjs ev()), not `type`.
const WITHHELD = '(command withheld: redaction unavailable)';

// Codex reports edits as patch or file-change items, under names the parser passes through unchanged.
const isEditTool = (t) => EDIT_TOOLS.has(t) || (typeof t === 'string' && /patch|file_?change/i.test(t));

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

// Cut to at most `max` bytes without splitting a code point.
function cutBytes(s, max) {
  let out = s.slice(0, max); // a character is at least one byte, so this cannot cut too little
  while (out && byteLength(out) > max) out = out.slice(0, -1);
  // A cut that landed inside a surrogate pair leaves a lone high surrogate.
  if (out && /[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

// ADR 0044 decision 7: a path under the worktree root is stored relative to it, in forward slashes; a path
// outside it stays absolute, in forward slashes, and so never matches a worktree-relative files_owned entry.
// A Windows root (drive letter or UNC) compares without regard to case. A relative path is only normalised.
// One spelling: forward slashes, a \\?\ long-path prefix dropped, '.' and '..' resolved, no trailing slash.
function normPath(p) {
  let f = String(p).replace(/\\/g, '/').replace(/^\/\/[?.]\//, '');
  const unc = /^\/\/[^/]/.test(f);
  f = path.posix.normalize(f);
  if (unc && !f.startsWith('//')) f = '/' + f;
  return f.length > 1 ? f.replace(/\/+$/, '') : f;
}

function relativeTo(p, root) {
  const f = normPath(p);
  if (typeof root !== 'string' || !root) return f;
  const r = normPath(root);
  const fold = /^([A-Za-z]:|\/\/)/.test(r);
  const a = fold ? f.toLowerCase() : f;
  const b = fold ? r.toLowerCase() : r;
  if (a === b) return '.';
  return a.startsWith(b.endsWith('/') ? b : b + '/') ? f.slice(b.endsWith('/') ? r.length : r.length + 1) : f;
}

const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
const pushUnique = (list, v) => { if (typeof v === 'string' && v && !list.includes(v)) list.push(v); };
const filesOf = (e) => (Array.isArray(e && e.files) ? e.files : []);
const argPath = (args) => {
  if (!args || typeof args !== 'object') return null;
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof args[k] === 'string' && args[k]) return args[k];
  return null;
};

// The command comes from the redacted `command` field only. When capture ran without a redactor that field is
// null: the raw args.command is never used in its place (it would reach the stored body and text). Returns
// undefined for an event that ran no command, null for one whose command was withheld.
function commandOf(e) {
  if (typeof e.command === 'string' && e.command) return e.command;
  const a = e.args;
  const raw = !!a && typeof a === 'object' && ((typeof a.command === 'string' && a.command) || (Array.isArray(a.command) && a.command.length));
  return raw ? null : undefined;
}

function scan(events, root) {
  const filesRead = [];
  const filesModified = [];
  const toolCounts = {};
  const commands = [];
  const byUseId = new Map(); // tool_use_id -> index into commands
  let errors = 0;

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'tool_use') {
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      const cmd = commandOf(e);
      if (cmd !== undefined) {
        commands.push({ tool_use_id: e.tool_use_id === undefined ? null : e.tool_use_id, command: cmd, exit_code: null, exit_code_source: null });
        if (e.tool_use_id) byUseId.set(e.tool_use_id, commands.length - 1);
      }
      const argp = argPath(e.args);
      const p = argp && relativeTo(argp, root);
      if (p && READ_TOOLS.has(e.tool)) pushUnique(filesRead, p);
      if (p && isEditTool(e.tool)) pushUnique(filesModified, p);
    } else if (e.kind === 'tool_result') {
      if (e.is_error) errors += 1;
      const idx = e.tool_use_id !== undefined && e.tool_use_id !== null ? byUseId.get(e.tool_use_id) : undefined;
      if (idx !== undefined) {
        commands[idx].exit_code = Number.isInteger(e.exit_code) ? e.exit_code : null;
        commands[idx].exit_code_source = e.exit_code_source || null;
      }
      const target = isEditTool(e.tool) ? filesModified : (READ_TOOLS.has(e.tool) ? filesRead : null);
      // A failed result names no file it changed (a failed Codex file_change lists what it tried).
      if (target && !e.is_error) for (const p of filesOf(e)) pushUnique(target, relativeTo(p, root));
    }
  }
  // A file that was modified is not also listed as merely read.
  return { filesRead: filesRead.filter((p) => !filesModified.includes(p)), filesModified, toolCounts, commands, errors };
}

function typeOf({ filesModified, filesRead, commands }) {
  if (filesModified.length) return 'change';
  if (filesRead.length) return 'discovery';
  const last = commands[commands.length - 1];
  if (last && Number.isInteger(last.exit_code) && last.exit_code !== 0) return 'failure';
  return 'turn';
}

function titleOf(turn, { filesModified, filesRead, commands }) {
  const parts = [];
  const named = (verb, files) => {
    const shown = files.slice(0, TITLE_FILES).map(base).join(', ');
    parts.push(`${verb} ${shown}${files.length > TITLE_FILES ? ` +${files.length - TITLE_FILES} more` : ''}`);
  };
  if (filesModified.length) named('modified', filesModified);
  else if (filesRead.length) named('read', filesRead);
  if (commands.length) {
    const failed = commands.filter((c) => Number.isInteger(c.exit_code) && c.exit_code !== 0).length;
    parts.push(`ran ${commands.length} command${commands.length === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`);
  }
  return cutBytes(`turn ${turn}: ${parts.length ? parts.join('; ') : 'no tool activity'}`, TITLE_MAX);
}

function textOf(body, title) {
  const lines = [title];
  if (body.files_modified.length) lines.push(`files modified: ${body.files_modified.join(', ')}`);
  if (body.files_read.length) lines.push(`files read: ${body.files_read.join(', ')}`);
  for (const c of body.commands) {
    lines.push(`command: ${c.command === null ? WITHHELD : c.command} -> exit ${c.exit_code === null ? 'unknown' : c.exit_code}${c.exit_code_source ? ` (${c.exit_code_source})` : ''}`);
  }
  if (body.errors) lines.push(`tool errors: ${body.errors}`);
  if (body.narrative) lines.push(`worker-stated: ${body.narrative}`);
  return lines.join('\n');
}

// buildObservation({ turn, worker_id, task_id, substrate, events, final_text, worktree }) → { title, type, body, text }. `type` is the class
// (change, discovery, failure, turn); the stored row's type stays 'observation' and the class is kept as `body.kind`.
// `worker_id`, `task_id` and `substrate` are the caller's tags for the stored row; they do not shape the
// body, so the same turn under two ids yields the same observation.
function buildObservation(input) {
  const { turn, events, final_text: finalText, worktree } = input || {};
  const c = scan(Array.isArray(events) ? events : [], worktree);
  const kind = typeOf(c);
  const body = {
    v: 1, kind, turn: turn === undefined ? null : turn,
    files_read: c.filesRead, files_modified: c.filesModified,
    commands: c.commands, tool_counts: c.toolCounts, errors: c.errors,
    facts: [], narrative: cutBytes(typeof finalText === 'string' ? finalText : '', NARRATIVE_MAX),
    narrative_source: 'worker-stated',
  };
  const title = titleOf(body.turn === null ? '?' : body.turn, c);
  return { title, type: kind, body, text: textOf(body, title) };
}

module.exports = { buildObservation, relativeTo, NARRATIVE_MAX, TITLE_MAX };
