'use strict';
// Redaction for memory writes (proposed ADR 0040, section 3). A pure function:
// no I/O, requires nothing. Every memory write passes through it before it is
// hashed or embedded, so a secret never reaches the store.
//
// Keys need a realistic length (a prefix plus at least 20 token characters) and
// a non-token character on both sides, so prose such as `task-sk-1` or
// `risk-assessment` is left alone.
//
// Env-style names: KEY, TOKEN, SECRET, PASSWORD, PASSWD and CREDENTIAL match
// anywhere in the name (APIKEY, GITHUB_TOKEN). AUTH matches only as a whole
// segment (AUTH_TOKEN, GITHUB_AUTH), so AUTHOR=Jane is not redacted.

const TOK = 'A-Za-z0-9_-';
const NOT_BEFORE = `(?<![${TOK}])`;
const NOT_AFTER = `(?![${TOK}])`;

const SECRET_NAME_PARTS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL'];

function secretName(name) {
  const upper = name.toUpperCase();
  if (SECRET_NAME_PARTS.some((p) => upper.includes(p))) return true;
  return upper.split(/[^A-Z0-9]+/).includes('AUTH');
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
      const sub = () => { hit(); return ''; };
      return text.replace(/<private>[\s\S]*?<\/private>/gi, sub).replace(/<private>[\s\S]*$/i, sub);
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
  simple('jwt', new RegExp(`${NOT_BEFORE}eyJ[${TOK}]{5,}\.[${TOK}]{5,}\.[${TOK}]{5,}${NOT_AFTER}`, 'g'), (t) => t.includes('eyJ')),
  simple('pem_private_key',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, (t) => t.includes('-----BEGIN ')),
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
      /((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/)(?!\[REDACTED:url_credentials\]@)(?:\[REDACTED:[a-z_]+\]|[^\s:@\/]+):[^\s@\/]+@/g,
      (_, head) => { hit(); return head + marker('url_credentials') + '@'; }),
  },
  {
    kind: 'env_secret',
    gate: (t) => t.includes('=') || t.includes(':'),
    apply(text, hit) {
      const value = (v) => !/^(["']?)\[REDACTED:[a-z_]+\]\1$/.test(v);
      const swap = (v) => {
        hit();
        const q = v[0] === '"' || v[0] === "'" ? v[0] : '';
        return q + marker('env_secret') + q;
      };
      // An unquoted value runs to the end of the line. trimEnd (not a regex) keeps
      // the trailing-whitespace cut linear; `comma` also drops a JSON/YAML comma.
      const sub = (head, name, sep, v, comma) => {
        if (!secretName(name)) return null;
        let core = v;
        if (v[0] !== '"' && v[0] !== "'") {
          core = v.trimEnd();
          while (comma && core.endsWith(',')) core = core.slice(0, -1).trimEnd();
        }
        if (!core || !value(core)) return null;
        return head + name + sep + swap(core) + v.slice(core.length);
      };
      return text
        .replace(/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)(=)("[^"\n]+"|'[^'\n]+'|[^\s"'][^\n]*)/gm,
          (m, head, name, sep, v) => sub(head, name, sep, v, false) ?? m)
        .replace(/(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1([ \t]*:[ \t]*)("[^"\n]+"|'[^'\n]+'|[^\s,}\]"'][^\n]*)/g,
          (m, q, name, sep, v) => sub(q, name + q, sep, v, true) ?? m);
    },
  },
];

const KINDS = Object.freeze(RULES.map((r) => r.kind));

function redact(text) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const redactions = {};
  let out = text;
  for (const rule of RULES) {
    if (!rule.gate(out)) continue;
    out = rule.apply(out, () => { redactions[rule.kind] = (redactions[rule.kind] || 0) + 1; });
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
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return { value: walk(value), redactions };
}

module.exports = { redact, redactDeep, KINDS };
