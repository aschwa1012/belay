'use strict';
// launch-spec.cjs — the executable and argument list one launch of a worker runs. Split out of the manager so a restart can build the
// exact Codex command line, and check its length, before it stops the live process (the relaunch builds the same line).

const L = require('./launch.cjs');

// `exeFor(substrate)` names the configured executable. Pure: it writes nothing and starts nothing.
// `viaStdin` (Codex only): the prompt is not put in argv; it comes back as the spec's non-enumerable `stdinText`, which argv.json does not
// record (the receipt says `prompt_via: 'stdin'` and its length instead).
function buildSpec(w, exeFor, { resume = null, prompt = null, viaStdin = false } = {}) {
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
    args = L.codexResumeArgv({ threadId: resume, adapterArgs: w.adapterArgs, prompt, model: w.model, scratchDir: w.scratchDir, effort: w.effort, promptViaStdin: viaStdin });
  } else {
    args = L.codexLaunchArgv({
      worktree: w.worktree, adapterArgs: w.adapterArgs, prompt, sandbox: w.sandbox, model: w.model, scratchDir: w.scratchDir, effort: w.effort, promptViaStdin: viaStdin,
    });
  }
  const { command, prefixArgs } = L.resolveExe(exeFor(w.substrate));
  const spec = { exe: command, args: [...prefixArgs, ...args], cwd: w.worktree };
  if (viaStdin && w.substrate === 'codex') {
    spec.prompt_via = 'stdin'; spec.prompt_chars = String(prompt).length;
    Object.defineProperty(spec, 'stdinText', { value: String(prompt), enumerable: false });
  }
  return spec;
}

// A Codex prompt that does not fit the command line goes on stdin (`codex exec -`); what is still too long is refused by `checkLine`
// (argv-limit.cjs), which throws E_ARGS { reason: 'argv_too_long' }. Claude Code is never checked here.
function buildChecked(w, exeFor, opts, checkLine) {
  const spec = buildSpec(w, exeFor, opts);
  if (w.substrate !== 'codex') return spec;
  try { checkLine(spec); return spec; } catch (e) {
    if (!(e && e.detail && e.detail.reason === 'argv_too_long') || typeof opts.prompt !== 'string') throw e;
    const via = buildSpec(w, exeFor, { ...opts, viaStdin: true });
    checkLine(via);
    return via;
  }
}

module.exports = { buildSpec, buildChecked };
