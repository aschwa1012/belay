'use strict';
// panel-review-guard.cjs — a structural check of the mod's sources, used by panel-review-wiring.test.cjs (not a test file itself).
// The panel's one write action (the memory line's review button) must be reachable from the button's onPress and from nothing else.
// The check works on the code, not on lines: comments and string contents are masked, every top-level item (function or const) is a
// node, and it asserts WHICH items name the launcher's pieces, so an alias, a destructuring, a bracket access or a helper elsewhere in
// src/mod is a violation however it is spelled. The chain it proves:
//   view.tsx  <Button key="review" onPress={act.review}>  ->  index.tsx acts().review  ->  reviewPress  ->  dispatchReview  ->  $.process.run(... REVIEW_ARGS ...)

// Comments and the inside of string and template literals become spaces (same length, same newlines); `${...}` code inside a template
// stays code. Returns { code, lits } where lits are the string literals as { at, text }.
function mask(src) {
  const lits = [];
  const out = [];
  let i = 0;
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k += 1) out.push(src[k] === '\n' ? '\n' : ' '); };
  function template() { // at the opening backtick; returns when the closing one is consumed
    out.push('`'); i += 1;
    const start = i;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { blank(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { out.push('$', '{'); i += 2; code(true); continue; }
      blank(i, i + 1); i += 1;
    }
    lits.push({ at: out.length, text: src.slice(start, i) });
    out.push('`'); i += 1;
  }
  function code(untilClose) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j += 1; j += 1; }
        lits.push({ at: out.length, text: src.slice(i + 1, j) });
        out.push(c); blank(i + 1, j); out.push(c); i = j + 1; continue;
      }
      if (c === '`') { template(); continue; }
      if (c === '{') depth += 1;
      if (c === '}') { if (untilClose && depth === 0) { out.push('}'); i += 1; return; } depth -= 1; }
      out.push(c); i += 1;
    }
  }
  code(false);
  return { code: out.join(''), lits };
}

const TOP = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+|type\s+|interface\s+)(\w+)/gm;
// The top-level items of a masked file: { name, start }, in order. A column-0 declaration starts an item and ends the one before it.
function items(code) {
  const out = [];
  for (const m of code.matchAll(TOP)) out.push({ name: m[1], start: m.index });
  return out;
}
const ownerOf = (its, pos) => { let o = '<module>'; for (const it of its) { if (it.start <= pos) o = it.name; else break; } return o; };

const rel = (f) => f.replace(/\\/g, '/');
const isTest = (f) => /(^|\/)(tests|types)\//.test(rel(f));

