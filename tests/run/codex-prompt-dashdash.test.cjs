'use strict';
// codex-prompt-dashdash.test.cjs — codex exec parses its argv with clap: a prompt that starts with `-` is read as an option
// ("- fix the list" exits 2, "-cmodel=x" is a config override) and a prompt that is `review` or `resume` as a subcommand. Both
// builders put `--` before the prompt, and the prompt is the last element, exactly as given. Probed on codex-cli 0.163.0 with
// no model call: `codex exec --skip-git-repo-check -- "- fix the list" extra` and `... -- resume extra` exit 2 naming only
// `extra`, so the text after `--` was taken as the prompt.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../../src/run/launch.cjs');

const TEXTS = ['- fix the list', '-cmodel=x', '--version', 'resume', 'review', 'plain words'];

test('codex exec and exec resume take the prompt after --, whatever it starts with', () => {
  for (const prompt of TEXTS) {
    const launch = L.codexLaunchArgv({ worktree: 'C:/w', adapterArgs: ['a.cjs'], prompt, model: 'm' });
    const resume = L.codexResumeArgv({ threadId: 't1', adapterArgs: ['a.cjs'], prompt, model: 'm' });
    for (const [name, argv] of [['exec', launch], ['resume', resume]]) {
      assert.deepStrictEqual(argv.slice(-2), ['--', prompt], `${name}: ${JSON.stringify(argv.slice(-3))}`);
      assert.strictEqual(argv.indexOf('--'), argv.length - 2, `${name}: one -- only, right before the prompt`);
    }
    assert.deepStrictEqual(launch.slice(-4, -2), ['-m', 'm'], 'the model stays an option, before --');
  }
});
