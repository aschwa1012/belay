'use strict';
// The panel's one write action (the memory line's archive review button) is reachable from the button's onPress and from nothing else:
// no command, hook, notice, tool call, model output or message can reach it. The mod's own test kit cannot see a code path it does not
// run, so this reads the sources of ALL of src/mod, structurally (panel-review-guard.cjs masks comments and strings, names each top-level
// item, and asserts which items hold each piece of the chain), and proves the check itself by feeding it the ways a future change could
// get around it. The chain:
//   view.tsx  <Button key="review" onPress={act.review}>  ->  index.tsx acts().review  ->  reviewPress  ->  dispatchReview  ->  $.process.run

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { analyze, mask } = require('./panel-review-guard.cjs');

const MOD = path.join(__dirname, '..', '..', 'src', 'mod');
function load(dir = MOD, out = {}, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    const r = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) load(p, out, r);
    else if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out[r] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  }
  return out;
}
const files = load();
const patched = (file, from, to) => {
  assert.ok(files[file].includes(from), `the fixture text is in ${file}: ${from}`);
  return { ...files, [file]: files[file].replace(from, to) };
};

test('the mod is scanned whole, and the masking keeps every file balanced', () => {
  assert.ok(Object.keys(files).some((f) => f === 'hooks/panel/index.tsx') && Object.keys(files).some((f) => f.startsWith('hooks/wake/')), Object.keys(files).join(', '));
  for (const [f, text] of Object.entries(files)) {
    if (f.startsWith('tests/') || f.startsWith('types/')) continue;
    const { code } = mask(text);
    assert.strictEqual(code.length, text.length, `${f}: masking keeps positions`);
    const count = (c) => code.split(c).length - 1;
    assert.strictEqual(count('{'), count('}'), `${f}: braces balance outside strings and comments`);
  }
});

test('the real wiring holds: one launcher call in dispatchReview, called by reviewPress, called by the review handler of acts(), pressed by the one Button', () => {
  assert.deepStrictEqual(analyze(files), []);
});

