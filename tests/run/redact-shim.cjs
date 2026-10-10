'use strict';
// redact-shim.cjs: makes `require('../core/redact.cjs')` answer in a checkout where that module has not landed
// yet. When src/core/redact.cjs exists the real one is used and this does nothing. The stand-in has the real
// signature, redact(text) -> { text, redactions }, and replaces `sk-ant-...` keys with the real marker.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REAL = path.join(__dirname, '..', '..', 'src', 'core', 'redact.cjs');

// A key the real redactor and this stand-in both recognise (prefix plus 30 token characters).
const SECRET = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(3);

function install() {
  if (fs.existsSync(REAL)) return 'real';
  const orig = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    if (typeof request === 'string' && request.endsWith('core/redact.cjs')) return REAL;
    return orig.call(this, request, ...rest);
  };
  const m = new Module(REAL);
  m.filename = REAL;
  m.loaded = true;
  m.exports = {
    redact(text) {
      let n = 0;
      const out = String(text).replace(/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, () => { n += 1; return '[REDACTED:anthropic_key]'; });
      return { text: out, redactions: n ? [{ kind: 'anthropic_key', count: n }] : [] };
    },
  };
  require.cache[REAL] = m;
  return 'shim';
}

module.exports = { install, SECRET };
