'use strict';
// cmd-settings.cjs — the panel's display settings (ADR 0036 amendment 1 §6), the first piece of the
// settings command planned in command table §8. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit.
//
// Beyond the panel's `mod.*` keys it lists the memory levers (`memory.<lever>`) and the per-agent-type model and effort
// defaults (`agents.<type>.model|effort`), both defined in settings-keys.cjs from the modules that own them.
//
// `settings` and `settings <key>` are mode R: discovery and one read, no file created, no process
// started. `settings <key> <value>` writes the config file and nothing else — never the store — and
// returns the old and new value as its receipt (invariant 5). Nothing here imports src/core beyond the pure
// src/core/memory-levers.cjs (it requires nothing), through settings-keys.cjs.

const fs = require('node:fs');
const C = require('./config.cjs');
const K = require('./settings-keys.cjs');
const MN = require('../core/memory-notice.cjs');

// Test seams: a test replaces these to make a rename fail, change the file mid-write, or make the read-back disagree.
const seams = {
  rename: (from, to) => fs.renameSync(from, to),
  beforeRename: () => {},
  discover: (cwd) => C.discover(cwd),
};

const SETTING_NAMES = K.NAMES;
const RETIRED = require('../core/memory-levers.cjs').RETIRED; // memory.<key> of the removed note-review job

// A key of the removed note-review job. Setting a true value (or a model or a cost cap) is refused with the removal message and writes
// nothing; setting note_review false is accepted as the only value left, says it was removed and writes nothing; reading prints the message.
const retiredKey = (key) => (typeof key === 'string' && key.startsWith('memory.') && Object.prototype.hasOwnProperty.call(RETIRED, key.slice(7)) ? key.slice(7) : null);
function retiredResult(key, value) {
  const k = retiredKey(key);
  const message = RETIRED[k];
  if (value === undefined) return { code: 0, text: `${message}\n`, json: { key, removed: true, message } };
  if (k === 'note_review' && (value === false || value === 'false')) return { code: 0, text: `${message}\nnothing was written\n`, json: { key, removed: true, written: false, message } };
  return usageError(message);
}

const USAGE = [
  'usage: belay settings [<key> [<value>]]',
  '',
  '  settings              every setting: value, source and allowed values',
  '  settings <key>        one setting',
  '  settings <key> <value>  write it to the config file; prints the old and new value',
  '',
  `keys: ${K.MOD_NAMES.join(', ')}`,
  '      memory.<lever>   a memory lever, the default every run inherits (the run spec overrides it key by key)',
  '      agents.<type>.model | .effort | .codex_model   a default for coder, tester, reviewer, researcher or orchestrator;',
  '          null returns a key to the built-in roster default; it cannot select the substrate\'s own default',
  '',
].join('\n');

function usageError(message) {
  return { code: 2, text: `belay settings: ${message}\n\n${USAGE}`, json: { error: message, usage: USAGE.trim() } };
}

const row = (found, key) => K.effective(found, key);

function line(r, width) {
  return `  ${r.key.padEnd(width)}  ${JSON.stringify(r.value)}  (from ${r.source})  [${r.type || r.allowed.join(' | ')}]`;
}

function listResult(found, json) {
  const rows = SETTING_NAMES.map((k) => row(found, k));
  const memoryError = K.memoryBlockError(found);
  const notice = MN.noticeForConfig(found); // the panel reads this; null once a project is set
  const payload = { found: found.found, path: found.path, parse_error: found.parse_error || null, ...(memoryError ? { memory_error: memoryError } : {}), memory_notice: notice, settings: rows };
  if (json) return { code: 0, text: '', json: payload };
  const width = Math.max(...SETTING_NAMES.map((k) => k.length));
  const lines = [found.found ? `config: ${found.path}` : 'config: none found (settings <key> <value> writes one)'];
  if (found.parse_error) lines.push(`warning: ${found.parse_error}`);
  if (memoryError) lines.push(`warning: the memory block would be refused by a run: ${memoryError}`);
  if (notice) lines.push(`warning: ${notice.title}. ${notice.fix}`);
  lines.push('');
  for (const r of rows) {
    lines.push(line(r, width));
    if (r.note) lines.push(`  ${''.padEnd(width)}  ${r.note}`);
    if (r.invalid) lines.push(`  ${''.padEnd(width)}  invalid in file: ${r.invalid.reason}`);
  }
  lines.push('');
  return { code: 0, text: lines.join('\n'), json: payload };
}

function oneResult(found, key, json) {
  const r = row(found, key);
  const memoryError = key.startsWith('memory.') ? K.memoryBlockError(found) : null;
  if (json) return { code: 0, text: '', json: memoryError ? { ...r, memory_error: memoryError } : r };
  const warn = (r.invalid ? `warning: ${key}: ${r.invalid.reason}\n` : '')
    + (memoryError ? `warning: the memory block would be refused by a run: ${memoryError}\n` : '');
  const note = r.note ? `  ${''.padEnd(key.length)}  ${r.note}\n` : ''; // the "effective: ... because" line the full listing prints
  return { code: 0, text: `${warn}${line(r, key.length)}\n${note}`, json: r };
}

