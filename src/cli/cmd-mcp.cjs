'use strict';
// cmd-mcp.cjs — CLI slice 3a, mode R. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit, always returning the
// receipt that proves what happened (invariant 5). The acceptance criterion is
// tests/cli/slice-3a.test.cjs, written before this file and not edited to make it pass.
//
// command table §3: `mcp status` reads the registry and the adapter wire log and reports
// catalogued / registered / configured / reachable / healthy **separately**. That word is the whole
// command. The failure to avoid is one green word standing in for five different facts, four of
// which were never checked, so each fact here carries its own verdict and its own
// evidence naming what established it, and a fact nobody established says `unknown` rather than
// borrowing a neighbour's answer.
//
// `reachable` is the one fact that cannot be had from a file: it means a process started and
// answered. That costs a spawn, so it is opt-in behind `--deep`, exactly as command table §2 puts
// the ~500 ms `claude agents --json` probe behind the same flag to keep plain `status` inside its
// budget. Without `--deep` this command spawns nothing and creates nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const C = require('./config.cjs');

const YES = 'yes';
const NO = 'no';
const UNKNOWN = 'unknown';

const FACTS = ['catalogued', 'registered', 'configured', 'reachable', 'healthy'];
const DEEP_MS = 5000;

const fact = (verdict, evidence, extra = {}) => ({ verdict, evidence, ...extra });

function readJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'not found' : e.message }; }
}

// Does this server entry point at the adapter this belay ships? Matched on the adapter path inside
// the argv rather than on the server's name, because a name is what the operator typed and the path
// is what will actually run (invariant 3: identity comes from process arguments).
function namesAdapter(entry, adapterPath) {
  if (!entry || typeof entry !== 'object') return false;
  const argv = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  const want = adapterPath.toLowerCase();
  const base = path.basename(adapterPath).toLowerCase();
  return argv.some((a) => {
    if (typeof a !== 'string') return false;
    const s = a.split('\\').join('/').toLowerCase();
    return s === want || s.endsWith(`/${base}`);
  });
}

function scanServers(servers, adapterPath, where) {
  const hits = [];
  if (!servers || typeof servers !== 'object') return hits;
  for (const [name, entry] of Object.entries(servers)) {
    if (namesAdapter(entry, adapterPath)) hits.push({ name, where, command: entry.command, args: entry.args });
  }
  return hits;
}

// Claude Code's own registry. Top-level `mcpServers` is the user scope; `projects[<dir>].mcpServers`
// is what it recorded per project. Both are searched and the answer says which one matched.
function registryFacts(adapterPath) {
  const file = C.fwd(path.join(os.homedir(), '.claude.json'));
  const r = readJson(file);
  if (!r.ok) {
    return fact(UNKNOWN, `the Claude Code registry at ${file} could not be read: ${r.error}`, { registry: file });
  }
  const hits = [
    ...scanServers(r.value.mcpServers, adapterPath, 'user scope'),
    ...Object.entries(r.value.projects || {}).flatMap(([dir, p]) =>
      scanServers(p && p.mcpServers, adapterPath, `project ${C.fwd(dir)}`)),
  ];
  const scopes = Object.keys(r.value.projects || {}).length + 1;
  return hits.length
    ? fact(YES, `${file} names this adapter as ${hits.map((h) => `${h.name} (${h.where})`).join(', ')}`, { registry: file, entries: hits })
    : fact(NO, `${file} parsed, ${scopes} scope(s) searched, and no server in it runs ${adapterPath}`, { registry: file, entries: [] });
}

// The project's own .mcp.json, which is what an orchestrating session in this directory would load.
function projectFacts(adapterPath, cwd, found) {
  const dir = found.found ? found.dir : C.writeDirOf(cwd);
  const file = `${dir}/.mcp.json`;
  const r = readJson(file);
  if (!r.ok) {
    return r.error === 'not found'
      ? fact(NO, `no .mcp.json at ${file}, so a session opened here would not attach belay`, { file })
      : fact(UNKNOWN, `${file} could not be read: ${r.error}`, { file });
  }
  const hits = scanServers(r.value.mcpServers, adapterPath, file);
  const names = Object.keys(r.value.mcpServers || {});
  return hits.length
    ? fact(YES, `${file} attaches this adapter as ${hits.map((h) => h.name).join(', ')}`, { file, entries: hits })
    : fact(NO, `${file} names ${names.length ? names.join(', ') : 'no server'}, none of which runs ${adapterPath}`, { file, entries: [] });
}

// ADR 0001 §8: the adapter's wire log showing `tools/list` is the evidence that it served a client.
// The logs live per worker under the data dir, and `--log` is optional, so absence is `unknown` and
// names where it looked rather than claiming the adapter is unwell.
function wireLogFacts(dataDir) {
  const L = require('../run/launch.cjs');
  const workers = `${dataDir}/workers`;
  let ids = [];
  try { ids = fs.readdirSync(workers); } catch {
    return fact(UNKNOWN, `no wire log to read: ${workers} does not exist, and --log is optional for a Claude Code adapter`, { searched: workers });
  }
  const seen = [];
  for (const id of ids) {
    const p = L.wireLogPath(`${workers}/${id}`);
    if (!fs.existsSync(p)) continue;
    const r = L.wireLogHasToolsList(p, 0, 256 * 1024); // the current file starts at a launch; tools/list is early in it
    seen.push({ worker_id: id, log: p, seen: r.seen, count: r.count || 0 });
  }
  if (!seen.length) {
    return fact(UNKNOWN, `${ids.length} worker director(ies) under ${workers} and none holds an adapter.log`, { searched: workers });
  }
  const good = seen.filter((s) => s.seen);
  return good.length
    ? fact(YES, `tools/list appears in ${good.length} of ${seen.length} adapter wire log(s), earliest ${good[0].log}`, { logs: seen })
    : fact(NO, `${seen.length} adapter wire log(s) exist and none shows tools/list`, { logs: seen });
}

