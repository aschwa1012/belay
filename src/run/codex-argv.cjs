'use strict';
// codex-argv.cjs — the command lines of a Codex worker's launch and resume. Moved out of launch.cjs (the 500-line rule), which re-exports them.

const { fwd } = require('./env.cjs');
const CS = require('./codex-surface.cjs');

const DEFAULT_CODEX_SANDBOX = 'workspace-write';

// MCP for Codex is configured through -c key=value pairs, not a config file. `args` is a TOML array,
// which is JSON-shaped for a list of strings. WR-5: tools must be pre-approved or every call is
// refused under approval_policy="never".
function codexMcpArgs(adapterArgs, effort = null) {
  const { MCP_SERVER_NAME } = require('./launch.cjs'); // read when called: launch.cjs re-exports this module
  const argsToml = JSON.stringify(adapterArgs.map(fwd));
  return [
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command="${fwd(process.execPath)}"`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${argsToml}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
    ...CS.surfaceArgs(effort), // what belay sets on top of the user's config; see codex-surface.cjs
  ];
}

function codexLaunchArgv(opts) {
  const {
    worktree,
    adapterArgs,
    prompt,
    sandbox = DEFAULT_CODEX_SANDBOX,
    model = null,
    scratchDir = null,
    effort = null,
  } = opts;
  const argv = [
    'exec',
    '--json',
    '-C',
    fwd(worktree),
    '--skip-git-repo-check',
    '-s',
    sandbox,
    ...codexMcpArgs(adapterArgs, effort),
  ];
  if (scratchDir) argv.push('--add-dir', fwd(scratchDir)); // a reviewer's scratch folder lies outside the worktree, the only root workspace-write opens: add that one folder
  if (model) argv.push('-m', model);
  argv.push('--', prompt); // after `--` the text is the prompt: one that starts with `-` is not an option, and `review` or `resume` not a subcommand
  return argv;
}

// ADR 0008 §6: `exec resume` is a strict subset of `exec`. No -C and no -s; the working directory is
// supplied through the spawn's own cwd option. Passing either exits 2 at the parse layer in ~76 ms.
function codexResumeArgv(opts) {
  const { threadId, adapterArgs, prompt, model = null, scratchDir = null, effort = null } = opts;
  const argv = [
    'exec',
    'resume',
    threadId,
    '--json',
    '--skip-git-repo-check',
    ...codexMcpArgs(adapterArgs, effort),
  ];
  // `exec resume` takes no --add-dir, but accepts the same root as a config override. A TOML array of basic strings: JSON.stringify
  // escapes quotes and backslashes, and the path is forward-slashed first, so a space or a quote in it cannot end the string.
  if (scratchDir) argv.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([fwd(scratchDir)])}`);
  if (model) argv.push('-m', model);
  argv.push('--', prompt);
  return argv;
}

module.exports = { DEFAULT_CODEX_SANDBOX, codexMcpArgs, codexLaunchArgv, codexResumeArgv };
