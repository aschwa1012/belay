// prompt-schema-drift.test.cjs — what the orchestrator prompts and the memory-lever text tell the model to call and pass must
// exist in the listing the model is given: every `mcp__belay__<tool>` is a listed orchestrator tool, and every backticked
// field named near a tool is a property of that tool's input schema (`acceptance: { "verdict": true }` is checked as
// acceptance.verdict). A field the prompt names that the schema lacks is a field the model is told to send and a strict
// client could drop; a missing tool is a call that cannot be made. Extraction is deliberately plain. A tool is mentioned as
// `mcp__belay__<tool>` or as a backticked bare name that is a listed tool. Its window runs from the mention through the end
// of its sentence and the sentence after it (a sentence ending in a colon takes the list under it) or to the next mention,
// and only backticked words in the window are read. Anything that is not an input is named in NOT_FIELDS, kept small.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../../src/mcp/tools.cjs');
const L = require('../../src/cli/run-levers.cjs');

const PROMPTS = path.join(__dirname, '..', '..', 'src', 'run', 'prompts');
const BASE = tools.toolsFor('orchestrator');
const ALL_ON = tools.toolsFor('orchestrator', { notes: true, knowledge: true, queries: true });
const ALL_NAMES = new Set(ALL_ON.concat(BASE).map((t) => t.name));

// Backticked words in a window that are not inputs of the tool before them: a tool that is not the orchestrator's (the worker's
// lease_release), a value (done), a branch name (main).
const NOT_FIELDS = new Set(['done', 'lease_release', 'main']);
// Per tool: the prompt names a result or a refusal detail beside the tool, not an input.
const NOT_FIELDS_OF = { memory_store: new Set(['notes']), worker_message: new Set(['op', 'queued']), worker_spawn: new Set(['coder']), worker_wait: new Set(['already', 'evaluated']), task_assign: new Set(['delivered']), memory_retrieve: new Set(['memory_ids']) };

// Marks: every `mcp__belay__<tool>` (the tool must exist) and every backticked bare name that is a listed tool.
function marks(text) {
  const out = [];
  const re = /`?mcp__belay__([a-z_]+)`?|`([a-z_]+)`/g;
  for (let m; (m = re.exec(text));) {
    const tool = m[1] || m[2];
    if (m[2] && !ALL_NAMES.has(tool)) continue;
    out.push({ tool, prefixed: !!m[1], start: m.index, at: m.index + m[0].length });
  }
  return out;
}

const SENTENCE_END = /([.!?](\s|$)|:\r?\n)/;
const BREAK = /\n[ \t]*\n|\n[ \t]*- /;

function windows(text) {
  const ms = marks(text);
  return ms.map((m, i) => {
    let end = i + 1 < ms.length ? ms[i + 1].start : text.length;
    let pos = m.at;
    for (let n = 0; n < 2; n += 1) {
      const rest = text.slice(pos);
      let stop = rest.search(SENTENCE_END);
      const brk = rest.search(BREAK);
      if (brk !== -1 && (stop === -1 || brk < stop)) { pos += brk; break; } // a sentence never runs into the next paragraph or list item
      if (stop === -1) { pos = text.length; break; }
      if (rest[stop] === ':') { // a colon-newline sentence takes the list under it, to the next blank line after the list
        const gap = rest.indexOf('\n\n', stop);
        const close = gap === -1 ? -1 : rest.indexOf('\n\n', gap + 2);
        stop = close === -1 ? rest.length : close;
      } else stop += 1;
      pos += stop;
    }
    end = Math.min(end, pos);
    return [m.tool, text.slice(m.at, Math.max(end, m.at))];
  });
}

