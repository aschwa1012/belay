'use strict';
// Redaction for memory writes (proposed ADR 0040, section 3). A pure function:
// no I/O, requires nothing. Every memory write passes through it before it is
// hashed or embedded, so a secret never reaches the store.
//
// Keys need a realistic length (a prefix plus at least 20 token characters) and
// a non-token character on both sides, so prose such as `task-sk-1` or
// `risk-assessment` is left alone.
//
// Env-style names: a secret word (KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE,
// CREDENTIAL, AUTH) must be a whole identifier segment, split on separators and
// camelCase (GITHUB_TOKEN, apiKey), or a glued compound such as APIKEY. So
// max_tokens, AUTHOR and monkey are left alone. A colon form needs the look of an
// assignment: a quoted key, a key at the start of a line, or a key after { , or [.

const TOK = 'A-Za-z0-9_-';
const NOT_BEFORE = `(?<![${TOK}])`;
const NOT_AFTER = `(?![${TOK}])`;

const SECRET_WORDS = new Set(['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL', 'CREDENTIALS', 'AUTH']);
const GLUED = /^(?:API|ACCESS|PRIVATE|SECRET|AUTH|SESSION|REFRESH|CLIENT|MASTER|SIGNING|ENCRYPTION)(?:KEY|TOKEN|SECRET)$/;

function secretName(name) {
  return name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((seg) => {
    const u = seg.toUpperCase();
    return SECRET_WORDS.has(u) || GLUED.test(u);
  });
}

const marker = (kind) => `[REDACTED:${kind}]`;

// A pattern rule: `gate` is a cheap substring test that skips the regex scan.
function simple(kind, re, gate) {
  return { kind, gate, apply: (text, hit) => text.replace(re, () => { hit(); return marker(kind); }) };
}

