'use strict';
// The body of a task's first message: `Task: <spec>`, then the orchestrator's `prompt` as added instructions. belay sends the
// spec itself, at a spawn (manager.cjs) and at a task_assign (mcp/compose.cjs), so the orchestrator never repeats it.
function body(spec, prompt) {
  const s = typeof spec === 'string' && spec.trim() ? `Task: ${spec}` : '';
  const p = typeof prompt === 'string' && prompt.trim() ? prompt : '';
  return s && p ? `${s}\n\n${p}` : s || p;
}
// The one standing line every worker's first message carries (a spawn and a fresh restart, which start a new session; a resume, a park-resume and a task_assign to a running worker do not repeat it).
const PROCESS_LINE = '\n\nOther processes on this machine are not yours: stop a process only by its exact pid. Your TEMP is a folder belay made for you: put scratch files there, never in /tmp or C:\\tmp.';
// A worker whose built-in tools were narrowed at spawn (by its agent type or by the spawn's allowed_tools) is told what it has and why,
// so it does not guess ("the Bash tool was disabled"). A worker with all six, or a harness job, gets nothing added.
function toolsLine(w) {
  if (!w || !Array.isArray(w.tools) || w.tools.length === 0) return '';
  // toolsBy is known to the manager that made the spawn; a worker adopted from its row has not got it, and then no source is claimed.
  const why = w.toolsBy === 'spawn' ? 'by the spawn that started you' : w.toolsBy === 'type' && w.agentType ? `by your agent type (${w.agentType})` : 'when you were spawned';
  return `
Your built-in tools are ${w.tools.join(', ')}, set ${why}. You cannot add one; if the task needs a tool you lack, say so in your hand-back.`;
}
module.exports = { body, PROCESS_LINE, toolsLine };
