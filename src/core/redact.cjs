'use strict';
// Redaction for memory writes (proposed ADR 0040, section 3). A pure function:
// no I/O, requires nothing. Every memory write passes through it before it is
// hashed or embedded, so a secret never reaches the store. It is a heuristic
// scrubber for developer text: it errs toward redacting a value, but leaves code
// that only names a secret (a type, a call, a keyword) alone.
//
// Keys need a realistic length (a prefix plus at least 20 token characters) and a
// non-token character before them, so prose such as `task-sk-1` is left alone. A
// key glued to more token characters (two keys back to back, `KEY-backup`) is
// replaced to the end of that run, so no part of a second key survives.
//
// Names (secretName, ADR 0040 section 3): a secret word anywhere (PASSWORD, TOKEN,
// SECRET, KEY after a non-data word, AUTH, and PASS, PWD or SALT last) makes a
// secret, unless the last word is metadata (TOKEN_COUNT, KEY_FILE; SECRET_ID stays
// a secret). A bare `key` or `auth` is one only with a random-looking value.

const TOK = 'A-Za-z0-9_-';
const NOT_BEFORE = `(?<![${TOK}])`;
const REST = `[${TOK}]*`;
const PASS_WORDS = ['PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL'];
const GLUED = /^(?:API|ACCESS|PRIVATE|SECRET|SESSION|REFRESH|CLIENT|MASTER|SIGNING|ENCRYPTION)KEY$/;
const DATA_KEYS = new Set(['PRIMARY', 'FOREIGN', 'SORT', 'PARTITION', 'CACHE', 'HASH', 'RANGE', 'ROUTING', 'LOOKUP',
  'UNIQUE', 'SHARD', 'IDEMPOTENCY', 'DEDUP', 'GROUP', 'INDEX']);
const META = new Set(['COUNT', 'LEN', 'LENGTH', 'SIZE', 'LIMIT', 'TYPE', 'NAME', 'FILE', 'PATH', 'URL', 'TTL', 'EXPIRY',
  'MAX', 'MIN', 'ID']);
// Every secret name contains one of these, so it is a cheap gate before the split.
const NAME_GATE = /KEY|TOKEN|SECRET|PASS|PWD|CRED|AUTH|SALT/i;

function secretName(name) {
  if (!NAME_GATE.test(name)) return false;
  const words = name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).map((s) => s.toUpperCase().replace(/\d+$/, '')).filter(Boolean);
  const last = words[words.length - 1];
  if (!last || (META.has(last) && !(last === 'ID' && words[words.length - 2] === 'SECRET'))) return false;
  if (last === 'SALT' || ((last === 'PASS' || last === 'PWD') && words.length > 1)) return true;
  return words.some((w, i) => PASS_WORDS.some((p) => w.includes(p)) || /(?:TOKEN|SECRET)$/.test(w) || GLUED.test(w) ||
    (w === 'KEY' && i > 0 && !DATA_KEYS.has(words[i - 1])) || (w === 'AUTH' && words.length > 1));
}

const looseName = (name) => /^(?:key|auth)$/i.test(name);
// A value that looks generated: 10 or more token characters with letters and digits.
const randomish = (v) => /^[A-Za-z0-9_+\/=.-]{10,}$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v);
const marker = (kind) => `[REDACTED:${kind}]`;
const isMarker = (v) => /^\[REDACTED:[a-z_]+\]$/.test(v);

// A pattern rule: `gate` is a cheap substring test that skips the regex scan, and
// `accept` (optional) can refuse a match that only looks like a key.
function simple(kind, re, gate, accept) {
  const apply = (text, hit) => text.replace(re, (m) => (accept && !accept(m) ? m : (hit(), marker(kind))));
  return { kind, gate, apply };
}

// The first match of a global regex at or after i. Queries move forward, and each
// search starts past the last one's result, so all of them together scan once.
function seeker(text, re) {
  let pos = -1;
  return (i) => {
    if (pos < i) { re.lastIndex = i; const m = re.exec(text); pos = m ? m.index : text.length; }
    return pos;
  };
}