test('the check is not a tripwire: each way around it is found', () => {
  const cases = [
    ['bracket access to process.spawn', patched('hooks/panel/index.tsx', 'const firstLine =', "const bypass = ($: any) => $.process['spawn']({ argv: [] })\nconst firstLine ="), /bracket access|process/],
    ['a destructured spawn', patched('hooks/panel/view.tsx', 'function Held(', "const { spawn } = ($ as any).process\nfunction Held("), /`process` is used other than/],
    ['an alias of $.process', patched('hooks/panel/index.tsx', 'const firstLine =', 'const proc = ($: any) => $.process\nconst firstLine ='), /`process` is used other than/],
    ['a $.process.run in a new helper of the panel', patched('hooks/panel/index.tsx', 'const firstLine =', "async function helper($: Host) { await $.process.run(['x']) }\nconst firstLine ="), /\$\.process\.run is called from/],
    ['the wake runs a command', patched('hooks/wake/index.ts', 'for await (const chunk of $.process.spawn(', "await $.process.run(['belay', 'memory', 'review']); for await (const chunk of $.process.spawn("), /\$\.process\.run is called from/],
    ['a second caller of dispatchReview', patched('hooks/panel/index.tsx', 'const firstLine =', "async function other($: Host) { await dispatchReview($, 'acme') }\nconst firstLine ="), /dispatchReview is called from/],
    ['an alias of reviewPress used by the wake', patched('hooks/panel/index.tsx', "    review: () => { void reviewPress($) },", "    review: () => { void reviewPress($) },\n    other: () => { const go = reviewPress; void go($) },"), /reviewPress is named in/],
    ['a second use of act.review', patched('hooks/panel/view.tsx', 'function Orchestrator(', 'const sneaky = (act: Act) => act.review()\nfunction Orchestrator('), /a `\.review` member is used/],
    ['bracket access to the review handler', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneaky = (act: Act) => act['review']()\nfunction Orchestrator("), /bracket access to \['review'\]/],
    ['the Button loses its key', patched('hooks/panel/view.tsx', '<Button key="review"', '<Button key="other"'), /a `\.review` member is used/],
    ['the wake imports the panel', patched('hooks/wake/index.ts', 'import', "import { x } from '../panel/index'\nimport"), /imports from the panel/],
    ['a prompt submission', patched('hooks/panel/index.tsx', 'const firstLine =', "const talk = ($: any) => $.prompt.submit('belay memory review')\nconst firstLine ="), /a write or a model-facing call/],
    ['runJson called with a literal review argv from a timer', patched('hooks/panel/index.tsx', 'const notices = await runJson($, cli, [\'notices\', ...runArg], watch.dataDir)', 'const notices = await runJson($, cli, [\'notices\', ...runArg], watch.dataDir)\n  await runJson($, cli, [\'memory\', \'review\', \'--project\', \'acme\', \'--start\'], watch.dataDir)'), /runJson is called other than with a literal read verb/],
    ['a new helper that calls runJson with the review words', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak($: Host, cli: string[]) { await runJson($, cli, ['memory', 'review', '--start'], null) }\nconst firstLine ="), /runJson is called other than with a literal read verb/],
    ['runJson called with a computed argv', patched('hooks/panel/index.tsx', 'const firstLine =', 'async function sneak2($: Host, cli: string[], a: string[]) { await runJson($, cli, a, null) }\nconst firstLine ='), /runJson is called other than with a literal read verb/],
    ['a computed host member', patched('hooks/panel/index.tsx', 'const firstLine =', "const sneak3 = ($: any) => { const k = 'pro' + 'cess'; return $[k].run(['x']) }\nconst firstLine ="), /reached by a computed member/],
    ['an alias of the host object', patched('hooks/panel/index.tsx', 'const firstLine =', 'async function sneak4($: any) { const h = $\n  return h }\nconst firstLine ='), /reached by a computed member, a cast or an alias/],
    ['the review word in a new place', patched('hooks/panel/index.tsx', 'const firstLine =', "const WORDS = ['review', 'x']\nconst firstLine ="), /the string "review" appears outside/],
    ['a second caller of settlePress', patched('hooks/panel/index.tsx', 'const firstLine =', "async function other2($: Host) { await settlePress($, 'x') }\nconst firstLine ="), /settlePress is named in/],
    ['settlePress aliased in acts', patched('hooks/panel/index.tsx', '    commit: id => { void settlePress($, id) },', '    commit: id => { const go = settlePress; void go($, id) },'), /settlePress is named in/],
    ['settleArgs used by a second function', patched('hooks/panel/index.tsx', 'const firstLine =', "const sneakArgs = () => settleArgs('archive', 'x', 'y')\nconst firstLine ="), /settleArgs is used in/],
    ['settlePress runs another argv', patched('hooks/panel/index.tsx', 'argvFor(r.cli, settleArgs(action, id, reason), watch.dataDir)', "argvFor(r.cli, ['memory', 'review', '--start'], watch.dataDir)"), /settleArgs is used in|expected exactly|\$\.process\.run/],
    ['settleArgs gains a verb', patched('hooks/panel/held.ts', "['memory', 'held', 'settle', id,", "['memory', 'archive', 'purge', id,"), /settleArgs in hooks\/panel\/held\.ts is not exactly/],
    ['settleArgs splits the reason', patched('hooks/panel/held.ts', "'--reason', reason]", "'--reason', ...reason.split(' ')]"), /settleArgs in hooks\/panel\/held\.ts is not exactly/],
    ['a second act.settle use', patched('hooks/panel/view.tsx', 'function Orchestrator(', 'const sneaky2 = (act: Act) => act.settle(\'archive\', \'x\')\nfunction Orchestrator('), /a `\.settle` member is used/],
    ['the settle Button leaves SettleRow', patched('hooks/panel/view.tsx', 'function Held(', "const sneaky3 = (E: Els, act: Act) => <E.Button key={`${'a'}-${'b'}`} onPress={() => act.settle('archive', 'b')} />\nfunction Held("), /a `\.settle` member is used/],
    ['the wake names settlePress', patched('hooks/wake/index.ts', 'import', "const x = settlePress\nimport"), /names the review launcher or the settle writer/],
    ['runJson reads another memory verb', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak5($: Host, cli: string[]) { await runJson($, cli, ['memory', 'held', 'settle'], null) }\nconst firstLine ="), /runJson is called other than with a literal read verb/],
    ['runJson reads the awaiting list with a computed argv', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak6($: Host, cli: string[]) { await runJson($, cli, AWAITING_READ, null) }\nconst firstLine ="), /runJson is called other than with a literal read verb/],
    ['the settle word in a new place', patched('hooks/panel/index.tsx', 'const firstLine =', "const W2 = ['settle', 'x']\nconst firstLine ="), /the string "settle" appears outside/],
    ['a top-level second settleArgs in index.tsx, import dropped', patched('hooks/panel/index.tsx', 'const firstLine =', "const settleArgs = (a: string, id: string, reason: string) => ['memory', 'archive', 'purge', id, reason]\nconst firstLine ="), /settleArgs is declared in/],
    ['a local settleArgs shadow inside settlePress', patched('hooks/panel/index.tsx', "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs(", "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    const settleArgs = (a: string, i: string, why: string) => ['memory', 'archive', 'purge', i, why]\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs("), /settleArgs is declared in/],
    ['settleArgs not imported from held', patched('hooks/panel/index.tsx', 'settleArgs, settleLine', 'settleLine'), /does not import settleArgs/],
    ['a second argvFor in index.tsx', patched('hooks/panel/index.tsx', 'const firstLine =', "const argvFor = (cli: string[], a: string[]) => [...cli, ...a]\nconst firstLine ="), /argvFor is declared in/],
    ['a local argvFor shadow in settlePress', patched('hooks/panel/index.tsx', "    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs(", "    const argvFor = (cli: string[], a: string[], d: string | null) => [...cli, ...a]\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs("), /argvFor is declared in/],
    ['r.cli.splice in settlePress', patched('hooks/panel/index.tsx', "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs(", "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    r.cli.splice(1, 1, 'x')\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs("), /`r` or `r\.cli` is changed/],
    ['r.cli.push in dispatchReview', patched('hooks/panel/index.tsx', "  starting.add(project)\n", "  starting.add(project)\n  r.cli.push('--other')\n"), /`r` or `r\.cli` is changed/],
    ['r.cli index assignment in dispatchReview', patched('hooks/panel/index.tsx', "  starting.add(project)\n", "  starting.add(project)\n  r.cli[0] = 'evil'\n"), /`r` or `r\.cli` is changed/],
    ['r reassigned in settlePress', patched('hooks/panel/index.tsx', "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs(", "    const cwd = watch.fixed && watch.dataDir ? projectRootOf(watch.dataDir) : null\n    r = { cli: ['x'] }\n    try {\n      const res = await $.process.run(argvFor(r.cli, settleArgs("), /`r` or `r\.cli` is changed|declared other than once|is not `const r/],
    ['r not from resolveCli in settlePress', patched('hooks/panel/index.tsx', "    const r = await resolveCli($, watch)\n    if ('error' in r) { $.ui.toast(`belay: the note was not settled", "    const r = { cli: ['x'] }\n    if ('error' in r) { $.ui.toast(`belay: the note was not settled"), /`r` is not `const r = await resolveCli/],
    ['the note handler starts a read round', patched('hooks/panel/index.tsx', 'note: id => { void update', 'note: id => { void tick($); void update'), /tick is named in/],
    ['the note handler runs a read', patched('hooks/panel/index.tsx', 'note: id => { void update', "note: id => { void runJson($, cli, ['agents'], null); void update"), /runJson is called outside fetchSnapshot/],
    ['a second commit use', patched('hooks/panel/view.tsx', 'function Orchestrator(', 'const sneaky4 = (act: Act) => act.commit("x")\nfunction Orchestrator('), /a `\.commit` member is used/],
    ['the commit Button loses its key', patched('hooks/panel/view.tsx', '<Button key={`commit:$' + '{n.id}`}', '<Button key={`other:$' + '{n.id}`}'), /a `.commit` member is used/],
    ['the reason Input commits', patched('hooks/panel/view.tsx', 'onSubmit={v => act.reason(v)}', 'onSubmit={v => act.commit("x")}'), /a `\.commit` member is used/],
    ['a dialog is asked in index.tsx', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak7($: Host) { await $.ui.ask('x', { options: ['a'] }) }\nconst firstLine ="), /a dialog is asked/],
    ['AskUserQuestion is named', patched('hooks/panel/index.tsx', 'const firstLine =', "const Q = 'AskUserQuestion'\nconst firstLine ="), /a dialog is asked/],
    ['commit destructured from an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak9commit = (act: Act) => { const { commit } = act; commit('x') }\nfunction Orchestrator("), /is named other than in the Act type/],
    ['commit by bracket from an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak10commit = (act: Act) => act['commit']('x')\nfunction Orchestrator("), /bracket access to \['review'\]|the string "commit" appears/],
    ['commit by Object.values of an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak11commit = (act: Act) => (Object.values(act)[7] as () => void)()\nfunction Orchestrator("), /an Act is enumerated, spread or indexed/],
    ['review destructured from an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak9review = (act: Act) => { const { review } = act; review() }\nfunction Orchestrator("), /is named other than in the Act type/],
    ['review by bracket from an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak10review = (act: Act) => act['review']()\nfunction Orchestrator("), /bracket access to \['review'\]|the string "commit" appears/],
    ['review by Object.values of an Act', patched('hooks/panel/view.tsx', 'function Orchestrator(', "const sneak11review = (act: Act) => (Object.values(act)[7] as () => void)()\nfunction Orchestrator("), /an Act is enumerated, spread or indexed/],
    ['an Act is spread', patched('hooks/panel/view.tsx', 'function Orchestrator(', 'const sneak12 = (act: Act) => ({ ...act })\nfunction Orchestrator('), /an Act is enumerated, spread or indexed/],
    ['settleStart writes the confirm stage', patched('hooks/panel/index.tsx', "stage: 'reason', reason: '', title: listed.title", "stage: 'confirm', reason: 'x', title: listed.title"), /stage 'confirm' is written outside reasonSubmit|settleStart does not write/],
    ['the pending settle is written elsewhere', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak13($: Host) { await update($, settleA, () => ({ id: 'x', action: 'archive', stage: 'confirm', reason: 'r', title: '', run: { runId: null, dataDir: null, cli: null, node: null } })) }\nconst firstLine ="), /settleA is written with a value outside|stage 'confirm' is written outside/],
    ['the agents read takes --dir from somewhere else', patched('hooks/panel/index.tsx', "watch.orchDir ? ['--dir', watch.orchDir] : []", "watch.orchDir ? ['--dir', runArg[0] ?? ''] : []"), /agents read in fetchSnapshot is not exactly|orchDir is used in fetchSnapshot other/],
    ['the agents read gets a fixed --dir', patched('hooks/panel/index.tsx', "...(watch.orchDir ? ['--dir', watch.orchDir] : [])", "'--dir', '/tmp/x'"), /agents read in fetchSnapshot is not exactly/],
    ['a second --dir in a new helper', patched('hooks/panel/index.tsx', 'const firstLine =', "async function sneak7($: Host, cli: string[]) { await runJson($, cli, ['agents', '--dir', '/x'], null) }\nconst firstLine ="), /the string "--dir" appears in/],
    ['--dir reaches the settle writer', patched('hooks/panel/held.ts', "['memory', 'held', 'settle', id,", "['memory', 'held', 'settle', '--dir', id,"), /the string "--dir" appears in|settleArgs in hooks\/panel\/held\.ts is not exactly/],
    ['orchDir aliased inside fetchSnapshot', patched('hooks/panel/index.tsx', "  const cli = r.cli\n  const agents", "  const cli = r.cli\n  const od = { orchDir: '/x' }.orchDir\n  const agents"), /orchDir is used in fetchSnapshot other than as watch\.orchDir/],
    ['REVIEW_ARGS used by the read helper', patched('hooks/panel/index.tsx', 'const res = await $.process.run(argvFor(r.cli, [...REVIEW_ARGS', 'const res = await $.process.run(argvFor(r.cli, [...REVIEW_ARGS'), null],
  ];
  for (const [name, fs2, re] of cases) {
    const found = analyze(fs2);
    if (re === null) { assert.deepStrictEqual(found, [], `${name}: a no-op patch changes nothing`); continue; }
    assert.ok(found.some((v) => re.test(v)), `${name}: expected a violation matching ${re}, got ${JSON.stringify(found)}`);
  }
});

test('the command the button runs is exactly belay memory review --project <p> --start', () => {
  assert.match(files['hooks/panel/index.tsx'], /const REVIEW_ARGS = \['memory', 'review', '--project'\]/);
  assert.match(files['hooks/panel/index.tsx'], /const START_FLAG = '--start'/);
  assert.match(files['hooks/panel/index.tsx'], /\[\.\.\.REVIEW_ARGS, project, START_FLAG\]/);
});
