'use strict';
// check-flake.cjs — the store-wide record of how each check command came out on one tree (0.4.0). `record` runs inside the transaction
// that writes an evaluation's result, so the row and the evaluation agree (invariant 5). It keeps counts and the last outcome and claims no
// rate: a flip is a change of outcome on the same (argv, cwd, tree) key, and the table cannot tell a flake from load, so each key carries
// whether its last run overlapped another evaluation. No threshold, no wake, no effect on any decision. `list` is the read.

const keyOf = (judged) => (judged && judged.tree_sha ? { sha: judged.tree_sha, kind: 'tree' } : judged && judged.head_sha ? { sha: judged.head_sha, kind: 'head' } : null);

// Each attempt of a command check, oldest first, as 'pass' or 'fail': a pass on a retry inside one evaluation is an outcome after the failure.
const outcomesOf = (c) => {
  const a = c.detail && Array.isArray(c.detail.attempts) && c.detail.attempts.length ? c.detail.attempts : null;
  return a ? a.map((x) => (x.exit_code === 0 && !x.timed_out ? 'pass' : 'fail')) : [c.passed ? 'pass' : 'fail'];
};

// -> the number of rows touched. A check that did not run, or an evaluation with no judged tree or head, records nothing.
function record(store, checks, judged, at = Date.now()) {
  const key = keyOf(judged);
  if (!key) return 0;
  const get = store.p('SELECT * FROM check_flake WHERE argv = ? AND cwd = ? AND key_sha = ? AND key_kind = ?');
  const put = store.p('INSERT OR REPLACE INTO check_flake(argv, cwd, key_sha, key_kind, pass_n, fail_n, flips, last_outcome, last_concurrent, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const c of checks) {
    if (!c || c.kind !== 'command' || !c.executable || !Array.isArray(c.argv) || !c.detail || typeof c.detail.cwd !== 'string') continue;
    const argv = JSON.stringify(c.argv);
    const cur = get.get(argv, c.detail.cwd, key.sha, key.kind) || { pass_n: 0, fail_n: 0, flips: 0, last_outcome: null, first_at: at };
    let { pass_n, fail_n, flips, last_outcome } = cur;
    for (const o of outcomesOf(c)) {
      if (o === 'pass') pass_n += 1; else fail_n += 1;
      if (last_outcome !== null && last_outcome !== o) flips += 1;
      last_outcome = o;
    }
    put.run(argv, c.detail.cwd, key.sha, key.kind, pass_n, fail_n, flips, last_outcome, Array.isArray(c.concurrent) && c.concurrent.length ? 1 : 0, cur.first_at, at);
    n += 1;
  }
  return n;
}

// check.flake { all? } -> { keys: [...] }: the keys that have flipped (all: every key), most recent first. A store from before the table has none.
function list(E, caller, args = {}) {
  let rows;
  try { rows = E.store.p(`SELECT * FROM check_flake ${args.all ? '' : 'WHERE flips > 0'} ORDER BY last_at DESC, argv`).all(); } catch { rows = []; }
  return { keys: rows.map((r) => ({ argv: JSON.parse(r.argv), cwd: r.cwd, key_sha: r.key_sha, key_kind: r.key_kind, pass_n: r.pass_n, fail_n: r.fail_n, flips: r.flips, last_outcome: r.last_outcome, last_concurrent: !!r.last_concurrent, first_at: r.first_at, last_at: r.last_at })) };
}

// One key as a line of facts (the overlap beside the flips; no rate, no verdict). The argv is clipped; the tree is its first 12 characters.
function line(k) {
  const cmd = k.argv.map((a, i) => (i === 0 ? String(a).split(/[\/]/).pop() : String(a))).join(' ');
  const shown = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
  return `flaky check: ${shown}  on ${k.key_kind} ${String(k.key_sha).slice(0, 12)}: ${k.pass_n} pass, ${k.fail_n} fail, ${k.flips} flip${k.flips === 1 ? '' : 's'}, last ${k.last_outcome}${k.last_concurrent ? ' (overlapped another evaluation)' : ''}`;
}

module.exports = { record, list, line };
