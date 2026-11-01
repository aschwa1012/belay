'use strict';
// launch-spec.cjs — the executable and argument list one launch of a worker runs. Split out of the manager so a restart can build the
// exact Codex command line, and check its length, before it stops the live process (the relaunch builds the same line).

const L = require('./launch.cjs');

// `exeFor(substrate)` names the configured executable. Pure: it writes nothing and starts nothing.
function buildSpec(w, exeFor, { resume = null, prompt = null } = {}) {
  let args;
  if (w.substrate === 'claude-code') {
    args = L.claudeLaunchArgv({
      workerId: w.id, mcpJsonPath: w.mcpJsonPath, settingsPath: w.workerSettingsPath,
      model: w.model || L.DEFAULT_CLAUDE_MODEL, allowedTools: w.allowedTools,
      permissionMode: w.permissionMode, resumeSessionId: resume,
      permissionPromptTool: w.permissionPrompt, appendSystemPromptFile: w.instructions && w.instructions.path,
      effort: w.effort, tools: w.tools, maxBudgetUsd: w.maxBudgetUsd, // ADR 0028 decision 2: every launch, fresh or resumed; ADR 0024: a narrowed list too
    });
  } else if (resume) {
    args = L.codexResumeArgv({ threadId: resume, adapterArgs: w.adapterArgs, prompt, model: w.model, scratchDir: w.scratchDir });
  } else {
    args = L.codexLaunchArgv({
      worktree: w.worktree, adapterArgs: w.adapterArgs, prompt, sandbox: w.sandbox, model: w.model, scratchDir: w.scratchDir,
    });
  }
  const { command, prefixArgs } = L.resolveExe(exeFor(w.substrate));
  return { exe: command, args: [...prefixArgs, ...args], cwd: w.worktree };
}

module.exports = { buildSpec };
