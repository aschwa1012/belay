'use strict';
// push-guard.cjs — the matcher behind the push check (ADR 0085). A worker that pushes a branch, or changes a remote through
// `gh`, publishes work nobody has reviewed and can overwrite someone else's. `refusal(command)` returns the one-line refusal
// for a shell command that pushes to a remote or writes to one through the GitHub CLI, or null. The match is textual and looks
// through wrappers (`cmd /c`, `powershell -Command`, `bash -c`, env prefixes, `git -C x push`) by scanning the whole string; it
// is a safety net, not a parser, and a command built at run time, or a script written and then run, escapes it. Plain node, no
// requires: guard.cjs runs it in the one hook process spawned for every shell call of a worker.
const MESSAGE = 'Do not push or write to a remote (git push, gh pr/issue/release/repo/api writes). Commit in your worktree and report the branch.';

const WORD = String.raw`(?:^|[\s({/\\])`; // a command word starts a segment or follows a space, `(`, `{` (a PowerShell script block) or a path separator, never `.git`
const GIT_VALUE_OPTS = '-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix|--attr-source';
// The subcommands that send to a remote: push, send-pack, http-push, and the push of `subtree` and `lfs`.
const GIT_PUSH = new RegExp(String.raw`${WORD}git(?:\.exe)?((?:\s+(?:${GIT_VALUE_OPTS})\s+\S+|\s+-\S*)*)\s+(?:push|send-pack|http-push|(?:subtree|lfs)\s+push)(?=$|[\s);<>|&}])`);
const GH_WORD = new RegExp(String.raw`${WORD}gh(?:\.exe)?(?=\s|$)(.*)$`);

// gh command groups whose verbs write to the remote unless the verb is one of these readers.
const GH_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'gist', 'workflow', 'run', 'label', 'secret', 'variable', 'ssh-key', 'gpg-key', 'ruleset', 'cache', 'codespace', 'project']);
const GH_READ_VERBS = new Set(['view', 'list', 'diff', 'status', 'checks', 'download', 'checkout', 'clone', 'get', 'watch']);
const GH_READ_PAIRS = new Set(['ruleset check']); // a read whose verb is not in the set above
// `gh api` options that take a separate value word, so the word is not the endpoint.
const GH_API_VALUE_OPTS = new Set(['-x', '--method', '-h', '--header', '-f', '--field', '--raw-field', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview', '--input']);

// A line continuation joins the lines in some shells (bash backslash-newline, PowerShell backtick-newline, cmd caret-newline) and not in
// others (a PowerShell or cmd path ends in a backslash: `Set-Location C:\<NL>git push` is two commands). The tool is not known here, so a
// command is matched both ways, as the quote variants are: as written, and with every continuation joined.
const forms = (s) => [s, s.replace(/[\\`^]\r?\n/g, '')];

// Segments are split at ; && || | & and newlines.
function segments(s) { return s.split(/;|&&|\|\||\||&|\r?\n/).map((x) => x.trim()).filter(Boolean); }

// `gh api`: a write method, or fields without an explicit GET (gh sends fields as a POST body then), or a GraphQL mutation.
function ghApiWrites(tokens, seg) {
  const api = tokens.indexOf('api');
  let endpoint = null;
  for (let i = api + 1; i < tokens.length && endpoint === null; i++) {
    if (GH_API_VALUE_OPTS.has(tokens[i])) i++;
    else if (!tokens[i].startsWith('-')) endpoint = tokens[i];
  }
  if (endpoint === 'graphql') return /\bmutation\b/.test(seg);
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
  const tokens = m[1].trim().split(/\s+/).map((t) => t.replace(/\}+$/, '')).filter(Boolean); // `& {gh pr view 3}`: the block's brace is not part of the word
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-r' || tokens[i] === '--repo') { i++; continue; } // -R owner/repo takes a value; it is not the verb
    if (tokens[i].startsWith('-')) continue;
    words.push(tokens[i]);
    if (words.length === 2) break;
  }
  const [group, verb] = words;
  if (group === 'api') return ghApiWrites(tokens, seg);
  return GH_GROUPS.has(group) && verb !== undefined && !GH_READ_VERBS.has(verb) && !GH_READ_PAIRS.has(`${group} ${verb}`);
}

function normalize(command, quote, unescape) {
  const t = String(command).toLowerCase().replace(/["']/g, quote);
  return unescape ? t.replace(/[\^`]/g, '') : t; // cmd `^` and PowerShell backtick escapes
}

function refusal(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand) return null;
  for (const command of forms(rawCommand)) {
    for (const [quote, unescape] of [[' ', false], ['', false], [' ', true], ['', true]]) { // `g"it" push` joins, `cmd /c"git push` splits: try both
      const n = normalize(command, quote, unescape);
      if (segments(n).some((seg) => GIT_PUSH.test(seg) || ghWrites(seg))) return MESSAGE;
    }
  }
  return null;
}

module.exports = { refusal, MESSAGE, WORD, GIT_VALUE_OPTS, forms, segments, normalize };
