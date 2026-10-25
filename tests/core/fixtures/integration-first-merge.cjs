'use strict';
// integration-first-merge.cjs — times the first integration.merge in a fresh process (ADR 0053 amendment 2): a throwaway
// repository and data dir under the sandbox given, one done task. Prints one line of JSON.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = process.argv[2];

const { openCore } = require(path.join(ROOT, 'src/core/index.cjs'));
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
(async () => {
  const base = fs.mkdtempSync(path.join(SANDBOX, 'first-merge-')).split(path.sep).join('/');
  const repo = `${base}/repo`; fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(`${repo}/keep.txt`, 'k\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const top = git(repo, 'rev-parse', '--show-toplevel');
  const orch = await openCore({ dataDir: `${base}/data`, caller: { role: 'orchestrator', run_id: 'r', pid: process.pid }, embed: false });
  const op = await openCore({ dataDir: `${base}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [{ argv: [process.execPath, '-e', "require('fs').accessSync('a.txt')"] }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo: top, junction: [] })).worktree;
  fs.writeFileSync(`${w.path}/a.txt`, 'a\n'); git(w.path, 'add', '-A'); git(w.path, 'commit', '-q', '-m', 'a');
  await orch.task.evaluate({ task_id: t.id });
  const t0 = process.hrtime.bigint();
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/receipt', evaluate: false });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const receipt = { at: new Date().toISOString(), node: process.version, pid: process.pid, merge_ms: Math.round(ms), state: row.state, owner_boot: row.owner_boot };
  console.log(JSON.stringify(receipt));
  await op.close(); await orch.shutdownOwner(); await orch.close();
})().catch((e) => { console.error(e); process.exit(1); });
