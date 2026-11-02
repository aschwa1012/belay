'use strict';
// push-guard.cjs — the matcher behind the push check (ADR 0085). A worker that pushes a branch, or changes a remote through
// `gh`, publishes work nobody has reviewed and can overwrite someone else's. `refusal(command)` returns the one-line refusal
// for a shell command that pushes to a remote or writes to one through the GitHub CLI, or null. The match is textual and looks
// through wrappers (`cmd /c`, `powershell -Command`, `bash -c`, env prefixes, `git -C x push`) by scanning the whole string; it
// is a safety net, not a parser, and a command built at run time, or a script written and then run, escapes it. Plain node, no
// requires: guard.cjs runs it in the one hook process spawned for every shell call of a worker.
const MESSAGE = 'Do not push or write to a remote (git push, gh pr/issue/release/repo/api writes). Commit in your worktree and report the branch.';

const WORD = String.raw`(?:^|[\s(/\\])`; // a command word starts a segment or follows a space, `(` or a path separator, never `.git`
const GIT_VALUE_OPTS = '-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix|--attr-source';
const GIT_PUSH = new RegExp(String.raw`${WORD}git(?:\.exe)?((?:\s+(?:${GIT_VALUE_OPTS})\s+\S+|\s+-\S*)*)\s+(?:push|send-pack)(?=$|[\s);])`);
const GH_WORD = new RegExp(String.raw`${WORD}gh(?:\.exe)?(?=\s|$)(.*)$`);

// gh command groups whose verbs write to the remote unless the verb is one of these readers.
const GH_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'gist', 'workflow', 'run', 'label', 'secret', 'variable', 'ssh-key', 'gpg-key', 'ruleset', 'cache', 'codespace', 'project']);
const GH_READ_VERBS = new Set(['view', 'list', 'diff', 'status', 'checks', 'download', 'checkout', 'clone', 'get', 'watch']);

// Segments are split at ; && || | & and newlines.
function segments(s) { return s.split(/;|&&|\|\||\||&|\r?\n/).map((x) => x.trim()).filter(Boolean); }

// `gh api`: a write method, or fields without an explicit GET (gh sends fields as a POST body then), or a GraphQL mutation.
function ghApiWrites(tokens, seg) {
  if (tokens.includes('graphql')) return /\bmutation\b/.test(seg);
  let method = null;
  let fields = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-x' || t === '--method') method = tokens[i + 1] || '';
    else if (t.startsWith('--method=')) method = t.slice(9);
    else if (/^-x\S/.test(t)) method = t.slice(2);
    else if (t.startsWith('-f') || /^--(?:field|raw-field|input)(?:=|$)/.test(t)) fields = true;
  }
  if (method !== null) return method !== 'get' && method !== 'head';
  return fields;
}

function ghWrites(seg) {
  const m = GH_WORD.exec(seg);
  if (!m) return false;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-r' || tokens[i] === '--repo') { i++; continue; } // -R owner/repo takes a value; it is not the verb
    if (tokens[i].startsWith('-')) continue;
    words.push(tokens[i]);
    if (words.length === 2) break;
  }
  const [group, verb] = words;
  if (group === 'api') return ghApiWrites(tokens, seg);
  return GH_GROUPS.has(group) && verb !== undefined && !GH_READ_VERBS.has(verb);
}

function normalize(command, quote, unescape) {
  const t = String(command).toLowerCase().replace(/["']/g, quote);
  return unescape ? t.replace(/[\^`]/g, '') : t; // cmd `^` and PowerShell backtick escapes
}

function refusal(command) {
  if (typeof command !== 'string' || !command) return null;
  for (const [quote, unescape] of [[' ', false], ['', false], [' ', true], ['', true]]) { // `g"it" push` joins, `cmd /c"git push` splits: try both
    const n = normalize(command, quote, unescape);
    if (segments(n).some((seg) => GIT_PUSH.test(seg) || ghWrites(seg))) return MESSAGE;
  }
  return null;
}

module.exports = { refusal, MESSAGE };