// `<private>`, `< private >`, `<private reason="x">` and the closing tags.
const PRIVATE_TAG = '<\\s*(\\/?)\\s*private(?:\\s[^<>\\n]{0,200})?>';

const RULES = [
  {
    kind: 'private',
    gate: (t) => /<\s*private/i.test(t),
    apply(text, hit) {
      // One pass counts nesting, so time stays linear; an unclosed span runs to the
      // end. A removal can join two halves of a tag, so rescan a few times to settle.
      let out = text;
      for (let pass = 0; pass < 8 && new RegExp(PRIVATE_TAG, 'i').test(out); pass++) {
        const re = new RegExp(PRIVATE_TAG, 'gi');
        let depth = 0, start = 0, last = 0, res = '', m;
        while ((m = re.exec(out)) !== null) {
          if (!m[1]) {
            if (depth === 0) start = m.index;
            depth++;
          } else if (depth > 0 && --depth === 0) {
            res += out.slice(last, start);
            last = m.index + m[0].length;
            hit();
          }
        }
        if (depth > 0) { res += out.slice(last, start); last = out.length; hit(); }
        out = res + out.slice(last);
      }
      return out;
    },
  },
  simple('anthropic_key', new RegExp(`${NOT_BEFORE}sk-` + `ant-[${TOK}]{20,}`, 'g'), (t) => t.includes('sk-' + 'ant-')),
  // A bare `sk-` followed by lowercase words joined by dashes is a kebab-case name,
  // such as a CSS class `sk-folding-cube-container`, not a key.
  simple('openai_key', new RegExp(`${NOT_BEFORE}sk-(?:proj-)?[${TOK}]{20,}`, 'g'), (t) => t.includes('sk-'),
    (m) => m.startsWith('sk-proj-') || !/^sk-[a-z]+(?:-[a-z]+)+$/.test(m)),
  simple('github_token', new RegExp(`${NOT_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_` + `pat_[A-Za-z0-9_]{20,})${REST}`, 'g'),
    (t) => t.includes('gh')),
  simple('aws_access_key', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, (t) => t.includes('AKIA') || t.includes('ASIA')),
  simple('google_api_key', new RegExp(`${NOT_BEFORE}AIza[0-9A-Za-z_-]{35}${REST}`, 'g'), (t) => t.includes('AIza')),
  simple('npm_token', new RegExp(`${NOT_BEFORE}npm_[A-Za-z0-9]{36}${REST}`, 'g'), (t) => t.includes('npm_')),
  simple('slack_token', new RegExp(`${NOT_BEFORE}xox[abprs]-[A-Za-z0-9-]{20,}${REST}`, 'g'), (t) => t.includes('xox')),
  simple('jwt', new RegExp(`${NOT_BEFORE}eyJ[${TOK}]{5,}\\.[${TOK}]*\\.[${TOK}]{5,}(?:\\.[${TOK}]+){0,2}`, 'g'), (t) => t.includes('eyJ')),
  {
    kind: 'pem_private_key',
    gate: (t) => t.includes('-----BEGIN '),
    apply(text, hit) {
      // Once an END search fails no later BEGIN has an END either, so the first
      // unmatched BEGIN redacts to the end of the text and the scan stops (linear).
      const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
      const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
      let out = '', last = 0, m;
      while ((m = begin.exec(text)) !== null) {
        end.lastIndex = m.index + m[0].length;
        const e = end.exec(text);
        out += text.slice(last, m.index) + marker('pem_private_key');
        hit();
        if (!e) return out;
        last = e.index + e[0].length;
        begin.lastIndex = last;
      }
      return out + text.slice(last);
    },
  },
  {
    kind: 'bearer',
    gate: (t) => /bearer/i.test(t),
    // After an Authorization header, in any quoting, any token of 8 or more. A bare
    // `Bearer x` only when x looks like a token: 16 or more characters and a digit.
    apply: (text, hit) => text.replace(
      /(Authorization["']?[ \t]*[:=][ \t]*["']?[ \t]*)?(\bBearer[ \t]+)([A-Za-z0-9._~+\/=-]{8,})/gi,
      (all, header, head, token) => {
        if (!header && (token.length < 16 || !/\d/.test(token))) return all;
        hit();
        return (header || '') + head + marker('bearer');
      }),
  },
  {
    kind: 'url_credentials',
    gate: (t) => t.includes('://'),
    apply(text, hit) {
      // The credentials run from `scheme://` to the last @ before the path, so a
      // password may hold / ? # or @. A user part holding / ? # means the @ is in
      // the path, and so does an @ right after a / (`host:443/@scope/pkg`).
      const scheme = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\//g;
      const runEnd = seeker(text, /[\s"'<>`]/g);
      const nextAt = seeker(text, /@/g);
      const nextSlash = seeker(text, /\//g);
      const done = marker('url_credentials');
      let memoLimit = -1, memoAt = -1, out = '', last = 0, m;
      while ((m = scheme.exec(text)) !== null) {
        const s = m.index + m[0].length;
        const end = runEnd(s);
        const a = nextAt(s);
        if (a >= end) continue;
        const limit = Math.min(nextSlash(a), end);
        if (limit !== memoLimit) { memoLimit = limit; memoAt = text.lastIndexOf('@', limit - 1); }
        const at = memoAt;
        const colon = text.indexOf(':', s);
        if (colon === -1 || colon > at) continue;
        if (at - s === done.length && text.startsWith(done, s)) continue;
        if (/[\/?#]/.test(text.slice(s, colon)) || text[at - 1] === '/') continue;
        out += text.slice(last, s) + done;
        hit();
        last = at;
        scheme.lastIndex = at;
      }
      return out + text.slice(last);
    },
  },
  {
    kind: 'env_secret',
    gate: (t) => NAME_GATE.test(t),
    apply: (text, hit) => xmlSecrets(assignments(text, hit), hit),
  },
];

// --- env_secret: a value given to a secret name ----------------------------------

const WS = ' \t\u00a0\u3000';
const ws = (ch) => ch !== undefined && ch !== '' && WS.includes(ch);
const eol = (ch) => ch === undefined || ch === '\n' || ch === '\r';
const quoteChar = (ch) => ch === '"' || ch === "'" || ch === '`';

// A head is `name =`, `name :` (also fullwidth), or `name ` before a space-separated
// value. The name may be quoted, escape-quoted (`\"name\"`) or a subscript
// (`["name"]`). The value is parsed by hand from the end of a secret head.
const HEAD = /(?<![A-Za-z0-9_.])(\\?["']|)([A-Za-z_][A-Za-z0-9_.-]*)\1(\]?)(?:[ \t\u00a0\u3000]*([=:\uff1d\uff1a])|(?=[ \t\u00a0\u3000]))/g;
const SCALAR = /[|>][+-]?\d?[+-]?[ \t]*(?:\r?\n|\r?$)/y;
const KEYWORDS = new Set(['True', 'False', 'None', 'null', 'NULL', 'true', 'false', 'undefined', 'nil', 'yes', 'no', 'on', 'off']);
const REFERENCE = /^\$(?:\{\{[^}\n]*\}\}|\{[^}\n]*\}|\([^)\n]*\)|[A-Z_][A-Z0-9_]*)$/;
const CODE_SHAPES = /^(?:lambda\b[^:\n]*:|new [A-Z][\w.]*\(|(?:async )?function\b[^(\n]*\(|typeof \w)/;
const CHAIN = /^(?:await )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\]|\((?:[^()\n]|\([^()\n]*\))*\))*/;
const CONDITIONAL = /^\S+ if \S.*? else [\w$.()[\]"']+/;
const ROOTS = new Set(['self', 'this', 'cls', 'process', 'os', 'config', 'settings', 'env', 'req', 'request', 'opts',
  'options', 'props', 'ctx', 'args', 'params', 'form', 'secrets', 'vars', 'inputs']);
const TYPES = new Set(['str', 'string', 'String', 'bytes', 'int', 'float', 'number', 'bool', 'boolean', 'any', 'unknown',
  'object', 'Optional', 'SecretStr']);
// An identifier that looks generated (upper, lower and a digit) is a value, not a name.
const opaque = (s) => (s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '').match(/[A-Za-z_$][\w$]*/g) || [])
  .some((id) => /[A-Z]/.test(id) && /[a-z]/.test(id) && /\d/.test(id));

// Code that only names a secret ('code', or 'type' after a colon); v is the value,
// rest its line. A keyword or a reference (${X}, ${{ x }}, $(cmd), $VAR) counts only
// as the whole value; a dotenv line (literal) has no other code. Elsewhere code is an
// expression spanning the value with no generated-looking name in it: a closed
// bracket of names, a conditional, or a chain with a call, subscript or known root.
function codeKind(v, rest, colon, literal) {
  const whole = v.replace(/[\s;,]+$/, '');
  if (KEYWORDS.has(whole) || REFERENCE.test(whole)) return 'code';
  if (literal || v.startsWith('[REDACTED:')) return null;
  if (CODE_SHAPES.test(rest)) return 'code';
  const w = /^[A-Za-z_$][\w$]*/.exec(rest);
  if (colon && w && TYPES.has(w[0])) {
    const t = /^(?:\[[^\]\n]*\])?((?:[ \t]*\|[ \t]*[\w.]+)*)(?:[\s,;)}\]=]|$)/.exec(rest.slice(w[0].length));
    const parts = t ? t[1].split('|').map((p) => p.trim()).filter(Boolean) : null;
    if (parts && parts.every((p) => TYPES.has(p) || KEYWORDS.has(p))) return 'type';
  }
  let len = 0;
  const close = { '{': '}', '[': ']', '(': ')', '<': '>' }[rest[0]];
  if (close) {
    const i = rest.indexOf(close);
    if (i > 0 && /^[\w$.,\s'"]*$/.test(rest.slice(1, i))) len = i + 1;
  } else {
    const c = CONDITIONAL.exec(rest) || CHAIN.exec(rest);
    if (c && (/[(\[ ]/.test(c[0]) || (ROOTS.has(w[0]) && c[0].includes('.')))) len = c[0].length;
  }
  if (len && len >= whole.length && !/[^\s;,)\]}]/.test(rest[len] || '') && !opaque(rest.slice(0, len))) return 'code';
  return null;
}

// An f-string or template whose literal text is short (`f"u:{id}"`) is code.
const interpolated = (s) => s.includes('{') && (s.replace(/\$?\{[^}\n]*\}/g, '').match(/[A-Za-z0-9]/g) || []).length < 6;

// Where the head sits: at a line start (block, also after `export` or a YAML dash),
// after `{ , [` (flow), right after an opening quote (a header inside a string, such
// as "x-api-key: v"), after `--` (a flag), or after fish's `set -x`.
function context(text, lineStart, at, quote) {
  let p = at - 1;
  while (p >= lineStart && ws(text[p])) p--;
  const ctx = { block: p < lineStart, flow: false, str: null, flag: false, fish: false };
  if (p < lineStart) return ctx;
  const c = text[p];
  if (c === '-' && p + 1 < at && (p === lineStart || ws(text[p - 1]))) ctx.block = true;
  else if (c === '-' && p + 1 === at && text[p - 1] === '-') ctx.flag = true;
  else if ('{,['.includes(c)) ctx.flow = true;
  else if (!quote && p + 1 === at && (c === '"' || c === "'")) ctx.str = c;
  else if (p - 5 >= lineStart && text.startsWith('export', p - 5)) {
    let q = p - 6;
    while (q >= lineStart && ws(text[q])) q--;
    ctx.block = q < lineStart;
  }
  if (!ctx.block) ctx.fish = /(?:^|[\s;])set(?:[ \t]+-[A-Za-z]+)+[ \t]+$/.test(text.slice(Math.max(lineStart, at - 40), at));
  return ctx;
}

// A quoted value at i (the opening quote, optionally escaped). Returns the span to
// replace and its replacement, keeping the quotes, or null for an empty value.
function quotedValue(text, i) {
  const esc = text[i] === '\\';
  const q = text[esc ? i + 1 : i];
  const open = esc ? '\\' + q : q;
  const from = i + open.length;
  let j = from, closed = false;
  for (; j < text.length && !eol(text[j]); j++) {
    if (esc) { if (text.startsWith(open, j)) { closed = true; break; } continue; }
    if (text[j] === '\\' && q !== "'") { j++; continue; }
    if (text[j] === q && q === "'" && text[j + 1] === "'") { j++; continue; }
    if (text[j] === q) { closed = true; break; }
  }
  j = Math.min(j, text.length);
  const inner = text.slice(from, j);
  // `"abc"tail`: the run glued to the closing quote belongs to the value.
  const glued = closed ? j + open.length : j;
  let tail = glued;
  while (closed && tail < text.length && !/[\s,;:}\])\\]/.test(text[tail])) tail++;
  if (inner === '' || (isMarker(inner) && tail === glued) || REFERENCE.test(inner)) return null;
  if (q === '`' && interpolated(inner)) return null;
  return { start: i, end: tail, rep: open + marker('env_secret') + (closed ? open : '') };
}

