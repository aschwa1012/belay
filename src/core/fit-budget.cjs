'use strict';
// fit-budget.cjs: the one renderer for every block belay injects into a worker (ADR 0042 section 1).
// Pure: no clock, no I/O. It drops whole items, never part of one, and always keeps the header and footer.

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

// Cut a string to at most `max` bytes without leaving half a character.
function cutBytes(s, max) {
  if (max <= 0) return '';
  if (bytesOf(s) <= max) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  while (out.length && out.charCodeAt(out.length - 1) === 0xfffd) out = out.slice(0, -1);
  return out;
}

const render = (header, texts, footer) => [header, ...texts, footer].filter((p) => p && p.length).join('\n');

// items: [{ id, text, priority? }] in their natural (oldest first) order.
// drop_order 'oldest' drops from the front; 'priority-then-oldest' drops the lowest priority first, then the oldest.
function fit(items, { max_bytes, header = '', footer = '', drop_order = 'priority-then-oldest' } = {}) {
  if (!Array.isArray(items)) throw new TypeError('fit: items must be an array');
  if (!Number.isInteger(max_bytes) || max_bytes < 0) throw new TypeError('fit: max_bytes must be a non-negative integer');
  if (drop_order !== 'oldest' && drop_order !== 'priority-then-oldest') throw new TypeError(`fit: unknown drop_order ${drop_order}`);

  const frame = render(header, [], footer);
  if (bytesOf(frame) > max_bytes) {
    const text = cutBytes(header, max_bytes);
    return { text, bytes: bytesOf(text), kept: [], dropped: items.length, over_budget: true };
  }

  const order = items.map((it, i) => i);
  if (drop_order === 'priority-then-oldest') {
    order.sort((a, b) => ((items[a].priority || 0) - (items[b].priority || 0)) || (a - b));
  }
  const live = new Set(order);
  const current = () => render(header, items.filter((it, i) => live.has(i)).map((it) => it.text), footer);
  let text = current();
  for (const i of order) {
    if (bytesOf(text) <= max_bytes) break;
    live.delete(i);
    text = current();
  }
  const kept = items.filter((it, i) => live.has(i)).map((it) => it.id);
  return { text, bytes: bytesOf(text), kept, dropped: items.length - kept.length, over_budget: false };
}

module.exports = { fit, cutBytes };
