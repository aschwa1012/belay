'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// The pipe names (the owner's, the worker adapter's, a bind's) come from the directory's real path, so a junction or an 8.3 short
// spelling of the data dir reaches the same pipe as the long one. Tests that need a junction or short names skip with the reason
// when this host cannot make them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeName, adapterPipeName, bindPipeName } = require('../../src/core/lock.cjs');
const { Owner } = require('../../src/core/owner.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ping } = require('../../src/core/ping.cjs');
const { sandbox, cleanup, callerFor } = require('./helpers.cjs');

// A second spelling of `real`, or a reason it cannot be made.
function junctionTo(real, t) {
  const holder = sandbox();
  t.after(() => cleanup(holder));
  const link = path.join(holder, 'link').replace(/\\/g, '/');
  try { fs.symlinkSync(real, link, 'junction'); } catch (e) { return { skip: `cannot make a junction here: ${e.code || e.message}` }; }
  return { link };
}

// The sandbox may already sit under an 8.3 TEMP, so the long spelling to compare with is the real path, and the short one is made
// from a long-named directory made here (its name is over eight characters, so a volume with 8.3 names gives it an alias).
function shortSpelling(dir) {
  if (process.platform !== 'win32') return { skip: 'no 8.3 names off Windows' };
  const long = path.join(dir, 'a-long-directory-name-for-an-alias');
  fs.mkdirSync(long, { recursive: true });
  if (/[\s"&^%()]/.test(long)) return { skip: 'the sandbox path has characters the cmd lookup cannot take unquoted' };
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `for %I in (${long}) do @echo %~sI`], { encoding: 'utf8' });
  const short = r.status === 0 ? String(r.stdout).trim().replace(/\\/g, '/') : '';
  if (!short || short.toLowerCase() === fs.realpathSync.native(long).replace(/\\/g, '/').toLowerCase()) return { skip: 'this volume has no 8.3 short name for a long directory name' };
  return { short, long };
}

test('a junction to the data dir names the same pipes as the real path, even for a dir not made yet', async (t) => {
  const real = sandbox();
  t.after(() => cleanup(real));
  const j = junctionTo(real, t);
  if (j.skip) return t.skip(j.skip);
  assert.equal(pipeName(j.link), pipeName(real));
  assert.equal(adapterPipeName(j.link, 4242), adapterPipeName(real, 4242));
  assert.equal(bindPipeName(j.link, 'n1'), bindPipeName(real, 'n1'));
  assert.equal(pipeName(`${j.link}/.belay`), pipeName(`${real}/.belay`), 'a data dir below the junction that does not exist yet');
});

test('a Core and a ping that spell the data dir through a junction reach the live owner', async (t) => {
  const real = sandbox();
  const owner = new Owner(real, { embed: false });
  await owner.start();
  t.after(async () => { try { await owner.stop(); } catch { /* stopped */ } cleanup(real); });
  const j = junctionTo(real, t);
  if (j.skip) return t.skip(j.skip);
  assert.equal((await ping(j.link, 1000)).ok, true);
  const c = await openCore({ dataDir: j.link, caller: callerFor('orchestrator', { run_id: 'r-junction' }), embed: false });
  t.after(async () => { try { await c.close(); } catch { /* closed */ } });
  const made = await c.task.create({ spec: 'through a junction' });
  assert.ok(made.id);
  assert.equal(owner.pipe, pipeName(j.link));
});

test('an 8.3 short spelling of the data dir names the same pipes as the long one', async (t) => {
  const real = sandbox();
  t.after(() => cleanup(real));
  const s = shortSpelling(real);
  if (s.skip) return t.skip(s.skip);
  assert.equal(pipeName(s.short), pipeName(s.long));
  assert.equal(adapterPipeName(s.short, 7), adapterPipeName(s.long, 7));
});
