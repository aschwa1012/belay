'use strict';
// msys-hint.cjs — one bounded line added to an operator-check refusal when Git Bash is the likely cause. An MSYS program that bash starts
// (timeout, env, nohup, xargs, the `#!/bin/sh` shim npm writes for a globally installed command) is created by Cygwin's exec, which gives
// it no Windows parent. The operator check walks the peer's ancestors in Windows' process table, so the chain of a command started
// that way ends at the helper, created after the owner started, and the check refuses it. That refusal is right (belay cannot prove the
// command came from the operator) and stays; this says why, and what runs the command with a parent Windows can see.

const fs = require('node:fs');
const path = require('node:path');

const HELPERS = ['sh', 'bash', 'env', 'timeout', 'nohup', 'xargs', 'dash', 'zsh', 'busybox'];
const HELPER_IMAGE = new RegExp(`(?:^|[^\\w.-])(?:${HELPERS.join('|')})\\.exe\\b`, 'i');

// The CLI file a user can hand to `node`: the one beside this module's own tree, when it is there.
function cliPath() {
  const p = path.resolve(__dirname, '..', 'cli', 'belay.cjs');
  try { return fs.existsSync(p) ? p.split(path.sep).join('/') : null; } catch { return null; }
}

// -> the line, or null when neither the refusal's text names an MSYS helper nor the environment is an MSYS shell.
function msysHint(reason, env = process.env) {
  const named = HELPER_IMAGE.test(String(reason || ''));
  if (!named && !(env && env.MSYSTEM)) return null;
  const cli = cliPath();
  return `Git Bash can start a command through an MSYS helper (sh.exe, env.exe, timeout.exe) whose parent Windows cannot see, so belay cannot prove this command came from you. Run it from PowerShell or cmd (belay.cmd for a global install)${cli ? `, or run it directly with: node ${cli} <command>` : ''}.`;
}

// `e` is a client error: when it is an operator-check refusal, add the hint to its message and to detail.hint. Returns `e`.
function hinted(e, env = process.env) {
  if (!e || !e.detail || e.detail.reason !== 'operator_check' || e.detail.hint) return e;
  const line = msysHint(`${e.detail.operator_reason || ''} ${e.message || ''}`, env);
  if (!line) return e;
  e.detail.hint = line;
  e.message = `${e.message}. ${line}`;
  return e;
}

module.exports = { msysHint, hinted, HELPER_IMAGE };
