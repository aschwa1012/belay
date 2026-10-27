'use strict';
// argv-receipt.cjs — a launch's receipt: argv.json beside the worker and the hash of the exact spec it records. Moved verbatim out
// of launch.cjs to keep that file under its line budget; launch.cjs re-exports both.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fwd } = require('./env.cjs');

// argv_hash is sha256 over `JSON.stringify({ exe, args, cwd })` — the exact bytes written to
// argv.json's `spec` field, so a reader can recompute it from that file alone. Key order is fixed
// here rather than taken from the caller's object.
function argvHash(spec) {
  const canonical = { exe: spec.exe, args: spec.args, cwd: spec.cwd };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function writeArgvJson(dir, spec) {
  const argv_hash = argvHash(spec);
  const body = { spec, argv_hash, written_at: Date.now() };
  fs.writeFileSync(fwd(path.join(dir, 'argv.json')), JSON.stringify(body, null, 2) + '\n');
  return argv_hash;
}

module.exports = { argvHash, writeArgvJson };