// files: { 'hooks/panel/index.tsx': text, ... } (paths relative to src/mod, tests and types excluded by the caller or here).
// Returns the violations as strings; [] when the wiring holds.
function analyze(files) {
  const bad = [];
  const info = {};
  for (const [f, text] of Object.entries(files)) {
    if (isTest(f)) continue;
    const m = mask(text);
    info[rel(f)] = { ...m, its: items(m.code), text };
  }
  const refs = (re) => {
    const out = [];
    for (const [f, o] of Object.entries(info)) {
      for (const m of o.code.matchAll(re)) {
        const a = o.code.lastIndexOf('\n', m.index) + 1, e = o.code.indexOf('\n', m.index);
        out.push({ f, owner: ownerOf(o.its, m.index), at: m.index, line: o.code.slice(a, e < 0 ? undefined : e), orig: o.text.slice(a, e < 0 ? undefined : e) });
      }
    }
    return out;
  };
  const where = (rs) => rs.map((r) => `${r.f}:${r.owner}`).sort();

  // 1. Every `process` is `$.process.run(` or `$.process.spawn(`; no bracket access, no alias, no destructuring.
  const procCalls = { run: [], spawn: [] };
  for (const [f, o] of Object.entries(info)) {
    for (const m of o.code.matchAll(/\bprocess\b/g)) {
      const before = o.code.slice(Math.max(0, m.index - 2), m.index);
      const after = /^\s*\.\s*(run|spawn)\s*\(/.exec(o.code.slice(m.index + 7));
      if (before === '$.' && after) procCalls[after[1]].push({ f, owner: ownerOf(o.its, m.index) });
      else bad.push(`${f}:${ownerOf(o.its, m.index)}: \`process\` is used other than as $.process.run( or $.process.spawn(`);
    }
    for (const l of o.lits) if (['process', 'spawn', 'run'].includes(l.text) && /\[\s*$/.test(o.code.slice(Math.max(0, l.at - 12), l.at))) bad.push(`${f}: bracket access to ${JSON.stringify(l.text)}`);
  }
  const spawns = where(procCalls.spawn), runs = where(procCalls.run);
  if (!spawns.every((s) => s.startsWith('hooks/wake/index.ts:'))) bad.push(`$.process.spawn is called from ${JSON.stringify(spawns)}; only the wake stream (hooks/wake/index.ts) may spawn`);
  const want = ['hooks/panel/index.tsx:dispatchReview', 'hooks/panel/index.tsx:runJson'];
  if (JSON.stringify(runs) !== JSON.stringify(want)) bad.push(`$.process.run is called from ${JSON.stringify(runs)}; expected exactly ${JSON.stringify(want)}`);

  // 2. The launcher's pieces appear only where the chain says.
  const only = (name, re, owners, files) => {
    const rs = refs(re);
    const got = where(rs);
    if (JSON.stringify(got) !== JSON.stringify(owners.map((o) => `${files}:${o}`).sort())) bad.push(`${name} is named in ${JSON.stringify(got)}; expected ${JSON.stringify(owners.map((o) => `${files}:${o}`))}`);
    return rs;
  };
  only('REVIEW_ARGS', /\bREVIEW_ARGS\b/g, ['REVIEW_ARGS', 'dispatchReview'], 'hooks/panel/index.tsx'); // its declaration and its one use
  only('START_FLAG', /\bSTART_FLAG\b/g, ['START_FLAG', 'dispatchReview'], 'hooks/panel/index.tsx');
  const disp = refs(/\bdispatchReview\b/g).filter((r) => !/function\s+dispatchReview/.test(r.line));
  if (JSON.stringify(where(disp)) !== JSON.stringify(['hooks/panel/index.tsx:reviewPress'])) bad.push(`dispatchReview is called from ${JSON.stringify(where(disp))}; only reviewPress may`);
  const press = refs(/\breviewPress\b/g).filter((r) => !/function\s+reviewPress/.test(r.line));
  if (JSON.stringify(where(press)) !== JSON.stringify(['hooks/panel/index.tsx:acts']) || !press.every((r) => /^\s*review:\s*\(\)\s*=>\s*\{\s*void reviewPress\(\$\)\s*\},?\s*$/.test(r.line))) {
    bad.push(`reviewPress is named in ${JSON.stringify(where(press))}; only the \`review\` handler of acts() may call it`);
  }

  // 3. act.review (any spelling of a `review` member) is the onPress of one Button keyed review in view.tsx, and nowhere else.
  const members = refs(/\.\s*review\b/g);
  const brackets = [];
  for (const [f, o] of Object.entries(info)) for (const l of o.lits) if (l.text === 'review' && /\[\s*$/.test(o.code.slice(Math.max(0, l.at - 8), l.at))) brackets.push({ f, owner: ownerOf(o.its, l.at) });
  if (brackets.length) bad.push(`bracket access to ['review'] in ${JSON.stringify(where(brackets))}`);
  const okMember = members.length === 1 && members[0].f === 'hooks/panel/view.tsx' && /<Button key="review".*onPress=\{act\.review\}/.test(members[0].orig);
  if (!okMember) bad.push(`a \`.review\` member is used in ${JSON.stringify(where(members))}; only view.tsx's Button keyed review may (onPress={act.review})`);

  // 4. Nothing outside the panel names the chain, and no module crosses between the wake and the panel.
  for (const [f, o] of Object.entries(info)) {
    if (!f.startsWith('hooks/panel/') && /\b(dispatchReview|reviewPress|REVIEW_ARGS|START_FLAG)\b/.test(o.code)) bad.push(`${f} names the review launcher`);
    const imports = [...o.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (f.startsWith('hooks/wake/') && imports.some((p) => /panel/.test(p))) bad.push(`${f} imports from the panel: ${imports.filter((p) => /panel/.test(p)).join(', ')}`);
    if (f.startsWith('hooks/panel/') && imports.some((p) => /wake/.test(p))) bad.push(`${f} imports from the wake: ${imports.filter((p) => /wake/.test(p)).join(', ')}`);
  }

  // 5. The panel (everything but the wake, whose job is to inject text) writes no file and reaches no model, tool or session.
  for (const r of refs(/\$\s*\.\s*(?:prompt\s*\.\s*submit|agent\s*\.\s*spawn|tool\s*\.\s*call|session\s*\.\s*append|fs\s*\.\s*(?:write|append|remove|rename|mkdir)\w*)\b/g).filter((r) => !r.f.startsWith('hooks/wake/'))) bad.push(`${r.f}:${r.owner}: a write or a model-facing call: ${r.line.trim().slice(0, 80)}`);

  // 6. The generic read helper runs reads only, and no spelling reaches the launcher's words or the host object by a computed name.
  const READS = /^runJson\(\$,\s*cli,\s*\['(agents|notices|transcript|settings)'/;
  for (const [f, o] of Object.entries(info)) {
    for (const m of o.code.matchAll(/\brunJson\s*\(/g)) {
      if (/function\s+$/.test(o.code.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (!READS.test(o.text.slice(m.index, m.index + 80))) bad.push(`${f}:${ownerOf(o.its, m.index)}: runJson is called other than with a literal read verb (agents, notices, transcript, settings)`);
    }
    if (f.startsWith('hooks/wake/')) continue;
    for (const m of o.code.matchAll(/\$\s*\[|\(\s*\$\s+as\b|=\s*\$\s*(?:as\b[^;\n]*)?(?:[;\n]|$)/g)) bad.push(`${f}:${ownerOf(o.its, m.index)}: the host object is reached by a computed member, a cast or an alias: ${o.text.slice(m.index, m.index + 30).trim()}`);
    for (const l of o.lits) {
      if (!['review', '--start'].includes(l.text)) continue;
      const owner = ownerOf(o.its, l.at), before = o.text.slice(Math.max(0, l.at - 14), l.at);
      if (owner === 'REVIEW_ARGS' || owner === 'START_FLAG') continue;
      if (/key=\s*$/.test(before) || /startsWith\(\s*$/.test(before)) continue; // the Button's key, and a role-name test
      bad.push(`${f}:${owner}: the string ${JSON.stringify(l.text)} appears outside the launcher's declarations`);
    }
  }
  return bad;
}

module.exports = { analyze, mask, items };