// [tool, field] pairs: backticked `field`, `field: ...` (leading word) and `acceptance: { "verdict"`.
function pairs(text, impliedTool) {
  const found = [];
  const ws = windows(text);
  if (impliedTool) ws.push([impliedTool, text]);
  for (const [tool, w] of ws) {
    const seen = new Set();
    for (const m of w.matchAll(/`([^`]+)`/g)) {
      const lead = /^([a-z][a-z_]*)(?::|$)/.exec(m[1].trim());
      if (!lead) continue;
      const nested = /^acceptance:\s*\{\s*"([a-z_]+)"/.exec(m[1]);
      const key = nested ? `acceptance.${nested[1]}` : lead[1];
      if (/^mcp__belay__/.test(key) || ALL_NAMES.has(key) || NOT_FIELDS.has(key) || (NOT_FIELDS_OF[tool] && NOT_FIELDS_OF[tool].has(key)) || seen.has(key)) continue;
      seen.add(key);
      found.push([tool, key]);
    }
  }
  return found;
}

function hasField(listing, tool, key) {
  const t = listing.find((x) => x.name === tool);
  if (!t) return false;
  let node = t.inputSchema;
  for (const part of key.split('.')) {
    if (!node || !node.properties || !node.properties[part]) return false;
    node = node.properties[part];
  }
  return true;
}

// A bare word may also be a property one object down (task_create's bullets list `commands`, which is acceptance.commands).
function hasFieldOrNested(listing, tool, key) {
  if (hasField(listing, tool, key)) return true;
  const t = listing.find((x) => x.name === tool);
  const props = (t && t.inputSchema && t.inputSchema.properties) || {};
  return !key.includes('.') && Object.keys(props).some((k) => props[k].type === 'object' && hasField(listing, tool, `${k}.${key}`));
}

function check(label, text, listing, impliedTool) {
  const missing = [];
  const re = /mcp__belay__([a-z_]+)/g;
  for (let m; (m = re.exec(text));) if (!listing.some((t) => t.name === m[1])) missing.push(`${m[1]} (tool not in the listing)`);
  for (const [tool, key] of pairs(text, impliedTool)) if (listing.some((t) => t.name === tool) && !hasFieldOrNested(listing, tool, key)) missing.push(`${tool}.${key}`);
  assert.deepStrictEqual(missing, [], `${label} names tools or fields the listing lacks: ${missing.join(', ')}`);
  return pairs(text, impliedTool);
}

const read = (f) => fs.readFileSync(path.join(PROMPTS, f), 'utf8').replace(/\r\n/g, '\n').replace(/\{\{[^}]*\}\}/g, '');
const has = (ps, tool, key) => ps.some(([t, k]) => t === tool && k === key);

for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
  test(`${f}: every tool and field the prompt names is in the orchestrator listing`, () => {
    const ps = check(f, read(f), BASE);
    for (const [t, k] of [['task_create', 'acceptance.verdict'], ['task_create', 'spec'], ['worker_spawn', 'substrate'], ['worker_spawn', 'agent_type'],
      ['worker_spawn', 'worktree'], ['task_evaluate', 'worktree'], ['worker_wait', 'worker_ids'], ['memory_store', 'text']]) {
      assert.ok(has(ps, t, k), `the extraction finds ${t}.${k}`);
    }
  });
}

test('memory-rules.md (spliced in at {{memory_rules}}) names only tools and fields the listing has', () => {
  const ps = check('memory-rules.md', read('memory-rules.md'), BASE);
  assert.ok(has(ps, 'memory_retrieve', 'ids'), 'the extraction finds memory_retrieve.ids');
});

test('the memory-lever text names only tools and fields the matching listing has', () => {
  const ps = check('MEMORY_USE_NOTES', L.MEMORY_USE_NOTES, ALL_ON);
  for (const [t, k] of [['memory_search', 'query'], ['memory_store', 'namespace'], ['memory_store', 'kind'], ['memory_store', 'title'], ['memory_store', 'when'], ['memory_store', 'basis']]) {
    assert.ok(has(ps, t, k), `the extraction finds ${t}.${k}`);
  }
  check('MEMORY_REPORT_LINE', L.MEMORY_REPORT_LINE, ALL_ON);
  check('MEMORY_VERIFY_RULE', L.MEMORY_VERIFY_RULE, BASE);
  assert.ok(has(check('MEMORY_QUERIES_LINE', L.MEMORY_QUERIES_LINE, ALL_ON, 'worker_spawn'), 'worker_spawn', 'memory_queries'));
});

test('the drift check fails loudly on a missing field, a field on a tool without it, a missing tool and an unprefixed tool', () => {
  const noVerdict = BASE.map((t) => {
    if (t.name !== 'task_create') return t;
    const c = JSON.parse(JSON.stringify(t));
    delete c.inputSchema.properties.acceptance.properties.verdict;
    return c;
  });
  assert.throws(() => check('x', read('orchestrator.md'), noVerdict), /task_create\.acceptance\.verdict/);
  assert.throws(() => check('x', 'call `mcp__belay__memory_list` with `text`', BASE), /memory_list\.text/);
  assert.throws(() => check('x', 'call `mcp__belay__no_such_tool`', BASE), /no_such_tool \(tool not in the listing\)/);
  assert.throws(() => check('x', 'then `task_assign` with `bogus_field`.', BASE), /task_assign\.bogus_field/);
});

test('tripwire: invented fields appended to a prompt are caught, in both prompts', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = `${read(f)}\n\nCall \`mcp__belay__worker_wait\` with \`mode\` and \`state\` and \`branch\`.\n`;
    assert.throws(() => check(f, text, BASE), /worker_wait\.mode, worker_wait\.state, worker_wait\.branch/, f);
  }
});

test('A5 the largest orchestrator listing (every lever on) is pinned and inside the 16,384 byte budget', () => {
  const bytes = tools.listingBytes('orchestrator', { notes: true, knowledge: true, queries: true });
  assert.ok(bytes <= tools.BUDGET.orchestrator, `everything-on orchestrator listing is ${bytes} bytes, over ${tools.BUDGET.orchestrator} by ${bytes - tools.BUDGET.orchestrator}`);
  assert.strictEqual(bytes, 12003, 'the everything-on orchestrator listing size is pinned; change this with the ADR 0010 amendment that changes it');
});