const RULES = [
  {
    kind: 'private',
    gate: (t) => /<private>/i.test(t),
    apply(text, hit) {
      // One pass counts nesting, so time stays linear; an unclosed span runs to the
      // end. A removal can join two halves of a tag, so rescan a few times to settle.
      let out = text;
      for (let pass = 0; pass < 8 && /<private>/i.test(out); pass++) {
        const re = /<(\/?)private>/gi;
        let depth = 0;
        let start = 0;
        let last = 0;
        let res = '';
        let m;
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
  simple('anthropic_key', new RegExp(`${NOT_BEFORE}sk-` + `ant-[${TOK}]{20,}${NOT_AFTER}`, 'g'), (t) => t.includes('sk-' + 'ant-')),
  simple('openai_key', new RegExp(`${NOT_BEFORE}sk-(?:proj-)?[${TOK}]{20,}${NOT_AFTER}`, 'g'), (t) => t.includes('sk-')),
  simple('github_token', new RegExp(`${NOT_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_` + `pat_[A-Za-z0-9_]{20,})${NOT_AFTER}`, 'g'),
    (t) => t.includes('gh') ),
  simple('aws_access_key', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, (t) => t.includes('AKIA') || t.includes('ASIA')),
  simple('google_api_key', new RegExp(`${NOT_BEFORE}AIza[0-9A-Za-z_-]{35}${NOT_AFTER}`, 'g'), (t) => t.includes('AIza')),
  simple('npm_token', new RegExp(`${NOT_BEFORE}npm_[A-Za-z0-9]{36}${NOT_AFTER}`, 'g'), (t) => t.includes('npm_')),
  simple('slack_token', new RegExp(`${NOT_BEFORE}xox[abprs]-[A-Za-z0-9-]{20,}${NOT_AFTER}`, 'g'), (t) => t.includes('xox')),
  simple('jwt', new RegExp(`${NOT_BEFORE}eyJ[${TOK}]{5,}\\.[${TOK}]*\\.[${TOK}]{5,}(?:\\.[${TOK}]+){0,2}${NOT_AFTER}`, 'g'), (t) => t.includes('eyJ')),
  {
    kind: 'pem_private_key',
    gate: (t) => t.includes('-----BEGIN '),
    apply(text, hit) {
      // Once an END search fails no later BEGIN has an END either, so the first
      // unmatched BEGIN redacts to the end of the text and the scan stops (linear).
      const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
      const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
      let out = '';
      let last = 0;
      let m;
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
    apply: (text, hit) => text.replace(/(Authorization[ \t]*:[ \t]*Bearer[ \t]+)[A-Za-z0-9._~+\/=-]{8,}/gi,
      (_, head) => { hit(); return head + marker('bearer'); }),
  },
  {
    kind: 'url_credentials',
    gate: (t) => t.includes('://'),
    apply: (text, hit) => text.replace(
      /((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/)(?!\[REDACTED:url_credentials\]@)(?:\[REDACTED:[a-z_]+\]|[^\s:@\/]*):[^\s\/?#]*@/g,
      (_, head) => { hit(); return head + marker('url_credentials') + '@'; }),
  },
  {
    kind: 'env_secret',
    gate: (t) => t.includes('=') || t.includes(':'),
    apply(text, hit) {
      const isMarker = (v) => /^\[REDACTED:[a-z_]+\]$/.test(v);
      const ws = (ch) => ch === ' ' || ch === '\t';
      // Heads (`name =` or `name :`, optionally quoted) come from one global scan. A
      // non-secret head consumes only itself, so later members of the same line are
      // still checked; the value is parsed by hand from the end of a secret head.
      const head = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*([=:])/g;
      let out = '';
      let last = 0;
      let lineStart = 0;
      let nextNl = text.indexOf('\n');
      let m;
      while ((m = head.exec(text)) !== null) {
        if (!secretName(m[2])) continue;
        const quoted = m[1] !== '';
        const colon = m[3] === ':';
        const after = m.index + m[0].length;
        while (nextNl !== -1 && nextNl < m.index) { lineStart = nextNl + 1; nextNl = text.indexOf('\n', lineStart); }
        // Context: block (line start, optional export, or a YAML dash), flow (after { , [).
        let p = m.index - 1;
        while (p >= lineStart && ws(text[p])) p--;
        let block = p < lineStart || text[p] === '-';
        if (!block && !colon && p - 5 >= lineStart && text.startsWith('export', p - 5)) {
          let q = p - 6;
          while (q >= lineStart && ws(text[q])) q--;
          block = q < lineStart;
        }
        const flow = !block && p >= lineStart && '{,['.includes(text[p]);
        if (colon && !quoted && !(block || flow)) continue;
        if (colon && !quoted && !ws(text[after])) continue;
        let v0 = after;
        while (ws(text[v0])) v0++;
        const c = text[v0];
        if (c === undefined || c === '\n' || c === '\r') continue;
        let end;
        let replacement;
        if (c === '"' || c === "'") {
          let i = v0 + 1;
          let closed = false;
          for (; i < text.length && text[i] !== '\n'; i++) {
            if (text[i] === '\\' && c === '"') { i++; continue; }
            if (text[i] === c) {
              if (c === "'" && text[i + 1] === "'") { i++; continue; }
              closed = true;
              break;
            }
          }
          i = Math.min(i, text.length);
          const inner = text.slice(v0 + 1, i);
          // `"abc"tail`: the run glued to the closing quote belongs to the value.
          let tail = closed ? i + 1 : i;
          while (closed && tail < text.length && !/[\s,;}\]]/.test(text[tail])) tail++;
          if (inner === '' || (isMarker(inner) && tail === (closed ? i + 1 : i))) continue;
          end = tail;
          replacement = c + marker('env_secret') + (closed ? c : '');
        } else {
          if (colon && (c === '{' || c === '[')) continue;
          let e = v0;
          if (block) while (e < text.length && text[e] !== '\n') e++;
          else if (colon) while (e < text.length && !',}]\n'.includes(text[e])) e++;
          else while (e < text.length && !/[\s&"',]/.test(text[e])) e++;
          let core = text.slice(v0, e).trimEnd();
          if (colon) while (core.endsWith(',')) core = core.slice(0, -1).trimEnd();
          if (!core || isMarker(core)) continue;
          end = v0 + core.length;
          replacement = marker('env_secret');
        }
        out += text.slice(last, v0) + replacement;
        hit();
        last = end;
        head.lastIndex = end;
      }
      return out + text.slice(last);
    },
  },
];

const KINDS = Object.freeze(RULES.map((r) => r.kind));

function redact(text) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const redactions = {};
  let out = text;
  // Two keys written back to back hide each other behind the token boundary until
  // the first is replaced, so rescan while a token rule changed the text (bounded).
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

function redactDeep(value) {
  const redactions = {};
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redact(v);
      for (const [k, n] of Object.entries(r.redactions)) redactions[k] = (redactions[k] || 0) + n;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    // Only plain objects are walked; a Date, Map or Buffer passes through unchanged.
    // defineProperty keeps an own `__proto__` key as data instead of a prototype.
    const proto = v && typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
    if (proto === Object.prototype || proto === null) {
      const o = {};
      for (const k of Object.keys(v)) {
        Object.defineProperty(o, k, { value: walk(v[k]), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    return v;
  };
  return { value: walk(value), redactions };
}

module.exports = { redact, redactDeep, KINDS };