// One bounded initialize over stdio, the way a client does it. The adapter is started with the real
// data dir on purpose: initialize and tools/list provably create nothing there
// (tests/mcp/protocol.test.cjs), so this stays mode R for the filesystem even while it spends a
// process. Killed by its exact pid, never by matching a command line.
function probe(adapterPath, dataDir) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [adapterPath, '--role', 'orchestrator', '--run', `cli-mcp-status-${process.pid}`, '--data', dataDir, '--no-embed'];
    let child;
    try {
      child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, reason: `the adapter could not be spawned: ${e.message}`, ms: Date.now() - t0 });
      return;
    }

    let buf = '';
    let stderr = '';
    let done = false;
    const seen = new Map();

    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Closing stdin is how a stdio server is asked to stop; the kill is the backstop, by exact
      // pid and never by matching a command line (ADR 0011 §2). The adapter has no children of its
      // own on this path (its process snapshot waits for notifications/initialized, which this probe
      // never sends), so there is no subtree to take with it.
      try { child.stdin.end(); } catch { /* already closed */ }
      // ADR 0039: only while the handle proves the pid is still the adapter this call spawned.
      try { if (child.pid && child.exitCode === null && child.signalCode === null) require('../core/process.cjs').killPid(child, 'SIGTERM'); } catch { /* already gone */ }
      resolve({ ...out, ms: Date.now() - t0, pid: child.pid, stderr_tail: stderr.slice(-400) });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: `no answer within ${DEEP_MS} ms` }), DEEP_MS);

    child.on('error', (e) => finish({ ok: false, reason: `the adapter failed to start: ${e.message}` }));
    child.on('exit', (code) => finish({ ok: false, reason: `the adapter exited with code ${code} before answering` }));
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === undefined) continue;
        seen.set(m.id, m);
        if (m.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        } else if (m.id === 2) {
          const init = seen.get(1);
          finish({
            ok: true,
            server: init && init.result && init.result.serverInfo,
            protocol: init && init.result && init.result.protocolVersion,
            tools: (m.result && m.result.tools) ? m.result.tools.length : 0,
            tool_names: (m.result && m.result.tools) ? m.result.tools.map((t) => t.name) : [],
          });
        }
      }
    });

    child.stdin.on('error', () => { /* the exit handler reports it */ });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'belay-cli', version: '0' } },
    })}\n`);
  });
}

async function status(ctx) {
  const L = require('../run/launch.cjs');
  const adapter = L.mcpServerPath();
  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);
  const deep = ctx.argv.includes('--deep');

  const st = (() => { try { return fs.statSync(adapter); } catch { return null; } })();
  const out = {
    catalogued: st
      ? fact(YES, `the adapter this belay ships is at ${adapter}, ${st.size} bytes`, { path: adapter, bytes: st.size })
      : fact(NO, `no adapter at ${adapter}; this is a broken installation`, { path: adapter }),
    registered: registryFacts(adapter),
    configured: projectFacts(adapter, ctx.cwd, found),
    reachable: fact(UNKNOWN, 'not probed: establishing this costs one process, so it is behind --deep', { how: 'belay mcp status --deep' }),
    healthy: wireLogFacts(dataDir),
  };

  if (deep) {
    const p = await probe(adapter, dataDir);
    out.reachable = p.ok
      ? fact(YES, `${p.server && p.server.name} ${p.server && p.server.version} answered initialize and listed ${p.tools} tools in ${p.ms} ms over stdio`, { ms: p.ms, pid: p.pid, protocol: p.protocol, tools: p.tools })
      : fact(NO, `the adapter did not answer: ${p.reason}`, { ms: p.ms, pid: p.pid, stderr_tail: p.stderr_tail });
    // A live tools/list outranks a wire log written by some earlier process.
    if (p.ok) {
      out.healthy = fact(YES, `tools/list answered with ${p.tools} tools in this probe: ${p.tool_names.slice(0, 3).join(', ')}…`, { tools: p.tools, established_by: 'live probe' });
    }
  }

  const payload = {
    ...out,
    adapter,
    data_dir: dataDir,
    mode: deep ? 'read-only, one process spawned' : 'read-only, no process spawned',
  };

  if (ctx.json) return { code: 0, text: '', json: payload };

  const width = Math.max(...FACTS.map((f) => f.length));
  const lines = [
    `adapter: ${adapter}`,
    `store:   ${dataDir}`,
    '',
    ...FACTS.map((f) => `  ${out[f].verdict.padEnd(7)} ${f.padEnd(width)}  ${out[f].evidence}`),
    '',
    deep ? '' : 'reachable is unknown until you ask: belay mcp status --deep',
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
  return { code: 0, text: lines.join('\n'), json: payload };
}

async function run(ctx) {
  const [sub] = ctx.argv;
  if (sub === 'status') return status(ctx);
  const message = sub === undefined ? 'mcp needs a subcommand' : `unknown subcommand ${sub}`;
  return {
    code: 2,
    text: `belay mcp: ${message}\n\nusage: belay mcp status [--deep] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

module.exports = { run, FACTS };