// An unquoted value from v0 to its end (`stop` says where), unless it is code.
function bareValue(text, v0, stop, colon, literal) {
  // A leading marker is atomic (its `]` ends no flow value). Code is judged on a
  // bounded prefix, so a skipped value is never scanned to its end (linear).
  const done = /\[REDACTED:[a-z_]+\]/y;
  done.lastIndex = v0;
  let e = done.test(text) ? done.lastIndex : v0;
  while (e < text.length && e < v0 + 200 && !stop(text[e])) e++;
  let r = v0;
  while (r < v0 + 200 && !eol(text[r])) r++;
  const code = codeKind(text.slice(v0, e), text.slice(v0, r), colon, literal);
  if (code === 'code') return null;
  while (e < text.length && !stop(text[e])) e++;
  let core = text.slice(v0, e).trimEnd();
  if (colon) while (core.endsWith(',')) core = core.slice(0, -1).trimEnd();
  if (!core || isMarker(core)) return null;
  if (code === 'type') {
    // `token: str = "v"`: the annotation is code, the value after it is not.
    const m = /^[^=\n]*?[ \t]*=(?![=>])[ \t]*/.exec(core);
    if (!m) return null;
    return valueAt(text, v0 + m[0].length, { stop: (ch) => eol(ch) || /[\s,;)]/.test(ch), colon: false });
  }
  return { start: v0, end: v0 + core.length, rep: marker('env_secret') };
}

