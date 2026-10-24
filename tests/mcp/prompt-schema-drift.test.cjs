// prompt-schema-drift.test.cjs — what the orchestrator prompt and the memory-lever text tell the model to call and pass must
// exist in the listing the model is given: every `mcp__belay__<tool>` is a listed orchestrator tool, and every backticked
// field named after it is a property of that tool's input schema (`acceptance: { "verdict": true }` is checked as
// acceptance.verdict). A field the prompt names that the schema lacks is a field the model is told to send and a strict
// client could drop; a missing tool is a call that cannot be made. Extraction is deliberately plain: a tool's window runs
// from its mention to the end of its sentence (a sentence ending in a colon takes the list under it), and only backticked words in it are read.
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

// Backticked words that are not input fields: result fields, values, other tools' names, ids, prose placeholders.
const NOT_FIELDS = new Set([
  'already', 'handoff', 'notes', 'modes_failed', 'warning', 'memory_ids', 'absence_established', 'true', 'false', 'done',
  'project', 'summary', 'holds', 'refuted', 'verified', 'unverified', 'open', 'assigned', 'released', 'coder', 'tester',
  'reviewer', 'researcher', 'claude-code', 'codex', 'mode', 'lease_release', 'task_evaluate', 'task_list', 'blocking',
  'lease', 'state', 'verdict_check', 'e_busy', 'compact', 'op', 'findings', 'head', 'branch', 'tests', 'main',
]);

// A window per tool mention: [tool, text]. Tool names come only from `mcp__belay__<name>`.
function windows(text) {
  const out = [];
  const re = /mcp__belay__([a-z_]+)/g;
  const marks = [];
  for (let m; (m = re.exec(text));) { const e = m.index + m[0].length; marks.push({ tool: m[1], at: text[e] === '`' ? e + 1 : e, mark: m.index }); }
  marks.forEach((m, i) => {
    let end = i + 1 < marks.length ? marks[i + 1].mark : text.length;
    // The sentence that names the tool (to a full stop followed by a space or the end); a sentence that ends in a colon
    // also takes the list under it, up to the next blank line. Later sentences are prose about results, not arguments.
    const rest = text.slice(m.at);
    let stop = rest.search(/([.!?](\s|$)|:\r?\n)/);
    if (stop !== -1 && rest[stop] === ':') {
      const gap = rest.indexOf('\n\n', stop);
      const close = gap === -1 ? -1 : rest.indexOf('\n\n', gap + 2);
      stop = close === -1 ? rest.length : close;
    }
    if (stop !== -1) end = Math.min(end, m.at + stop);
    out.push([m.tool, text.slice(m.at, Math.max(end, m.at))]);
  });
  return out;
}

// [tool, field] pairs: `field`, `field: ...` (backticked, leading word) and `acceptance: { "verdict"`.
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
      if (/^mcp__belay__/.test(key) || tools.toolsFor('orchestrator', { notes: true, knowledge: true, queries: true }).some((t) => t.name === key)) continue;
      if (NOT_FIELDS.has(key) || seen.has(key)) continue;
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
  return pairs(text, impliedTool).length;
}

for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
  test(`${f}: every tool and field the prompt names is in the orchestrator listing`, () => {
    const text = fs.readFileSync(path.join(PROMPTS, f), 'utf8').replace(/\{\{[^}]*\}\}/g, '');
    const n = check(f, text, BASE);
    assert.ok(n >= 8, `the extraction found ${n} pairs; it should find the spec, acceptance, task_id, worker_ids and the rest`);
    assert.ok(pairs(text).some(([t, k]) => t === 'task_create' && k === 'acceptance.verdict'), 'acceptance.verdict is extracted');
  });
}

test('the memory-lever text names only tools and fields the matching listing has', () => {
  assert.ok(check('MEMORY_USE_NOTES', L.MEMORY_USE_NOTES, ALL_ON) >= 5, "the extraction should find query, namespace, kind, title, when, basis, text");
  check('MEMORY_REPORT_LINE', L.MEMORY_REPORT_LINE, ALL_ON);
  check('MEMORY_VERIFY_RULE', L.MEMORY_VERIFY_RULE, BASE);
  assert.ok(check('MEMORY_QUERIES_LINE', L.MEMORY_QUERIES_LINE, ALL_ON, 'worker_spawn') >= 1);
});

test('the drift check fails loudly on a missing field, a field on a tool without it, and a missing tool', () => {
  const noVerdict = BASE.map((t) => {
    if (t.name !== 'task_create') return t;
    const c = JSON.parse(JSON.stringify(t));
    delete c.inputSchema.properties.acceptance.properties.verdict;
    return c;
  });
  const p = fs.readFileSync(path.join(PROMPTS, 'orchestrator.md'), 'utf8').replace(/\{\{[^}]*\}\}/g, '');
  assert.throws(() => check('x', p, noVerdict), /task_create\.acceptance\.verdict/);
  assert.throws(() => check('x', 'call `mcp__belay__memory_list` with `text`', BASE), /memory_list\.text/);
  assert.throws(() => check('x', 'call `mcp__belay__no_such_tool`', BASE), /no_such_tool \(tool not in the listing\)/);
});

test('A5 the largest orchestrator listing (every lever on) is inside the 11,264 byte budget', () => {
  const bytes = tools.listingBytes('orchestrator', { notes: true, knowledge: true, queries: true });
  assert.ok(bytes <= 11264, `everything-on orchestrator listing is ${bytes} bytes, over 11264 by ${bytes - 11264}`);
});