const fail = (message, key, extra = {}) => ({
  code: 1, text: `belay settings: ${message}\n`, json: { error: message, key, written: false, ...extra },
});

// Atomic: the temp file sits in the same directory so the rename never crosses a volume. `expectRaw` is
// the text the config was parsed from (null when the file did not exist); if the file differs just
// before the rename, another writer got in between and this write would silently undo theirs. A window
// remains between that compare and the rename: Windows has no compare-and-swap rename. There is no lock
// because the only other writer is the operator's editor; the mod writes nothing (ADR 0036 amendment 1 §6).
function writeAtomic(file, text, expectRaw) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    seams.beforeRename(file);
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== expectRaw) {
      const e = new Error(`${file} changed while it was being updated; nothing was written`);
      e.conflict = true;
      throw e;
    }
    seams.rename(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}

// The one writer of a setting, for the command and for any caller that sets one from elsewhere (a run-pause prompt).
// `found` is C.discover's answer, `value` the CLI's text or an already-typed value, `ctx` carries `cwd`. Validates (the whole
// memory block included), writes the config file atomically and returns { code, text, json } with the old and new value;
// a refusal writes nothing.
function writeSetting(found, key, rawValue, ctx) {
  if (retiredKey(key)) return retiredResult(key, rawValue);
  if (!SETTING_NAMES.includes(key)) return usageError(`unknown key ${key}; the keys are ${SETTING_NAMES.join(', ')}`);
  const parsed = K.parseValue(key, rawValue);
  if (parsed.error) return usageError(parsed.error);
  const { value } = parsed;
  const mappedFrom = parsed.mapped_from;
  if (found.found && found.parse_error) return fail(`refusing to write: ${found.parse_error}`, key);

  const old = row(found, key);
  const created = !found.found;
  // Follow-up (pre-existing, shared with cmd-init.cjs): writeDirOf falls back to the cwd, which can be
  // the home directory or a directory outside any project; the guard below covers both here.
  const file = created ? `${C.writeDirOf(ctx.cwd)}/${C.CONFIG_NAME}` : found.path;
  const dir = file.slice(0, file.lastIndexOf('/'));
  if (!C.discover(dir).searched.includes(file)) {
    return fail(`refusing to write ${file}: discovery would never read a config file there (the home directory)`, key);
  }
  const config = created ? {} : JSON.parse(JSON.stringify(found.config));

  // The whole memory block is checked before anything is written, so a lever that needs another (or a bad value) leaves the file as it was.
  const refused = K.refusal(config, key, value);
  if (refused) return usageError(refused);
  const segs = key.split('.');
  let at = config;
  for (const seg of segs.slice(0, -1)) {
    if (at[seg] === undefined) at[seg] = {};
    if (!at[seg] || typeof at[seg] !== 'object' || Array.isArray(at[seg])) {
      return fail(`refusing to write: "${seg}" in ${file} is not an object`, key);
    }
    at = at[seg];
  }
  at[segs[segs.length - 1]] = value;
  try {
    writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, created ? null : found.raw);
  } catch (e) {
    return fail(e.conflict ? e.message : `could not write ${file}: ${e.message}`, key);
  }

  // The proof is a fresh read of the file just written, not the value we meant to write. From here the
  // file is on disk, so a failure says written: true.
  const back = K.effective(seams.discover(ctx.cwd), key);
  if (back.value !== K.expectedValue(key, value) || back.source !== K.expectedSource(key, value, file)) {
    return fail(`wrote ${file} but reading it back gave ${JSON.stringify(back.value)} from ${back.source}`, key, { written: true, path: file });
  }

  const receipt = {
    key,
    old: { value: old.value, source: old.source, ...(old.invalid ? { invalid: old.invalid } : {}) },
    new: { value: back.value, source: back.source },
    path: file,
    created,
    ...(mappedFrom !== undefined ? { mapped_from: mappedFrom } : {}),
  };
  const text = `${key}: ${JSON.stringify(old.value)} (${old.source}) -> ${JSON.stringify(value)}\n`
    + (mappedFrom !== undefined ? `${JSON.stringify(mappedFrom)} is the 0.2.0 name of ${JSON.stringify(value)}; wrote ${JSON.stringify(value)}\n` : '')
    + `${created ? 'created' : 'updated'} ${file}\n`;
  return { code: 0, text, json: receipt };
}

async function run(ctx) {
  const [key, value, extra] = ctx.argv;
  if (retiredKey(key) && extra === undefined) return retiredResult(key, value);
  if (key !== undefined && !SETTING_NAMES.includes(key)) {
    return usageError(`unknown key ${key}; the keys are ${SETTING_NAMES.join(', ')}`);
  }
  if (extra !== undefined) return usageError('too many arguments');

  const found = C.discover(ctx.cwd);
  if (key === undefined) return listResult(found, ctx.json);
  if (value === undefined) return oneResult(found, key, ctx.json);
  return writeSetting(found, key, value, ctx);
}

module.exports = { run, writeSetting, USAGE, seams };
