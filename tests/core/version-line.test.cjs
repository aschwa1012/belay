'use strict';
// version-line.test.cjs — every place that reports belay's version agrees with package.json, the store stamp
// carries it, this line is not the 0.3.x release, and a prerelease stamp leaves the schema check alone.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..', '..');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const text = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const WANT = json('package.json').version;

test('the six places that report a version agree with package.json', () => {
  const lock = json('package-lock.json');
  const mcp = /SERVER_VERSION = '([^']+)'/.exec(text('src', 'mcp', 'belay-mcp.cjs'));
  assert.ok(mcp, 'SERVER_VERSION not found in belay-mcp.cjs');
  assert.strictEqual(lock.version, WANT, 'package-lock.json version');
  assert.strictEqual(lock.packages[''].version, WANT, 'package-lock.json packages[""].version');
  assert.strictEqual(json('src', 'mod', '.claude-plugin', 'plugin.json').version, WANT, 'plugin.json');
  assert.strictEqual(require('../../src/cli/belay.cjs').VERSION, WANT, 'belay.cjs VERSION');
  assert.strictEqual(mcp[1], WANT, 'belay-mcp.cjs SERVER_VERSION');
});

test('the store stamp carries the version, and this line is not a 0.3.x release', () => {
  assert.strictEqual(core('schema-stamp.cjs').writtenBy().startsWith(`belay@${WANT}+`), true);
  assert.doesNotMatch(WANT, /^0\.3\./, 'a store this line writes would read as written by a 0.3.x release');
});

test('a store stamped by a prerelease build, at the current schema, passes the schema check', () => {
  const { checkSchema, SCHEMA_VERSION } = core('schema-stamp.cjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('written_by', 'belay@0.4.0-rc.2+abcdef012345');
  try { assert.strictEqual(checkSchema(db, 'memory.db').schema_version, SCHEMA_VERSION); } finally { db.close(); }
});
