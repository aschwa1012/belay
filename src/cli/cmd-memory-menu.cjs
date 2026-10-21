'use strict';
// cmd-memory-menu.cjs — `belay memory menu`: the facts the panel's Memory menu draws (src/core/memory-menu.cjs). Mode R: it reads the config
// file, the model cache (a stat) and the probe's last reading, and counts each heavy embedder's backlog from a COPY of the store (invariant 6).
// It starts no process and creates no file. It loads no GPU module, no rerank provider and no embedding library (invariant 9).

const AD = require('../run/agent-defaults.cjs'); // pure data: the agent types belay defines

function text(m) {
  const g = m.gpu;
  const lines = [g.state === 'probed' ? `GPU: ${g.device || 'unknown'}, ${g.free_mb === null ? '?' : g.free_mb} MiB free of ${g.total_mb === null ? '?' : g.total_mb} (probed ${g.at || '?'}${g.ok ? '' : `, refused: ${g.reason || 'unknown'}`})` : 'GPU: not probed (belay embedder probe)'];
  lines.push(`GPU runtime: ${g.runtime.ok ? 'installed' : g.runtime.installed ? 'installed but wrong' : `not installed (${g.runtime.command})`}`);
  lines.push(`profile ${m.levers.profile} (GPU) / ${m.levers.profile_cpu} (CPU only); selected embedder ${m.selected_embedder}, ${m.behind} note${m.behind === 1 ? '' : 's'} behind${m.backlog_reason ? ` (${m.backlog_reason})` : ''}`);
  for (const r of m.models) lines.push(`  ${r.state === 'ready' ? 'ready   ' : 'download'} ${r.kind.padEnd(8)} ${r.device === 'gpu' ? `${r.vram_mb} MiB (${r.vram_source})` : 'cpu'}  ${r.label}${r.in_use ? '  [in use]' : ''}${r.backlog !== null ? `  backlog ${r.backlog}` : ''}`);
  lines.push(`disk used by models: ${m.disk.bytes} bytes in ${m.disk.models} model${m.disk.models === 1 ? '' : 's'} (${m.cache_root})`);
  return `${lines.join('\n')}\n`;
}

async function run(ctx, found, dataDir) {
  const m = await require('../core/memory-menu.cjs').menu({ found, dataDir, agentTypes: AD.AGENT_KEYS });
  return { code: 0, text: text(m), json: m };
}

module.exports = { run, text };
