'use strict';
// model-names.cjs — the names a user may give for a model in the model tables. The Memory menu shows a model by its label
// ("gte-reranker-modernbert-base int8"), the tables key it by its full id ("Alibaba-NLP/gte-reranker-modernbert-base"), so
// a command that takes a model accepts the id, the label, the label's first word, or the id without its owner prefix, compared
// without regard to case. A name that fits more than one model is refused with the candidates named: it is never guessed.

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const norm = (s) => String(s).trim().toLowerCase();

// -> { id } for one model, { ambiguous: [ids] } for several, or null for none. `models` is a table keyed by id.
function resolveModelName(name, models) {
  if (has(models, name)) return { id: name };
  const want = norm(name);
  const hits = [];
  for (const [id, e] of Object.entries(models)) {
    const label = e && e.label ? norm(e.label) : '';
    const forms = [id, id.split('/').pop(), label, label.split(/\s+/)[0]].filter(Boolean).map(norm);
    if (forms.includes(want)) hits.push(id);
  }
  if (hits.length === 1) return { id: hits[0] };
  return hits.length ? { ambiguous: hits } : null;
}

module.exports = { resolveModelName };
