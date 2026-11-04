'use strict';
// version-line.test.cjs — the 0.4.0 line reports 0.4.0-rc.2 everywhere a version is read, so a store it
// stamps is told apart from the 0.3.3 release, and a prerelease string breaks no comparison.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..', '..');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const WANT = '0.4.0-rc.2';

test('every place that reports a version says 0.4.0-rc.2', () => {
  assert.strictEqual(json('package.json').version, WANT);
  const lock = json('package-lock.json');
  assert.strictEqual(lock.version, WANT);
  assert.strictEqual(lock.packages[''].version, WANT);
  assert.strictEqual(json('src', 'mod', '.claude-plugin', 'plugin.json').version, WANT);
  assert.strictEqual(require('../../src/cli/belay.cjs').VERSION, WANT);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'belay-mcp.cjs'), 'utf8'), /SERVER_VERSION = '0\.4\.0-rc\.2'/);
});

test('the store stamp names the rc build, and a prerelease string leaves the schema check alone', () => {
  const { writtenBy, SCHEMA_VERSION, checkSchema } = core('schema-stamp.cjs');
  assert.match(writtenBy(), /^belay@0\.4\.0-rc\.2\+/);
  assert.strictEqual(typeof SCHEMA_VERSION, 'number'); // the schema gate compares integers, never the version string
  assert.strictEqual(typeof checkSchema, 'function');
});
