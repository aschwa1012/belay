'use strict';
// model-switch.cjs: the substrate moved a session to another model (Claude Code's `model_refusal_fallback` system event).
// belay records the fact and shows it; it decides nothing. Pure: no requires, safe on any read path.
// shape(ev) -> the stored { at, from, to, trigger, scope, category }; line(who, fb) -> one short line.

const short = (m) => String(m).replace(/^claude-/, '');

function shape(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const s = (x) => (typeof x === 'string' && x ? x : null);
  return { at: Number.isFinite(ev.at) ? ev.at : null, from: s(ev.from), to: s(ev.to), trigger: s(ev.trigger), scope: s(ev.scope), category: s(ev.category) };
}

function line(who, fb) {
  if (!fb || typeof fb !== 'object') return null;
  const how = fb.trigger === 'refusal' || fb.trigger == null ? 'refusal fallback' : `${String(fb.trigger).slice(0, 40)} fallback`;
  const when = Number.isFinite(fb.at) ? ` at ${new Date(fb.at).toISOString()}` : '';
  return `${who ? `${who}: ` : ''}model switched: ${fb.from ? short(fb.from) : 'unknown'} -> ${fb.to ? short(fb.to) : 'unknown'} (${how})${when}`;
}

module.exports = { shape, line };
