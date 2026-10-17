'use strict';
// review-stage-unsupported.test.cjs — the archive reviewer's brief for an `unsupported` queue entry carries the run's wider evidence as PATHS: the
// streams of the task that wrote the note, the streams of the run's other workers (not another run's), and the task's diff saved beside the brief.
// Those streams are passed to memory.reviewApply as citable evidence files. The core is a stub; the git repository and the files are real.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runReview } = require('../../src/run/review-stage.cjs');

test('the brief of an unsupported entry names the task streams, the other workers\' streams and a saved diff, and they are citable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-uns-'));
  try {
    const repo = path.join(root, 'repo'), dataDir = path.join(root, 'data');
    fs.mkdirSync(repo); fs.mkdirSync(dataDir);
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.js'), 'one\n'); git('add', '.'); git('commit', '-q', '-m', 'one');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.js'), 'one\nTWO-ADDED-LINE\n'); git('commit', '-q', '-am', 'two');
    const head = git('rev-parse', 'HEAD');
    const workers = [
      { id: 'w-mine', run_id: 'r1', task_id: 't1', base_sha: base, head_sha: head, worktree: repo },
      { id: 'w-other', run_id: 'r1', task_id: 't2' },
      { id: 'w-foreign', run_id: 'r-else', task_id: 't9' },
    ];
    const entry = { held_row: 'h1', id: 'n1', kind: 'unsupported', of: null, ground: 'unsupported', reason: 'no single place', cites: [], facts: null, run_id: 'r1', head_sha: head, marked_at: 1, runs_waited: 0, target_review_verified: false, note: { id: 'n1', run_id: 'r1', task_id: 't1', title: 'a claim' }, of_note: null };
    let applied = null;
    const core = {
      memory: {
        reviewQueue: async () => ({ project: 'p', held: [entry], counts: { count: 1, max_runs_waited: 0, review_verified: 0 } }),
        events: async () => ({ events: [] }),
        recordEvent: async (f) => f,
        reviewApply: async (a) => { applied = a; return { counts: { applied: 0, refused: 0 }, applied: [], refused: [] }; },
      },
      worker: { list: async () => ({ workers }) },
    };
    let prompt = null;
    const manager = {
      spawn: async (a) => { prompt = a.prompt; }, wait: async () => ({ event: 'turn_end', is_error: false, timed_out: false }),
      stop: async () => {}, _worker: () => ({ lastAssistantText: JSON.stringify({ verdicts: [{ id: 'n1', verdict: 'still_unsupported', reason: 'cannot decide' }] }), costUsd: 0.01 }),
    };
    const lv = { notes: true, archive_review_auto: false, scrub_action: 'propose', review_cost_cap_usd: 2, review_wall_s: 60, archive_review_model: 'm' };
    const out = await runReview({ core, runId: 'r1', lv, dataDir, getManager: async () => manager, worktree: repo, force: true });
    assert.strictEqual(out.ran, true, JSON.stringify(out));
    const brief = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(fs.readFileSync(/(\S+brief\.md)/.exec(prompt)[1], 'utf8'))[1]);
    const ev = brief[0].evidence;
    const stream = (w) => path.join(dataDir, 'workers', w, 'stream.jsonl').split(path.sep).join('/');
    assert.deepStrictEqual(ev.task_streams.map((s) => [s.worker, s.path]), [['w-mine', stream('w-mine')]]);
    assert.deepStrictEqual(ev.other_streams.map((s) => s.worker), ['w-other'], 'another run\'s worker is not offered');
    assert.match(fs.readFileSync(ev.diff_file, 'utf8'), /\+TWO-ADDED-LINE/);
    assert.deepStrictEqual([...applied.evidence_files].sort(), [stream('w-mine'), stream('w-other')].sort());
    assert.match(fs.readFileSync(/(\S+brief\.md)/.exec(prompt)[1], 'utf8'), /kind "unsupported" is a note a reviewer could not prove or disprove/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
