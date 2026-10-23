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
  const want = ['hooks/panel/index.tsx:dispatchReview', 'hooks/panel/index.tsx:runJson', 'hooks/panel/index.tsx:settlePress'];
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
  only('RUN_FLAG', /\bRUN_FLAG\b/g, ['RUN_FLAG', 'dispatchReview'], 'hooks/panel/index.tsx'); // the review's `--run <id>`: declared once, used once
  const disp = refs(/\bdispatchReview\b/g).filter((r) => !/function\s+dispatchReview/.test(r.line));
  if (JSON.stringify(where(disp)) !== JSON.stringify(['hooks/panel/index.tsx:reviewPress'])) bad.push(`dispatchReview is called from ${JSON.stringify(where(disp))}; only reviewPress may`);
  const press = refs(/\breviewPress\b/g).filter((r) => !/function\s+reviewPress/.test(r.line));
  if (JSON.stringify(where(press)) !== JSON.stringify(['hooks/panel/index.tsx:acts']) || !press.every((r) => /^\s*review:\s*\(\)\s*=>\s*\{\s*void reviewPress\(\$\)\s*\},?\s*$/.test(r.line))) {
    bad.push(`reviewPress is named in ${JSON.stringify(where(press))}; only the \`review\` handler of acts() may call it`);
  }

  // 2b. The review launcher's argv, checked on the MASKED code of dispatchReview (comments and strings blanked, so a copy in a comment counts for nothing): first
  // [...REVIEW_ARGS, project, START_FLAG] with no run, then at most once more with `--run <watch.runId>` when the launcher said the one run with notes on is live.
  // Exactly one $.process.run, the attempts list is declared once and never changed, and the retry is gated by needsRun on the launcher's own answer.
  const di = info['hooks/panel/index.tsx'];
  if (di) {
    const k = di.its.findIndex((it) => it.name === 'dispatchReview');
    const dcode = k < 0 ? '' : di.code.slice(di.its[k].start, di.its[k + 1] ? di.its[k + 1].start : undefined);
    if (!/const attempts\s*:\s*string\[\]\[\]\s*=\s*\[\s*\[\s*\]\s*,\s*\.\.\.\(\s*watch\.runId\s*\?\s*\[\s*\[\s*RUN_FLAG\s*,\s*watch\.runId\s*\]\s*\]\s*:\s*\[\s*\]\s*\)\s*\]/.test(dcode) || (dcode.match(/\battempts\b\s*[:=]/g) || []).length !== 1) bad.push('dispatchReview: attempts is not exactly [[], ...(watch.runId ? [[RUN_FLAG, watch.runId]] : [])]');
    if (!/for\s*\(\s*const runArg of attempts\s*\)/.test(dcode) || !/argvFor\(\s*r\.cli\s*,\s*\[\s*\.\.\.REVIEW_ARGS\s*,\s*project\s*,\s*START_FLAG\s*,\s*\.\.\.runArg\s*\]\s*,\s*watch\.dataDir\s*\)/.test(dcode)) bad.push('dispatchReview: the review argv is not exactly [...REVIEW_ARGS, project, START_FLAG, ...runArg] over attempts');
    if ((dcode.match(/\$\.process\.run\(/g) || []).length !== 1) bad.push('dispatchReview: there is not exactly one $.process.run');
    if (!/if\s*\(\s*!needsRun\(\s*res\.exitCode\s*,\s*res\.stdout\s*,\s*res\.stderr\s*\)\s*\)\s*break/.test(dcode)) bad.push('dispatchReview: the retry is not gated by needsRun on the launcher answer');
    if (/\b(?:attempts|runArg)\s*(?:\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|length)\b|\[[^\]]*\]\s*=(?!=)|=(?!=))/.test(dcode)) bad.push('dispatchReview: runArg or attempts is changed after it is declared');
  }
  // 3. act.review (any spelling of a `review` member) is the onPress of one Button keyed review in view.tsx, and nowhere else.
  const members = refs(/\.\s*review\b/g);
  const brackets = [];
  for (const [f, o] of Object.entries(info)) for (const l of o.lits) if (l.text === 'review' && /\[\s*$/.test(o.code.slice(Math.max(0, l.at - 8), l.at))) brackets.push({ f, owner: ownerOf(o.its, l.at) });
  if (brackets.length) bad.push(`bracket access to ['review'] in ${JSON.stringify(where(brackets))}`);
  const okMember = members.length === 1 && members[0].f === 'hooks/panel/view.tsx' && /<Button key="review".*onPress=\{act\.review\}/.test(members[0].orig);
  if (!okMember) bad.push(`a \`.review\` member is used in ${JSON.stringify(where(members))}; only view.tsx's Button keyed review may (onPress={act.review})`);

  // 3b. The settle write (the second and last): `belay memory held settle <id> --archive|--release|--reoffer --reason <x> --json [--data d]`.
  // settleArgs (held.ts) builds exactly that array, settlePress (index.tsx) is its one caller and runs it, acts() has the one handler that calls
  // settlePress, and view.tsx's SettleRow has the one Button that calls act.settle. Nothing else names any of them.
  const held = info['hooks/panel/held.ts'];
  if (!held || !/export const settleArgs = \(action: SettleAction, id: string, reason: string\): string\[\] => \['memory', 'held', 'settle', id, `--\$\{action\}`, '--reason', reason\]\s*\n/.test(held.text)) bad.push('settleArgs in hooks/panel/held.ts is not exactly the literal settle argv');
  const sa = refs(/\bsettleArgs\b/g).filter((r) => !/^\s*import\b/.test(r.line) && !/^\s*(?:export\s+)?(?:async\s+)?(?:function|const)\s+settleArgs\b/.test(r.line));
  if (JSON.stringify(where(sa)) !== JSON.stringify(['hooks/panel/index.tsx:settlePress']) || !sa.every((r) => /\$\.process\.run\(argvFor\(r\.cli, settleArgs\(action, id, reason\), watch\.dataDir\), \{ timeoutMs: START_TIMEOUT_MS, \.\.\.\(cwd \? \{ cwd \} : \{\}\) \}\)/.test(r.orig))) bad.push(`settleArgs is used in ${JSON.stringify(where(sa))}; only settlePress may run it, as argvFor(r.cli, settleArgs(action, id, reason), watch.dataDir)`);
  // 3c. No second declaration of the argv builders: exactly one `settleArgs` (held.ts) and one `argvFor` (fetch.ts) exist in the whole mod, at the top level or
  // as a local, and index.tsx imports each from its file. `r` in both write chains comes from `await resolveCli($, watch)` and is never changed.
  const declOf = (name) => { const out = []; for (const [f, o] of Object.entries(info)) for (const m of o.code.matchAll(new RegExp(`\\b(?:function|const|let|var|class)\\s+${name}\\b|[({,]\\s*${name}\\s*[:=)]`, 'g'))) out.push(`${f}:${ownerOf(o.its, m.index)}`); return out; };
  for (const [name, file] of [['settleArgs', 'hooks/panel/held.ts'], ['argvFor', 'hooks/panel/fetch.ts']]) {
    const d = declOf(name);
    if (d.length !== 1 || !d[0].startsWith(`${file}:`)) bad.push(`${name} is declared in ${JSON.stringify(d)}; exactly one declaration, in ${file}, is allowed`);
    const mod = name === 'settleArgs' ? './held' : './fetch';
    if (!info['hooks/panel/index.tsx'] || !new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'${mod.replace('.', '\\.')}'`).test(info['hooks/panel/index.tsx'].text)) bad.push(`hooks/panel/index.tsx does not import ${name} from '${mod}'`);
  }
  for (const [fn, o] of [['dispatchReview', info['hooks/panel/index.tsx']], ['settlePress', info['hooks/panel/index.tsx']]]) {
    if (!o) continue;
    const at = o.its.findIndex((it) => it.name === fn);
    const body = at < 0 ? '' : o.code.slice(o.its[at].start, o.its[at + 1] ? o.its[at + 1].start : undefined);
    const text = at < 0 ? '' : o.text.slice(o.its[at].start, o.its[at + 1] ? o.its[at + 1].start : undefined);
    if (!/\bconst r = await resolveCli\(\$, watch\)/.test(text)) bad.push(`${fn}: \`r\` is not \`const r = await resolveCli($, watch)\``);
    if ((body.match(/\bconst r\b|\blet r\b|\bvar r\b/g) || []).length !== 1) bad.push(`${fn}: \`r\` is declared other than once`);
    if (/\br\s*(?:=(?!=)|\+=)|\br\s*\.\s*cli\s*(?:=(?!=)|\+=|\.\s*(?:splice|push|pop|shift|unshift|sort|reverse|fill|copyWithin|length\s*=)\b|\[[^\]]*\]\s*=(?!=))|\br\s*\.\s*cli\s*\[[^\]]*\]\s*=(?!=)|\bObject\s*\.\s*assign\(\s*r\b/.test(body.replace(/\bconst r = await/, 'const q = await'))) bad.push(`${fn}: \`r\` or \`r.cli\` is changed after resolveCli`);
  }

  const sp = refs(/\bsettlePress\b/g).filter((r) => !/function\s+settlePress/.test(r.line));
  if (JSON.stringify(where(sp)) !== JSON.stringify(['hooks/panel/index.tsx:acts']) || !sp.every((r) => /^\s*commit:\s*id\s*=>\s*\{\s*void settlePress\(\$, id\)\s*\},?\s*$/.test(r.line))) bad.push(`settlePress is named in ${JSON.stringify(where(sp))}; only the \`commit\` handler of acts() (the confirm button of the pending settle) may call it`);
  const sm = refs(/\.\s*settle\b/g);
  if (!(sm.length === 1 && sm[0].f === 'hooks/panel/view.tsx' && sm[0].owner === 'SettleRow' && /<Button key=\{`\$\{a\}-\$\{n\.id\}`\}.*onPress=\{\(\) => act\.settle\(a, n\.id\)\}/.test(sm[0].orig))) bad.push(`a \`.settle\` member is used in ${JSON.stringify(where(sm))}; only SettleRow's Button may (onPress={() => act.settle(a, n.id)})`);
  // The confirm button is the only way to settlePress: one `.commit` member in the whole mod, SettleRow's Button keyed commit.
  const cm = refs(/\.\s*commit\b/g);
  if (!(cm.length === 1 && cm[0].f === 'hooks/panel/view.tsx' && cm[0].owner === 'SettleRow' && /<Button key=\{`commit:\$\{n\.id\}`\}.*onPress=\{\(\) => act\.commit\(n\.id\)\}/.test(cm[0].orig))) bad.push(`a \`.commit\` member is used in ${JSON.stringify(where(cm))}; only SettleRow's Button keyed commit may (onPress={() => act.commit(n.id)})`);
  // M2. `commit` and `review` are the two handlers that reach a write. As identifiers they appear only in the Act type, in the acts() lines and as the one
  // `.member` of each pinned Button; as string literals `commit` never appears and `review` only where check 6 allows; and an Act is never destructured,
  // indexed by name, spread or enumerated (Object.values/entries/keys/assign over it).
  for (const name of ['commit', 'review']) {
    const decl = new RegExp(String.raw`^\s*${name}:\s*\(`);
    const handler = new RegExp(String.raw`^\s*${name}:\s*(?:\(\)|id)\s*=>\s*\{`);
    for (const r of refs(new RegExp(String.raw`\b${name}\b`, 'g'))) {
      if (r.f === 'hooks/panel/base.tsx' && decl.test(r.line)) continue;
      if (r.f === 'hooks/panel/index.tsx' && r.owner === 'acts' && handler.test(r.line)) continue;
      if (!new RegExp(String.raw`(?<![.\w])${name}\b`).test(r.line)) continue; // only the pinned `.member` uses remain on the line (checked above)
      bad.push(`${r.f}:${r.owner}: \`${name}\` is named other than in the Act type, the acts() handler and the one pinned Button: ${r.line.trim().slice(0, 70)}`);
    }
  }
  for (const [f, o] of Object.entries(info)) {
    if (f.startsWith('hooks/wake/')) continue;
    if (/\bReflect\s*\./.test(o.code)) bad.push(`${f}: Reflect is used (an Act handler could be reached by name)`);
    for (const m of o.code.matchAll(/\bfor\s*\([^)]*\bin\s+(?:[\w$]+\s*\.\s*)*acts?\b/g)) bad.push(`${f}:${ownerOf(o.its, m.index)}: for...in over an Act`);
    if (/[\w$]\\u(?:[0-9a-fA-F]|\{)|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})[\w$]/.test(o.code.replace(/\[[^\]\n]*\]/g, ''))) bad.push(`${f}: a \\u escape in code (an identifier spelled by escape would hide a handler name)`);
    for (const m of o.code.matchAll(/\$\s*\.\s*state\b/g)) bad.push(`${f}:${ownerOf(o.its, m.index)}: $.state is used; the panel reaches its state only through the atoms (read/update)`);
    for (const l of o.lits) if (l.text === 'commit') bad.push(`${f}:${ownerOf(o.its, l.at)}: the string "commit" appears (an Act handler reached by name)`);
    for (const m of o.code.matchAll(/\bObject\s*\.\s*(?:values|entries|keys|getOwnPropertyNames|getOwnPropertyDescriptors|assign|fromEntries)\s*\(\s*(?:[\w$]+\s*\.\s*)*acts?\b|\.\.\.\s*acts?\b|\bacts?\s*\[/g)) bad.push(`${f}:${ownerOf(o.its, m.index)}: an Act is enumerated, spread or indexed by name: ${o.text.slice(m.index, m.index + 40).trim()}`);
  }
  // S6. The pending settle is written in two places only: settleStart (stage 'reason', an empty reason) and reasonSubmit (stage 'confirm'); every other write clears it.
  const ix = info['hooks/panel/index.tsx'];
  if (ix) {
    for (const m of ix.text.matchAll(/update\s*\(\s*\$\s*,\s*settleA\s*,(?!\s*\(\s*\)\s*=>\s*null)/g)) { const ow = ownerOf(ix.its, m.index); if (!['settleStart', 'reasonSubmit'].includes(ow)) bad.push(`hooks/panel/index.tsx:${ow}: settleA is written with a value outside settleStart and reasonSubmit`); }
    for (const m of ix.text.matchAll(/stage\s*:\s*['"]confirm['"]/g)) { const ow = ownerOf(ix.its, m.index); if (ow !== 'reasonSubmit') bad.push(`hooks/panel/index.tsx:${ow}: stage 'confirm' is written outside reasonSubmit`); }
    const at = ix.its.findIndex((it) => it.name === 'settleStart');
    const st = at < 0 ? '' : ix.text.slice(ix.its[at].start, ix.its[at + 1] ? ix.its[at + 1].start : undefined);
    if (!/update\s*\(\s*\$\s*,\s*settleA\s*,\s*\(\s*\)\s*=>\s*\(\s*\{\s*id\s*,\s*action\s*,\s*stage\s*:\s*['"]reason['"]\s*,\s*reason\s*:\s*(?:''|"")\s*,\s*title\s*:\s*listed\.title\s*,/.test(st)) bad.push("settleStart does not write stage 'reason' with an empty reason");
  }
  // The interactive orchestrator has no AskUserQuestion: nothing in the mod asks a dialog, and the tool is not named.
  for (const [f, o] of Object.entries(info)) {
    if (/\bui\s*\.\s*ask\b|\bask\s*\(\s*\{|AskUserQuestion/.test(o.code) || o.lits.some((l) => l.text === 'AskUserQuestion')) bad.push(`${f}: a dialog is asked (ui.ask or AskUserQuestion); the session has no such tool`);
  }
  for (const [f, o] of Object.entries(info)) {
    if (f.startsWith('hooks/wake/')) continue;
    for (const l of o.lits) {
      if (!['settle', 'held'].includes(l.text)) continue;
      const owner = ownerOf(o.its, l.at);
      if (f === 'hooks/panel/held.ts' && owner === 'settleArgs') continue;
      if (f === 'hooks/panel/index.tsx' && (owner === 'fetchSnapshot' || owner === 'AWAITING_READ') && l.text === 'held') continue;
      if (/key=\s*$|startsWith\(\s*$/.test(o.text.slice(Math.max(0, l.at - 14), l.at))) continue;
      bad.push(`${f}:${owner}: the string ${JSON.stringify(l.text)} appears outside the settle argv and the awaiting read`);
    }
  }

  // 4. Nothing outside the panel names the chain, and no module crosses between the wake and the panel.
  for (const [f, o] of Object.entries(info)) {
    if (!f.startsWith('hooks/panel/') && /\b(dispatchReview|reviewPress|REVIEW_ARGS|START_FLAG|RUN_FLAG|settlePress|settleArgs)\b/.test(o.code)) bad.push(`${f} names the review launcher or the settle writer`);
    const imports = [...o.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (f.startsWith('hooks/wake/') && imports.some((p) => /panel/.test(p))) bad.push(`${f} imports from the panel: ${imports.filter((p) => /panel/.test(p)).join(', ')}`);
    if (f.startsWith('hooks/panel/') && imports.some((p) => /wake/.test(p))) bad.push(`${f} imports from the wake: ${imports.filter((p) => /wake/.test(p)).join(', ')}`);
  }

  // 5. The panel (everything but the wake, whose job is to inject text) writes no file and reaches no model, tool or session.
  for (const r of refs(/\$\s*\.\s*(?:prompt\s*\.\s*submit|agent\s*\.\s*spawn|tool\s*\.\s*call|session\s*\.\s*append|fs\s*\.\s*(?:write|append|remove|rename|mkdir)\w*)\b/g).filter((r) => !r.f.startsWith('hooks/wake/'))) bad.push(`${r.f}:${r.owner}: a write or a model-facing call: ${r.line.trim().slice(0, 80)}`);

  // 5b. The poll round (tick) is started by the timer alone: a press must not start a read.
  const tk = refs(/\btick\b/g).filter((r) => !/function\s+tick\b/.test(r.line));
  if (JSON.stringify(where(tk)) !== JSON.stringify(['hooks/panel/index.tsx:ensureTicker']) || !tk.every((r) => /timer = \$\.clock\.every\(1000, \(\) => \{ void tick\(\$\) \}\)/.test(r.line))) bad.push(`tick is named in ${JSON.stringify(where(tk))}; only the timer in ensureTicker may start a round`);

  // 6. The generic read helper runs reads only, and no spelling reaches the launcher's words or the host object by a computed name.
  const READS = /^runJson\(\$,\s*cli,\s*(?:\['(?:agents|notices|transcript|settings)'|\['memory', 'held', '--awaiting'\],)/;
  for (const [f, o] of Object.entries(info)) {
    for (const m of o.code.matchAll(/\brunJson\s*\(/g)) {
      if (/function\s+$/.test(o.code.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (!READS.test(o.text.slice(m.index, m.index + 80))) bad.push(`${f}:${ownerOf(o.its, m.index)}: runJson is called other than with a literal read verb (agents, notices, transcript, settings, or memory held --awaiting)`);
      else if (ownerOf(o.its, m.index) !== 'fetchSnapshot') bad.push(`${f}:${ownerOf(o.its, m.index)}: runJson is called outside fetchSnapshot; a press runs no read`);
    }
    if (f.startsWith('hooks/wake/')) continue;
    for (const m of o.code.matchAll(/\$\s*\[|\(\s*\$\s+as\b|=\s*\$\s*(?:as\b[^;\n]*)?(?:[;\n]|$)/g)) bad.push(`${f}:${ownerOf(o.its, m.index)}: the host object is reached by a computed member, a cast or an alias: ${o.text.slice(m.index, m.index + 30).trim()}`);
    for (const l of o.lits) {
      if (!['review', '--start', '--run'].includes(l.text)) continue;
      const owner = ownerOf(o.its, l.at), before = o.text.slice(Math.max(0, l.at - 14), l.at);
      if (owner === 'REVIEW_ARGS' || owner === 'START_FLAG' || owner === 'RUN_FLAG') continue;
      if (/key=\s*$/.test(before) || /startsWith\(\s*$/.test(before)) continue; // the Button's key, and a role-name test
      bad.push(`${f}:${owner}: the string ${JSON.stringify(l.text)} appears outside the launcher's declarations`);
    }
  }

  // 7. (Where the value comes FROM is the other half, and it is pinned by the plugin test 'belay-run.json naming orchestrator_dir passes it to the
  // agents read as --dir' in src/mod/tests/panel.test.ts: the argv's --dir equals belay-run.json's orchestrator_dir and is never data_dir.)
  // The agents read may name the orchestrator's directory (`--dir`, so `belay agents` finds the launch marker of a run whose spec set
  // orchestrator_dir), and only the watch's own, from belay-run.json: exactly one `--dir` literal exists in the mod, it is in the one agents
  // call in fetchSnapshot, that call is the literal below, and inside fetchSnapshot `orchDir` is only ever `watch.orchDir`.
  const AGENTS_CALL = "runJson($, cli, ['agents', ...(watch.runId ? [watch.runId] : []), ...(watch.orchDir ? ['--dir', watch.orchDir] : [])], watch.dataDir)";
  const dirLits = [];
  for (const [f, o] of Object.entries(info)) for (const l of o.lits) if (l.text === '--dir') dirLits.push(`${f}:${ownerOf(o.its, l.at)}`);
  if (JSON.stringify(dirLits) !== JSON.stringify(['hooks/panel/index.tsx:fetchSnapshot'])) bad.push(`the string "--dir" appears in ${JSON.stringify(dirLits)}; it may appear once, in fetchSnapshot's agents read`);
  const idx = info['hooks/panel/index.tsx'];
  if (idx) {
    const fs0 = idx.its.find((it) => it.name === 'fetchSnapshot');
    const next = fs0 ? idx.its.find((it) => it.start > fs0.start) : null;
    const body = fs0 ? idx.text.slice(fs0.start, next ? next.start : undefined) : '';
    if (!body.includes(AGENTS_CALL)) bad.push('the agents read in fetchSnapshot is not exactly the literal call with --dir taken from watch.orchDir');
    for (const m of body.matchAll(/\borchDir\b/g)) if (body.slice(Math.max(0, m.index - 6), m.index) !== 'watch.') bad.push('orchDir is used in fetchSnapshot other than as watch.orchDir');
  }
  return bad;
}

module.exports = { analyze, mask, items };
