'use strict';
// cmd-init.cjs — CLI slice 3a, mode W. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit, always returning the
// receipt that proves what happened (invariant 5). The acceptance criterion is
// tests/cli/slice-3a.test.cjs, written before this file and not edited to make it pass.
//
// command table §3: writes one config file, creates the data dir; the receipt is the absolute path,
// the bytes, and the parsed config echoed back. Invariant 5 is why `bytes` is read back off disk
// with `stat` after the write rather than taken from what was handed to `writeFileSync`: the receipt
// states what is there, not what was intended.
//
// It never silently overwrites. An existing config is left byte for byte as it was and the receipt
// says `created: false`, because the operator's config is the one thing in this directory that
// belay did not put there.

const fs = require('node:fs');
const path = require('node:path');

const C = require('./config.cjs');

// What a fresh config says. Only `data_dir`, because the other keys default to null meaning "use the
// launch table", and writing nulls into a new file would teach the operator that belay needs to be
// told where its binaries are when it does not.
function seedConfig(dataDirOverride, writeDir) {
  if (!dataDirOverride) return { data_dir: C.KEYS.data_dir.default };
  // An override the config could name (inside the repository once symlinks and junctions are resolved, and not the root itself)
  // is written relative to the config file, so the file stays portable. Any other is not written: a repository's config may only
  // name a data_dir inside the repository, so the file keeps the default and --data names the store on each command.
  const refused = C.dataDirRefusal(dataDirOverride, { path: writeDir + '/' + C.CONFIG_NAME, dir: writeDir });
  const rel = path.relative(writeDir, dataDirOverride).split(path.sep).join('/');
  return refused ? { data_dir: C.KEYS.data_dir.default, outside: refused } : { data_dir: rel };
}

async function run(ctx) {
  if (ctx.argv.length) {
    const message = `unknown argument ${ctx.argv[0]}`;
    return {
      code: 2,
      text: `belay init: ${message}\n\nusage: belay init [--data <dir>] [--json]\n`,
      json: { error: message },
    };
  }

  const writeDir = C.writeDirOf(ctx.cwd);
  const configPath = `${writeDir}/${C.CONFIG_NAME}`;
  // Discovery never reads a config file in the home directory, so a file written there is dead.
  // Refuse before any write, as `belay settings` does.
  if (!C.discover(writeDir).searched.includes(configPath)) {
    const message = `refusing to write ${configPath}: discovery would never read a config file there (the home directory)`;
    return { code: 1, text: `belay init: ${message}
`, json: { error: message, created: false } };
  }
  const override = C.overrideOf(ctx);
  const existed = fs.existsSync(configPath);

  let created = false;
  let outsideNote = null;
  if (!existed) {
    const seed = seedConfig(override, writeDir);
    if (seed.outside) outsideNote = `--data ${override} cannot be the config's data_dir (${seed.outside}), so the config keeps data_dir ${JSON.stringify(seed.data_dir)}; pass --data ${override} on each command that should use it`;
    delete seed.outside;
    const body = JSON.stringify(seed, null, 2) + '\n';
    // `wx` rather than a bare write: between the check above and this line another process may have
    // created the file, and losing someone's config to that race is exactly what this refuses to do.
    try {
      fs.writeFileSync(configPath, body, { encoding: 'utf8', flag: 'wx' });
      created = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  // Read back what is on disk, whether this call wrote it or found it. The receipt describes the
  // file that exists now.
  const found = C.discover(writeDir);
  const bytes = fs.statSync(configPath).size;
  const dataDir = C.dataDirOf(found, ctx);

  const dataDirExisted = fs.existsSync(dataDir);
  if (!dataDirExisted) fs.mkdirSync(dataDir, { recursive: true });

  const payload = {
    path: configPath,
    bytes,
    created,
    config: found.config,
    parse_error: found.parse_error || null,
    data_dir: dataDir,
    data_dir_created: !dataDirExisted,
    ...(outsideNote ? { note: outsideNote } : {}),
  };

  if (ctx.json) return { code: 0, text: '', json: payload };

  const lines = [
    created
      ? `wrote ${configPath} (${bytes} bytes)`
      : `kept ${configPath} (${bytes} bytes); it already existed and was not touched`,
    payload.data_dir_created ? `created ${dataDir}` : `data dir already present at ${dataDir}`,
  ];
  if (found.parse_error) lines.push(`warning: ${found.parse_error}`);
  if (outsideNote) lines.push(`note: ${outsideNote}`);
  lines.push('');
  return { code: 0, text: lines.join('\n'), json: payload };
}

module.exports = { run };
