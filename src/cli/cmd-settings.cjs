'use strict';
// cmd-settings.cjs — the panel's display settings (ADR 0036 amendment 1 §6), the first piece of the
// settings command planned in command table §8. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit.
//
// `settings` and `settings <key>` are mode R: discovery and one read, no file created, no process
// started. `settings <key> <value>` writes the config file and nothing else — never the store — and
// returns the old and new value as its receipt (invariant 5). Nothing here imports src/core.

const fs = require('node:fs');
const C = require('./config.cjs');

// Test seams: a test replaces these to make a rename fail, change the file mid-write, or make the read-back disagree.
const seams = {
  rename: (from, to) => fs.renameSync(from, to),
  beforeRename: () => {},
  discover: (cwd) => C.discover(cwd),
};

const SETTING_NAMES = C.KEY_NAMES.filter((k) => C.KEYS[k].allowed);

const USAGE = [
  'usage: belay settings [<key> [<value>]]',
  '',
  '  settings              every display setting: value, source and allowed values',
  '  settings <key>        one setting',
  '  settings <key> <value>  write it to the config file; prints the old and new value',
  '',
  `keys: ${SETTING_NAMES.join(', ')}`,
  '',
].join('\n');

function usageError(message) {
  return { code: 2, text: `belay settings: ${message}\n\n${USAGE}`, json: { error: message, usage: USAGE.trim() } };
}

function row(found, key) {
  const eff = C.effective(found, key);
  return {
    key,
    value: eff.value,
    source: eff.source,
    default: C.KEYS[key].default,
    allowed: eff.allowed,
    describe: eff.describe,
    ...(eff.invalid ? { invalid: eff.invalid } : {}),
  };
}

function line(r, width) {
  return `  ${r.key.padEnd(width)}  ${JSON.stringify(r.value)}  (from ${r.source})  [${r.allowed.join(' | ')}]`;
}

function listResult(found, json) {
  const rows = SETTING_NAMES.map((k) => row(found, k));
  const payload = { found: found.found, path: found.path, parse_error: found.parse_error || null, settings: rows };
  if (json) return { code: 0, text: '', json: payload };
  const width = Math.max(...SETTING_NAMES.map((k) => k.length));
  const lines = [found.found ? `config: ${found.path}` : 'config: none found (settings <key> <value> writes one)'];
  if (found.parse_error) lines.push(`warning: ${found.parse_error}`);
  lines.push('');
  for (const r of rows) {
    lines.push(line(r, width));
    if (r.invalid) lines.push(`  ${''.padEnd(width)}  invalid in file: ${r.invalid.reason}`);
  }
  lines.push('');
  return { code: 0, text: lines.join('\n'), json: payload };
}

function oneResult(found, key, json) {
  const r = row(found, key);
  if (json) return { code: 0, text: '', json: r };
  const warn = r.invalid ? `warning: ${key}: ${r.invalid.reason}\n` : '';
  return { code: 0, text: `${warn}${line(r, key.length)}\n`, json: r };
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

function setResult(found, key, value, ctx) {
  const spec = C.KEYS[key];
  if (!spec.allowed.includes(value)) {
    return usageError(`${JSON.stringify(value)} is not a value of ${key}; the allowed values are ${spec.allowed.join(', ')}`);
  }
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

  const [group, name] = key.split('.');
  if (config[group] === undefined) config[group] = {};
  if (!config[group] || typeof config[group] !== 'object' || Array.isArray(config[group])) {
    return fail(`refusing to write: "${group}" in ${file} is not an object`, key);
  }
  config[group][name] = value;
  try {
    writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, created ? null : found.raw);
  } catch (e) {
    return fail(e.conflict ? e.message : `could not write ${file}: ${e.message}`, key);
  }

  // The proof is a fresh read of the file just written, not the value we meant to write. From here the
  // file is on disk, so a failure says written: true.
  const back = C.effective(seams.discover(ctx.cwd), key);
  if (back.value !== value || back.source !== file) {
    return fail(`wrote ${file} but reading it back gave ${JSON.stringify(back.value)} from ${back.source}`, key, { written: true, path: file });
  }

  const receipt = {
    key,
    old: { value: old.value, source: old.source, ...(old.invalid ? { invalid: old.invalid } : {}) },
    new: { value: back.value, source: back.source },
    path: file,
    created,
  };
  const text = `${key}: ${JSON.stringify(old.value)} (${old.source}) -> ${JSON.stringify(value)}\n`
    + `${created ? 'created' : 'updated'} ${file}\n`;
  return { code: 0, text, json: receipt };
}

async function run(ctx) {
  const [key, value, extra] = ctx.argv;
  if (key !== undefined && !SETTING_NAMES.includes(key)) {
    return usageError(`unknown key ${key}; the keys are ${SETTING_NAMES.join(', ')}`);
  }
  if (extra !== undefined) return usageError('too many arguments');

  const found = C.discover(ctx.cwd);
  if (key === undefined) return listResult(found, ctx.json);
  if (value === undefined) return oneResult(found, key, ctx.json);
  return setResult(found, key, value, ctx);
}

module.exports = { run, USAGE, seams };
