'use strict';
// tool-policy.cjs — ADR 0054 decision 4: the built-in tools a worker of each agent type may have. A type's list is a
// ceiling and a default: a spawn of that type gets the list, and the spawn's `allowed_tools` may narrow it, never widen
// it. The operator sets a type's list in the config's agents block (`agents.<type>.tools`); the orchestrator chooses
// only the type and the narrowing. Web tools (WebFetch, WebSearch) exist only through a list that names them, and the
// built-in list gives them to the researcher alone, without Bash: a researcher in a live run reached the web through Bash
// with spoofed headers, and a researcher with the web tools and no shell has no reason to.
//
// Pure: it requires nothing, so `belay settings` and the adapter's argv check can load it on a read path (invariant 9).
// Not yet called by RunManager.spawn: the integration step is named in ADR 0054 (it lands on the spawn path that
// fix/spawn-tools changes, so it waits for that merge).

const SIX = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']; // ADR 0024 decision 1; surface.cjs CLAUDE_TOOLS (a test pins the two equal)
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const POLICY_TOOLS = [...SIX, ...WEB_TOOLS]; // canonical order of every list this module returns
const READ_ONLY = ['Read', 'Glob', 'Grep'];

// The built-in policy, per worker type. A spawn with no agent_type gets the six, as before this record.
const BUILTIN = Object.freeze({
  coder: Object.freeze([...SIX]),
  tester: Object.freeze([...SIX]),
  reviewer: Object.freeze([...SIX]), // keeps Write: on this host a probe script goes to disk, not through a Bash heredoc (ADR 0024 decision 1)
  researcher: Object.freeze([...READ_ONLY, ...WEB_TOOLS]),
});

const canonical = (list) => POLICY_TOOLS.filter((t) => list.includes(t));

// A list as the config or a caller states it: a non-empty array of known names with no repeats. Returns { value } in
// canonical order, or { error } naming what is wrong. Never throws, so a config check can report it.
function checkList(list, label = 'tools') {
  if (!Array.isArray(list) || list.length === 0) return { error: `${label} must be a non-empty array of tool names` };
  const bad = list.filter((t) => typeof t !== 'string' || !POLICY_TOOLS.includes(t));
  if (bad.length) return { error: `${label} names ${bad.map((t) => JSON.stringify(t)).join(', ')}; the known tools are ${POLICY_TOOLS.join(', ')}` };
  if (new Set(list).size !== list.length) return { error: `${label} repeats a tool` };
  return { value: canonical(list) };
}

// The ceiling for a type and where it came from. `defaults` is agent-defaults.cjs's { types, path } (or null).
function forType(defaults, agentType) {
  if (agentType === null || agentType === undefined) return { tools: [...SIX], source: 'default (no agent_type)' };
  const set = defaults && defaults.types && defaults.types[agentType] && defaults.types[agentType].tools;
  if (Array.isArray(set)) return { tools: canonical(set), source: `${defaults.path} agents.${agentType}.tools` };
  if (BUILTIN[agentType]) return { tools: [...BUILTIN[agentType]], source: `built-in policy for ${agentType}` };
  return { tools: [...SIX], source: 'default' };
}

// What a spawn gets: the type's ceiling, narrowed by the built-in and web names in `allowed_tools`. `mcp__*` names in
// `allowed_tools` are pre-approval only and never narrow; a list of nothing else is refused. Returns { tools, source, preapprove }:
// `tools` the --tools list (canonical order), `preapprove` the web tools to add to --allowedTools (in `auto` mode a web
// tool is otherwise judged per call). Throws E_ARGS, before anything is written, for a name the policy does not know or a
// built-in outside the type's ceiling, naming the type, its list and the source of that list.
function resolve(defaults, { agent_type = null, allowed_tools = null } = {}) {
  const ceiling = forType(defaults, agent_type);
  let tools = ceiling.tools;
  if (allowed_tools !== null && allowed_tools !== undefined) {
    if (!Array.isArray(allowed_tools) || allowed_tools.some((t) => typeof t !== 'string')) throw fail('allowed_tools must be an array of strings', { allowed_tools });
    const named = allowed_tools.filter((t) => !t.startsWith('mcp__'));
    const unknown = named.filter((t) => !POLICY_TOOLS.includes(t));
    if (unknown.length) throw fail(`allowed_tools names ${unknown.join(', ')}, which no worker can have; the known tools are ${POLICY_TOOLS.join(', ')}, plus mcp__* names`, { allowed_tools, refused: unknown });
    const outside = named.filter((t) => !ceiling.tools.includes(t));
    if (outside.length) throw fail(`allowed_tools names ${outside.join(', ')}, outside the ${agent_type || 'default'} list ${ceiling.tools.join(', ')} (${ceiling.source}); a spawn may narrow its type's tools, never widen them`, { allowed_tools, refused: outside, agent_type, ceiling: ceiling.tools, source: ceiling.source });
    // As fix/spawn-tools refuses it: a list with no tool at all would be the empty surface, which has no live receipt.
    if (!named.length) throw fail(`allowed_tools names no tool of the ${agent_type || 'default'} list ${ceiling.tools.join(', ')}; name at least one, or omit allowed_tools for the whole list`, { allowed_tools, agent_type, ceiling: ceiling.tools });
    tools = canonical(named);
  }
  return { tools, source: ceiling.source, preapprove: tools.filter((t) => WEB_TOOLS.includes(t)) };
}

function fail(message, detail) {
  return Object.assign(new Error(message), { code: 'E_ARGS', detail });
}

module.exports = { SIX, WEB_TOOLS, POLICY_TOOLS, READ_ONLY, BUILTIN, checkList, forType, resolve };