function valueAt(text, v0, mode) {
  const c = text[v0];
  if (eol(c)) return null;
  if (quoteChar(c) || (c === '\\' && (text[v0 + 1] === '"' || text[v0 + 1] === "'"))) return quotedValue(text, v0);
  // An f-string that interpolates is code; any other prefixed string is a value.
  if (/[fFrRbBuU]/.test(c) && quoteChar(text[v0 + 1])) {
    const v = quotedValue(text, v0 + 1);
    if (!v || (/[fF]/.test(c) && interpolated(text.slice(v0 + 2, v.end)))) return null;
    return v;
  }
  return bareValue(text, v0, mode.stop, mode.colon, mode.literal);
}

// `name:` with nothing after it on the line, or a YAML block scalar (`|`, `>`): the
// value is on the following, deeper-indented lines (YAML, pretty-printed JSON). A
// nested mapping or list there is not a value.
function nextLineValue(text, lineStart, v0, scalar) {
  let keyIndent = 0;
  while (ws(text[lineStart + keyIndent])) keyIndent++;
  const nl = text.indexOf('\n', v0);
  const indentEnd = (s) => { let j = s; while (ws(text[j])) j++; return j; };
  const first = indentEnd(nl + 1);
  if (nl === -1 || eol(text[first]) || first - (nl + 1) <= keyIndent) return null;
  if (scalar) {
    let end = first;
    for (let s = nl + 1; s < text.length;) {
      const j = indentEnd(s);
      let e = text.indexOf('\n', s);
      if (e === -1) e = text.length;
      if (!eol(text[j])) {
        if (j - s <= keyIndent) break;
        end = text[e - 1] === '\r' ? e - 1 : e;
      }
      s = e + 1;
    }
    if (isMarker(text.slice(first, end))) return null;
    return { start: first, end, rep: marker('env_secret') };
  }
  if (/^(?:["']?[\w.-]+["']?[ \t]*:(?:[ \t]|\r?\n|\r?$)|[-{[])/.test(text.slice(first, first + 200))) return null;
  return valueAt(text, first, { stop: eol, colon: true });
}

// Heads are found from the gate words, not by trying the head at every word: from
// a hit, walk back to the start of its name run and match the head there (first at
// its opening quote, if any). Runs are disjoint, so this is linear.
const nameChar = (ch) => ch !== undefined && /[A-Za-z0-9_.-]/.test(ch);
function nextHead(text, gate, head, floor) {
  let g;
  while ((g = gate.exec(text)) !== null) {
    let s = g.index;
    while (s > floor && nameChar(text[s - 1])) s--;
    while (s < g.index && !/[A-Za-z_]/.test(text[s])) s++;
    let e = g.index;
    while (nameChar(text[e])) e++;
    gate.lastIndex = e;
    let q = s > floor && (text[s - 1] === '"' || text[s - 1] === "'") ? s - 1 : s;
    if (q < s && q > floor && text[q - 1] === '\\') q--;
    for (const at of q < s ? [q, s] : [s]) {
      head.lastIndex = at;
      const m = head.exec(text);
      if (m) { gate.lastIndex = Math.max(e, at + m[0].length); return m; }
    }
  }
  return null;
}

function assignments(text, hit) {
  const gate = new RegExp(NAME_GATE.source, 'gi');
  const head = new RegExp(HEAD.source, 'y');
  let out = '', last = 0, lineStart = 0, nextNl = text.indexOf('\n'), m;
  while ((m = nextHead(text, gate, head, last)) !== null) {
    const strict = secretName(m[2]);
    if (!strict && !looseName(m[2])) continue;
    const quote = m[1], sep = m[4];
    if (m[3] && !(quote && text[m.index - 1] === '[')) continue;
    while (nextNl !== -1 && nextNl < m.index) { lineStart = nextNl + 1; nextNl = text.indexOf('\n', lineStart); }
    const ctx = context(text, lineStart, m.index, quote);
    const after = m.index + m[0].length;
    let v0 = after;
    while (ws(text[v0])) v0++;
    const colon = sep === ':' || sep === '\uff1a';
    let v = null, shout = false;
    if (sep === undefined) {
      // Space-separated: a flag, fish's `set -x`, or a quoted value (SQL's PASSWORD 'v').
      const quoted = quoteChar(text[v0]) || text[v0] === '\\';
      if (ctx.flag || ctx.fish || quoted) v = valueAt(text, v0, { stop: (ch) => eol(ch) || /[\s;)`]/.test(ch), colon: false });
    } else if (colon) {
      // Mid-line, only an env-shaped name (SECRET_KEY_BASE: v) is an assignment.
      shout = !quote && !(ctx.block || ctx.flow || ctx.str) && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(m[2]);
      if (!quote && !(ctx.block || ctx.flow || ctx.str || shout)) continue;
      if (!quote && ctx.block && !ws(text[after]) && !eol(text[after])) continue;
      SCALAR.lastIndex = v0;
      const scalar = SCALAR.test(text);
      if (scalar || eol(text[v0])) v = nextLineValue(text, lineStart, v0, scalar);
      else if (ctx.str) v = valueAt(text, v0, { stop: (ch) => eol(ch) || ch === ctx.str, colon: false });
      else if (ctx.block) v = valueAt(text, v0, { stop: eol, colon: true });
      else v = valueAt(text, v0, { stop: (ch) => eol(ch) || (shout ? /[\s,;]/.test(ch) : ',}]'.includes(ch)), colon: true });
    } else if (text[after] !== '=' && text[after] !== '>') {
      // `==` and `=>` are code, not assignments.
      const stop = ctx.block ? eol : ctx.str ? (ch) => eol(ch) || ch === ctx.str : (ch) => eol(ch) || /[\s&"',;)`]/.test(ch);
      // A dotenv line (`NAME=value` at a line start, no spaces) holds a literal.
      const literal = ctx.block && !quote && !/\s/.test(m[0]) && !ws(text[after]);
      v = valueAt(text, v0, { stop, colon: false, literal });
    }
    if (!v) continue;
    // A bare `key` or `auth` is a secret only when its value looks generated.
    if ((!strict || (shout && !quoteChar(text[v.start]))) && !randomish(text.slice(v.start, v.end).replace(/^\\?["'`]|\\?["'`]$/g, ''))) continue;
    out += text.slice(last, v.start) + v.rep;
    hit();
    last = v.end;
    gate.lastIndex = v.end;
  }
  return out + text.slice(last);
}

// `<password>v</password>`: an element named like a secret loses its content.
function xmlSecrets(text, hit) {
  if (!text.includes('</')) return text;
  return text.replace(/<([A-Za-z_][\w.-]*)>([^<\n]*)<\/\1>/g, (all, name, inner) => {
    if (!secretName(name) || !inner.trim() || isMarker(inner.trim())) return all;
    hit();
    return `<${name}>${marker('env_secret')}</${name}>`;
  });
}

const KINDS = Object.freeze(RULES.map((r) => r.kind));

function redact(text) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const redactions = {};
  let out = text;
  // A key glued after a key of another kind (an AWS key then a GitHub token) hides
  // behind the token boundary until the first is replaced, so rescan while a token
  // rule changed the text (bounded).
  for (let pass = 0; pass < 6; pass++) {
    let chained = false;
    for (const rule of RULES) {
      if (!rule.gate(out)) continue;
      out = rule.apply(out, () => {
        redactions[rule.kind] = (redactions[rule.kind] || 0) + 1;
        if (rule.kind !== 'private' && rule.kind !== 'env_secret') chained = true;
      });
    }
    if (!chained) break;
  }
  return { text: out, redactions };
}

// Strings anywhere inside plain objects and arrays are redacted, and a string under
// a secret-named key (secretName, an Authorization header, or a bare key or auth
// holding a random-looking value) is replaced whole, since the key is its context.
// The walk is iterative, so depth costs no stack; a cycle is refused with E_ARGS.
const secretKey = (key, v) => secretName(key) || /^(?:proxy-)?authorization$/i.test(key) || (looseName(key) && randomish(v));

function redactDeep(value) {
  const redactions = {};
  const count = (kind, n) => { redactions[kind] = (redactions[kind] || 0) + n; };
  const leaf = (v, key) => {
    if (typeof v !== 'string') return v;
    if (key !== undefined && v !== '' && !isMarker(v) && secretKey(key, v)) { count('env_secret', 1); return marker('env_secret'); }
    const r = redact(v);
    for (const [k, n] of Object.entries(r.redactions)) count(k, n);
    return r.text;
  };
  // Only plain objects and arrays are walked; a Date, Map or Buffer passes through.
  const walked = (v) => Array.isArray(v) || (v !== null && typeof v === 'object' &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
  const stack = [];
  const open = new Set();
  const enter = (src) => {
    if (open.has(src)) throw Object.assign(new TypeError('redactDeep: the value contains a cycle'), { code: 'E_ARGS' });
    open.add(src);
    const dst = Array.isArray(src) ? new Array(src.length) : {};
    stack.push({ src, dst, keys: Object.keys(src), i: 0 });
    return dst;
  };
  if (!walked(value)) return { value: leaf(value), redactions };
  const root = enter(value);
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.i === f.keys.length) { open.delete(f.src); stack.pop(); continue; }
    const k = f.keys[f.i++];
    const v = f.src[k];
    // defineProperty keeps an own `__proto__` key as data instead of a prototype.
    Object.defineProperty(f.dst, k, { value: walked(v) ? enter(v) : leaf(v, k), enumerable: true, writable: true, configurable: true });
  }
  return { value: root, redactions };
}

module.exports = { redact, redactDeep, KINDS };
