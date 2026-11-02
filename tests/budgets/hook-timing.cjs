'use strict';
// hook-timing.cjs — a receipt script, not a gated test (its name is not *.test.cjs, so `npm test` does not run it). It measures
// what the PreToolUse guard hooks add to one Bash call: the hook process's wall time with the payload on stdin, in the shape of
// tests/cli/budget.cjs (an empty script spawned the same way is the floor, interleaved round by round, min of n).
// Three configurations: `before-parallel` is the two hook processes of ADR 0024 amendment 7 and ADR 0084 started together (Claude
// Code runs the hooks of one event in parallel), `before-sequential` the same two one after the other, `after` the one guard hook.
// The two "before" hooks are the old files kept under tests/fixtures/hooks-before.
// Usage: node tests/budgets/hook-timing.cjs [out.json] [n]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { emptyScript } = require('../cli/budget.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BEFORE = ['kill-hook.cjs', 'tmp-hook.cjs'].map((f) => path.join(ROOT, 'tests', 'fixtures', 'hooks-before', f));
const AFTER = path.join(ROOT, 'src', 'run', 'guard-hook.cjs');
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short && ls src/run | head -5' } });

function runOnce(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 && out === '' ? resolve() : reject(new Error(`${script} exited ${code}, stdout ${JSON.stringify(out)}`))));
    child.stdin.end(PAYLOAD);
  });
}
async function timed(fn) { const t0 = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t0) / 1e6; }

async function main() {
  const out = process.argv[2] || null;
  const n = Number(process.argv[3]) || 15;
  const floorScript = emptyScript();
  const configs = {
    floor: () => runOnce(floorScript),
    'before-parallel': () => Promise.all(BEFORE.map(runOnce)),
    'before-sequential': async () => { for (const s of BEFORE) await runOnce(s); },
    after: () => runOnce(AFTER),
  };
  const samples = Object.fromEntries(Object.keys(configs).map((k) => [k, []]));
  for (let i = 0; i < n; i += 1) for (const [k, fn] of Object.entries(configs)) samples[k].push(await timed(fn));
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], median: s[Math.floor(s.length / 2)] }; };
  const floorMin = Math.min(...samples.floor);
  const result = { n, node: process.version, platform: process.platform, command_payload_bytes: Buffer.byteLength(PAYLOAD), rounds: {} };
  for (const [k, a] of Object.entries(samples)) result.rounds[k] = { ...stat(a), over_floor_ms: Math.min(...a) - floorMin, samples: a.map((x) => Math.round(x * 10) / 10) };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json);
}
main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
