'use strict';
// The body of a task's first message: `Task: <spec>`, then the orchestrator's `prompt` as added instructions. belay sends the
// spec itself, at a spawn (manager.cjs) and at a task_assign (mcp/compose.cjs), so the orchestrator never repeats it.
function body(spec, prompt) {
  const s = typeof spec === 'string' && spec.trim() ? `Task: ${spec}` : '';
  const p = typeof prompt === 'string' && prompt.trim() ? prompt : '';
  return s && p ? `${s}\n\n${p}` : s || p;
}
// The one standing line every worker's first message carries (a spawn and a fresh restart, which start a new session; a resume, a park-resume and a task_assign to a running worker do not repeat it).
const PROCESS_LINE = '\n\nOther processes on this machine are not yours: stop a process only by its exact pid.';
module.exports = { body, PROCESS_LINE };
