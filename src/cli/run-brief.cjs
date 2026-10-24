'use strict';
// run-brief.cjs — a spec's brief_file: belay renders its own shipped template for the run's mode and appends the operator's
// brief under a heading, so an upgrade refreshes the prompt with no operator action. The template gets the lever
// substitution; the brief is appended after it and passes through as written.

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = { headless: 'orchestrator.md', interactive: 'orchestrator-interactive.md' };
const PROMPTS_DIR = path.join(__dirname, '..', 'run', 'prompts');
const HEADING = '## Your brief';

// { file, text } of belay's template for the mode.
function shippedTemplate(mode) {
  const file = path.join(PROMPTS_DIR, TEMPLATE[mode] || TEMPLATE.headless).split(path.sep).join('/');
  return { file, text: fs.readFileSync(file, 'utf8') };
}

// The prompt text: the (substituted) template, then the brief.
function appendBrief(templateText, briefText) {
  return `${String(templateText).replace(/\s+$/, '')}\n\n${HEADING}\n\n${String(briefText).replace(/^\s+|\s+$/g, '')}\n`;
}

module.exports = { shippedTemplate, appendBrief, HEADING, TEMPLATE };
