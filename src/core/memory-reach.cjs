'use strict';
// memory-reach.cjs — which namespaces a caller may read and write (ADR 0040 §2, worker scope), and the `project`
// alias they are named through (ADR 0041 §5). A read module: every statement is a SELECT, and it requires nothing
// but the error module, so memory.index and memory.corpus can load it on the read path.
//
// The store is machine-wide. Without a reach, a worker of one run could read another run's or another project's
// memory, or plant a row there. A worker reaches its own run's namespace and its run's project, and nothing else;
// the orchestrator and the operator are not restricted (the run manager writes project copies as the orchestrator,
// and the CLI is the operator's window onto every namespace).

const { err } = require('./errors.cjs');
const { checkNamespaces } = require('./memory-note-gate.cjs');

// The run's project name is the `project` column of its run row, which run.attach set from the spec's
// `memory.project`. It is never derived from a folder, a cwd or a git remote. A store copy that predates the column,
// a caller with no run and a run with no project are all "no project", not an error.
// In a notes run the levers' project is the one the run may reach (ADR 0047 amendment of 2026-10-22): a run attached with its project column unset and levers
// naming one reaches that project and no other, so the column's absence opens nothing. The column is never written from the levers.
function projectOf(E, caller) {
  if (!caller || !caller.run_id) return null;
  try {
    const r = E.store.p('SELECT project, memory_levers FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(caller.run_id);
    if (!r) return null;
    if (r.project) return r.project;
    return notesProjectOf(r.memory_levers);
  } catch { return null; }
}
function notesProjectOf(raw) {
  if (raw == null) return null;
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && o.notes === true && typeof o.project === 'string' && o.project ? o.project : null; } catch { return null; }
}
// The project of a notes run (levers on), else null: the only one its worker and orchestrator reach, by read or by write.
function notesProject(E, caller) {
  if (!caller || (caller.role !== 'worker' && caller.role !== 'orchestrator') || caller.channel === 'harness' || !caller.run_id) return null;
  try {
    const r = E.store.p('SELECT memory_levers FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(caller.run_id);
    return r ? notesProjectOf(r.memory_levers) : null;
  } catch { return null; }
}

// One spelling per ROUTED namespace, applied once at the Core boundary (engine.cjs) before any routing or reach check (ADR 0047 amendment of 2026-10-22).
// Only a namespace whose first segment IS one of belay's own routed prefixes or aliases is touched, whatever its spelling ('Project/acme', ' project', 'PROJECT',
// 'project//acme', 'Run/x'): NFKC, control and zero-width characters dropped, backslash to slash, trim, runs of slashes collapsed, edge slashes dropped, the
// prefix lower-cased, and the rest lower-cased for the namespaces belay names itself (their parts are lower-case by construction) but not for run/<id>, whose id
// may have capitals. Every other namespace is returned byte for byte as given, so rows stored under any other spelling stay reachable by that spelling.
// A first segment that is a look-alike of a routed prefix in another script (Cyrillic 'р' for 'p') is refused: it would be a second namespace that reads like a route.
const ROUTED = new Set(['project', 'summary', 'run', 'archive', 'held', 'pending', 'proposal', 'draft', 'nomination']);
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ո': 'n', 'ս': 'u', 'ɡ': 'g', 'ο': 'o', 'ρ': 'p', 'υ': 'u', 'ν': 'v', 'ι': 'i', 'ℓ': 'l', 'ꞵ': 'b', 'һ': 'h', 'ԛ': 'q', 'ᴅ': 'd', 'ꜱ': 's', 'ᴘ': 'p', 'ᴏ': 'o', 'ᴊ': 'j', 'ᴇ': 'e', 'ᴛ': 't', 'ᴍ': 'm', 'ʀ': 'r', 'ɴ': 'n', 'ʜ': 'h', 'ɪ': 'i', 'ᴜ': 'u', 'ᴄ': 'c', 'ᴀ': 'a' };
function normalizeNamespace(ns) {
  if (typeof ns !== 'string') return ns;
  let t = ns.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff]/g, '').split(String.fromCharCode(92)).join('/').trim();
  t = t.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  const i = t.indexOf('/');
  const head = (i < 0 ? t : t.slice(0, i)).trim().toLowerCase();
  if (/[^\u0000-\u007f]/.test(head)) {
    const skeleton = [...head].map((c) => LOOKALIKE[c] || c).join('');
    if (skeleton !== head && ROUTED.has(skeleton)) throw err('E_ARGS', `namespace ${JSON.stringify(ns)} starts with a look-alike of the routed prefix ${skeleton}; write it in plain letters`, { namespace: ns, prefix: skeleton });
  }
  if (!ROUTED.has(head)) return ns; // not a route: byte for byte as given
  if (i < 0) return head;
  const tail = t.slice(i + 1).split('/').map((x) => x.trim()).join('/');
  return head === 'run' ? `run/${tail}` : `${head}/${tail.toLowerCase()}`;
}
// Normalises the namespace-bearing arguments of a memory call in place (a copy of the caller's args).
function normalizeArgs(args) {
  for (const k of ['namespace', 'to']) if (typeof args[k] === 'string') args[k] = normalizeNamespace(args[k]);
  if (Array.isArray(args.namespaces)) args.namespaces = args.namespaces.map(normalizeNamespace);
  if (typeof args.project === 'string') args.project = args.project.normalize('NFKC').trim().toLowerCase();
  return args;
}

