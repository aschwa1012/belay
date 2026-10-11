'use strict';
// redact-shim.cjs: a key-shaped sample the real redactor (src/core/redact.cjs) recognises, built at run time so
// the source carries no key-shaped literal, and an `install` kept for the tests that call it. The real module
// is always present now, so `install` only checks that it is.

const fs = require('node:fs');
const path = require('node:path');

const REAL = path.join(__dirname, '..', '..', 'src', 'core', 'redact.cjs');

// The Anthropic key shape: its prefix plus 30 token characters.
const SECRET = 'sk' + '-ant-' + 'api03-' + 'a1B2c3D4e5'.repeat(3);

function install() {
  if (!fs.existsSync(REAL)) throw new Error('src/core/redact.cjs is missing');
  return 'real';
}

module.exports = { install, SECRET };
