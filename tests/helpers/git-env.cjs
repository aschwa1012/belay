'use strict';
// tests/helpers/git-env.cjs — makes every git a test (or the product code under test) starts independent of the machine it runs on.
// A developer's global git config can turn commit signing on with a program that is missing, set hooks, or rewrite line endings, and
// a GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE inherited from a hook or an outer git redirects every fixture at the wrong repository.
// Requiring this file sets the process environment, which every child inherits: the user-level config points at a private empty
// file that only turns signing off, and the variables that select a repository or inject config are removed. The system config is
// left as it is, because tests that read it (core.autocrlf, core.fscache) skip or follow it. Idempotent; a test that needs a global
// config of its own sets GIT_CONFIG_GLOBAL after requiring this.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// tmp.cjs first: it makes the spawn register this file's config is kept in, and requires this file back (a no-op for the cycle).
require('./tmp.cjs');

const KEY = Symbol.for('belay.tests.git-env');
if (!globalThis[KEY]) {
  const STRIP = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_SYSTEM|AUTHOR_\w+|COMMITTER_\w+|EXTERNAL_DIFF|SSH_COMMAND|ASKPASS|SEQUENCE_EDITOR|EDITOR)$/i;
  for (const k of Object.keys(process.env)) if (STRIP.test(k)) delete process.env[k];

  // Inside the process's spawn register when there is one (the runner removes that tree even after a kill), else in a directory of its own.
  // Only a register tmp.cjs made (it records it as `<pid>|<path>` in BELAY_TEST_SPAWN_REGISTRY_MADE_BY); an explicit one, an operator's
  // real register, never gets a file of ours. If the register cannot be used (ENOTDIR, a missing parent), the own directory is used.
  let reg = process.env.BELAY_SPAWN_REGISTRY;
  const madeBy = (process.env.BELAY_TEST_SPAWN_REGISTRY_MADE_BY || '').split('|');
  if (!reg || madeBy[1] !== reg) reg = null;
  if (reg) { try { fs.mkdirSync(reg, { recursive: true }); } catch { reg = null; } }
  const dir = reg ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitcfg-'));
  const file = path.join(reg || dir, 'gitconfig');
  fs.writeFileSync(file, '[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[gc]\n\tauto = 0\n');
  process.env.GIT_CONFIG_GLOBAL = file.split(path.sep).join('/');
  process.on('exit', () => { try { fs.rmSync(dir || file, { recursive: true, force: true }); } catch { /* left for the suite guard */ } });
  globalThis[KEY] = { file };
}
module.exports = globalThis[KEY];