// In any namespace argument the literal "project" means `project/<run.project>` when the caller's run has a
// project. With none it stays the literal namespace it has always been, so a run without a project reads and
// writes exactly what it did before.
// The alias `summary` is the orchestrator's alone (ADR 0047 amendment of 2026-10-22): it resolves to `summary/<project>`, where the run's decisions
// and outcomes go. A worker's `summary` stays the literal namespace, which is outside its reach.
function resolveNamespace(E, caller, ns) {
  if (ns !== 'project' && !(ns === 'summary' && caller && caller.role === 'orchestrator')) return ns;
  const p = projectOf(E, caller);
  return p ? `${ns}/${p}` : ns;
}

// A WRITE by the orchestrator on the tool channel (its reads stay unlimited): not another project's notes, and not `summary/` except through the
// alias, which names its own project's. The harness channel is not restricted (the run manager writes summaries and project copies).
function checkOrchestratorWrite(E, caller, ns, named) {
  if (!caller || caller.role !== 'orchestrator' || caller.channel === 'harness' || typeof ns !== 'string') return;
  const p = projectOf(E, caller);
  if (!p) return; // a run with no project has no notes and no alias to hold it to: the literal namespaces it has always had
  if (ns.startsWith('project/') && ns !== `project/${p}`) {
    throw err('E_ROLE', `the orchestrator writes only its own run's project (project/${p}); ${ns} is another`, { namespace: ns, role: caller.role });
  }
  if (ns.startsWith('summary/') && !(named === 'summary' && ns === `summary/${p}`)) {
    throw err('E_ROLE', `the orchestrator writes a run outcome with namespace "summary" (summary/${p}); ${ns} named directly is refused`, { namespace: ns, role: caller.role });
  }
}

// The set of namespaces a caller reaches, or null for no limit.
function reachOf(E, caller) {
  if (!caller || caller.role !== 'worker') return null;
  return new Set([`run/${caller.run_id}`, resolveNamespace(E, caller, 'project')]);
}

// E_ROLE naming the first namespace outside the caller's reach; `verb` says what was attempted.
function checkReach(E, caller, namespaces, verb) {
  if (verb === 'read') checkNamespaces(caller, namespaces); // the lifecycle namespaces are not for a tool-channel caller (memory-note-gate.cjs)
  const mine = notesProject(E, caller);
  if (mine) {
    for (const ns of namespaces) {
      const m = /^(project|summary)\/(.*)$/.exec(String(ns));
      if (m && m[2] !== mine) throw err('E_ROLE', `a notes run reaches only its own project (${mine}); ${m[1]}/${m[2]} is another`, { namespace: ns, role: caller.role });
    }
  }
  const reach = reachOf(E, caller);
  if (!reach) return;
  for (const ns of namespaces) {
    if (!reach.has(ns)) {
      throw err('E_ROLE', `a worker may ${verb} only its own run's namespace and its run's project (${[...reach].join(', ')}); ${ns} is neither`, { namespace: ns, allowed: [...reach], role: caller.role });
    }
  }
}

// The embedder mode of the LIVE run a worker or orchestrator caller belongs to: { live, mode, source }. With the owner's guard (the run's own
// process) the guard's mode is the truth; without it (a copy, a standalone engine) the run row's embedder_mode is (written by run.attach and by
// a resume that switches it), then the row's memory levers, then the default, required. Not live (an operator, no run attached, a run that
// ended, a store without run rows): { live: false, mode: null }.
function runEmbedderMode(E, caller) {
  const none = { live: false, mode: null, source: null };
  if (!caller || (caller.role !== 'worker' && caller.role !== 'orchestrator') || !caller.run_id) return none;
  const EM = require('./embedder-mode.cjs');
  if (E.owner && E.owner.opts && typeof E.owner.opts.embedderMode === 'function') return { live: true, mode: EM.normalize(E.embedderMode()) || EM.DEFAULT_MODE, source: 'guard' };
  let row;
  try { row = E.store.p('SELECT memory_levers, embedder_mode, ended_at FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(caller.run_id); } catch { return none; }
  if (!row || row.ended_at != null) return none;
  let lv = null;
  try { lv = typeof row.memory_levers === 'string' ? JSON.parse(row.memory_levers) : row.memory_levers; } catch { lv = null; }
  return { live: true, mode: EM.normalize(row.embedder_mode) || EM.normalize(lv && lv.on_embedder_failure) || EM.DEFAULT_MODE, source: 'row' };
}

module.exports = { normalizeNamespace, normalizeArgs, runEmbedderMode, projectOf, resolveNamespace, reachOf, checkReach, checkOrchestratorWrite };
