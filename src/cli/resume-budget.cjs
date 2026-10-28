'use strict';
// resume-budget.cjs — the three `belay resume` options for a run paused because a budget was reached:
// --budget <usd> (a raised run limit), --task-budget <task-id> <usd> (a raised task limit), --over-budget (the breached limit
// stops being enforced for the rest of the run). The run process's budget guard decides which one the pause accepts.

const usd = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// Reads one flag at argv[i] into `into`; returns { next } (the index of its last token) or { error }.
function parseFlag(flag, argv, i, into) {
  if (flag === '--over-budget') { into.over_budget = true; return { next: i }; }
  if (flag === '--budget') {
    const n = usd(argv[i + 1]);
    if (n === null) return { error: '--budget needs a positive number of dollars at API rates' };
    into.budget = n; return { next: i + 1 };
  }
  const n = usd(argv[i + 2]);
  if (!argv[i + 1] || String(argv[i + 1]).startsWith('-') || n === null) return { error: '--task-budget needs a task id and a positive number of dollars at API rates' };
  into.task_budget = { task_id: argv[i + 1], usd: n }; return { next: i + 2 };
}

module.exports = { parseFlag };
