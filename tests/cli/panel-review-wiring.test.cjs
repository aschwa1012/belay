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
