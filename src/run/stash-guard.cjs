'use strict';
// stash-guard.cjs — the matcher behind the stash check. `git stash` keeps one stack in the repository's common directory, shared by
// every worktree of it, so a worker that stashes (or pops) in its task tree can take or bury another worker's or the operator's
// stash. `refusal(command)` returns the one-line refusal for a shell command that runs `git stash` with anything but the read-only
// `list` or `show`, or null. It reuses the push check's text scan (wrappers, `git -C x`, quotes, line continuations), with the same
// limits: a git alias, a command built at run time, or a script written first and run later escapes it. Plain node: guard.cjs runs it
// in the one hook process spawned for every shell call of a worker.
const PG = require('./push-guard.cjs');

const MESSAGE = 'Do not use git stash: its stack is shared by every worktree. Commit to a temporary branch instead, or copy the tree with git worktree add. (git stash list and show are allowed.)';

const TAIL = String.raw`(?=$|[\s);<>|&])`;
// `git [global options] stash` and what follows it in the segment.
const GIT_STASH = String.raw`${PG.WORD}git(?:\.exe)?(?:\s+(?:${PG.GIT_VALUE_OPTS})\s+\S+|\s+-\S*)*\s+stash${TAIL}`;
const READ_ONLY = new RegExp(String.raw`^\s+(?:list|show)${TAIL}`);

// A bare `git stash` and every other subcommand or option write the stack (a bare stash is `push`); only `list` and `show` read it.
// A segment can hold several git words (`git stash list $(git stash pop)`), so each is checked.
function stashes(seg) {
  const re = new RegExp(GIT_STASH, 'g');
  for (let m = re.exec(seg); m; m = re.exec(seg)) {
    if (!READ_ONLY.test(seg.slice(m.index + m[0].length))) return true;
  }
  return false;
}

function refusal(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand) return null;
  for (const command of PG.forms(rawCommand)) {
    for (const [quote, unescape] of [[' ', false], ['', false], [' ', true], ['', true]]) {
      const n = PG.normalize(command, quote, unescape);
      if (PG.segments(n).some(stashes)) return MESSAGE;
    }
  }
  return null;
}

module.exports = { refusal, MESSAGE };
