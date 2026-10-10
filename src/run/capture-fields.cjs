'use strict';
// ADR 0041 §2: the extra tool_use / tool_result fields the parser adds when capture is on. Pure
// functions over one stream item; the parser owns the state (tool_use_id -> pending call). Nothing
// here runs when capture is off. head, tail and command are redacted (ADR 0040 §3) before they
// leave the parser, and redaction runs on the whole text before truncation so a secret cut by the
// byte cap cannot survive as a fragment.

const MAX_LINES = 3;
const MAX_BYTES = 300;

let redactFn; // undefined = not tried, null = module absent
function defaultRedact() {
  if (redactFn === undefined) {
    try {
      const m = require('../core/redact.cjs'); // lazy: the module is built beside this one
      redactFn = (t) => m.redact(t).text;
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND') redactFn = null;
      else throw e;
    }
  }
  return redactFn;
}

// Cut to at most `max` bytes without splitting a character; `fromEnd` keeps the end instead.
function clip(s, max, fromEnd) {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let b = Buffer.from(s, 'utf8');
  if (fromEnd) {
    b = b.subarray(b.length - max);
    let i = 0;
    while (i < b.length && (b[i] & 0xc0) === 0x80) i += 1; // drop a leading continuation byte
    return b.subarray(i).toString('utf8');
  }
  b = b.subarray(0, max);
  return b.toString('utf8').replace(/\uFFFD+$/, '');
}

// Returns { head, tail, redaction }. `tail` is '' when the whole text fits in `head`.
// With no redactor available head and tail are null and `redaction` says so: raw text never leaves.
function headTail(text, redact) {
  const fn = redact || defaultRedact();
  if (!fn) return { head: null, tail: null, redaction: 'unavailable' };
  const lines = fn(String(text == null ? '' : text)).split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = clip(lines.slice(0, MAX_LINES).join('\n'), MAX_BYTES, false);
  const rest = lines.length > MAX_LINES ? lines.slice(Math.max(MAX_LINES, lines.length - MAX_LINES)) : [];
  return { head, tail: clip(rest.join('\n'), MAX_BYTES, true), redaction: 'applied' };
}

function commandOf(input, redact) {
  const c = input && typeof input.command === 'string' ? input.command : null;
  if (c == null) return null;
  const fn = redact || defaultRedact();
  if (!fn) return null;
  return clip(fn(c), MAX_BYTES, false);
}

// Claude Code: `Exit code N` opens an error result's text. A Bash result that is not an error ran
// to exit 0. Anything else is unknown.
function claudeExit(tool, isError, text) {
  if (isError) {
    const m = /^Exit code (-?\d+)/.exec(String(text));
    return m ? { exit_code: Number(m[1]), exit_code_source: 'reported' } : { exit_code: null, exit_code_source: null };
  }
  return tool === 'Bash' ? { exit_code: 0, exit_code_source: 'no-error' } : { exit_code: null, exit_code_source: null };
}

function claudeFiles(toolUseResult, args) {
  if (toolUseResult && typeof toolUseResult === 'object' && typeof toolUseResult.filePath === 'string') return [toolUseResult.filePath];
  const a = args || {};
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof a[k] === 'string') return [a[k]];
  return [];
}

function codexExit(item) {
  return Number.isInteger(item.exit_code)
    ? { exit_code: item.exit_code, exit_code_source: 'reported' }
    : { exit_code: null, exit_code_source: null };
}

function codexFiles(item) {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.map((c) => (c && typeof c.path === 'string' ? c.path : null)).filter(Boolean);
}

module.exports = { headTail, commandOf, claudeExit, claudeFiles, codexExit, codexFiles, clip, MAX_LINES, MAX_BYTES };
