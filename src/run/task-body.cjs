'use strict';
// The body of a task's first message: `Task: <spec>`, then the orchestrator's `prompt` as added instructions. belay sends the
// spec itself, at a spawn (manager.cjs) and at a task_assign (mcp/compose.cjs), so the orchestrator never repeats it.
function body(spec, prompt) {
  const s = typeof spec === 'string' && spec.trim() ? `Task: ${spec}` : '';
  const p = typeof prompt === 'string' && prompt.trim() ? prompt : '';
  return s && p ? `${s}\n\n${p}` : s || p;
}
module.exports = { body };
