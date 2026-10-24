'use strict';
// run-prompt-check.cjs — the staleness warning for a run's prompt_file. A spec's prompt_file is the operator's own copy of a
// shipped template; an upgrade never refreshes it. belay reads it as is, so a copy from before a placeholder existed gets
// the old wording (a notes run once hit E_NOTE_SHAPE that way). This only warns, never refuses. Two checks:
//   (a) the `<!-- belay-prompt X.Y.Z -->` line: missing, or older than the shipped template's;
//   (b) with notes on, a placeholder the lever code substitutes in the shipped template and the copy lacks. The list is
//       derived by running substituteLevers over both texts, so it follows the code, not a hand-kept list.
// Pure but for reading the shipped template. The marker line stays in the prompt, as belay-mode does.

const fs = require('node:fs');
const path = require('node:path');
const { substituteLevers } = require('./run-levers.cjs');

const MARKER_RE = /<!--\s*belay-prompt\s+(\d+(?:\.\d+)*)\s*-->/;
const TEMPLATE = { headless: 'orchestrator.md', interactive: 'orchestrator-interactive.md' };
const PROMPTS_DIR = path.join(__dirname, '..', 'run', 'prompts');

function markerVersion(text) {
  const m = MARKER_RE.exec(String(text));
  return m ? m[1] : null;
}

// -1, 0, 1 by numeric segments.
function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Returns an array of { code, message } (empty when the copy is current). `opts.templateText` is for tests.
function checkPrompt({ promptText, promptFile, mode, levers, timeoutMs }, opts = {}) {
  const name = TEMPLATE[mode] || TEMPLATE.headless;
  let shipped;
  try { shipped = opts.templateText !== undefined ? opts.templateText : fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8'); }
  catch { return []; } // no template to compare with: nothing to say
  const fix = `copy src/run/prompts/${name} again and re-add your brief`;
  const out = [];
  const have = markerVersion(promptText), want = markerVersion(shipped);
  if (want) {
    if (!have) out.push({ code: 'prompt_no_marker', message: `prompt_file ${promptFile} has no "<!-- belay-prompt ${want} -->" line, so it is a copy from before belay versioned its templates and may be stale; ${fix}` });
    else if (compareVersions(have, want) < 0) out.push({ code: 'prompt_older', message: `prompt_file ${promptFile} is from template version ${have}, belay's is ${want}; ${fix}` });
  }
  if (levers && levers.memory_levers && levers.memory_levers.notes) {
    const sub = (t) => substituteLevers(t, levers, mode === 'interactive' ? 0 : timeoutMs || 0, { mode }).substituted;
    const need = Object.keys(sub(shipped)), got = sub(promptText);
    const missing = need.filter((k) => !got[k]);
    if (missing.length) out.push({ code: 'prompt_missing_placeholders', missing, message: `prompt_file ${promptFile} lacks ${missing.map((k) => `{{${k}}}`).join(', ')}, which this run's memory notes need, so the orchestrator gets the old wording; ${fix}` });
  }
  return out;
}

module.exports = { checkPrompt, markerVersion, compareVersions, MARKER_RE };
