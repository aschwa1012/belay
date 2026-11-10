'use strict';
// wake-ref.cjs — the short delivery reference a claimed wake carries.
//
// A claimed wake is named by its delivery key (the uid, `<worker id>:<key>`), which can run past 100 bytes. The wake line the mod submits
// is capped at WAKE_TEXT_MAX, so the key cannot ride it whole. Both paths (the wake line and worker_wait's exception entry) name the same
// 8 hex characters of sha1(uid), so an orchestrator can match a repeat. The ref is never cut: the body gives way, then the notice.

const crypto = require('node:crypto');

const WAKE_TEXT_MAX = 221; // release-eval.cjs WAKE_TEXT_MAX: the mod's text budget less the plugin name
const HALTED = ' Halted.';

const shortRef = (uid) => crypto.createHash('sha1').update(String(uid)).digest('hex').slice(0, 8);

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const cutBytes = (s, max) => {
  if (max <= 0) return '';
  if (bytes(s) <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
};

// `text (ref <ref>)`, the whole at most `max` bytes with the ref intact. The text is trimmed from its end, keeping a trailing ' Halted.' when it fits.
function withRef(text, ref, max = WAKE_TEXT_MAX) {
  const tail = ` (ref ${ref})`;
  const room = max - bytes(tail);
  if (bytes(text) <= room) return `${text}${tail}`;
  const halt = text.endsWith(HALTED) && bytes(HALTED) <= room ? HALTED : '';
  const body = halt ? text.slice(0, text.length - HALTED.length) : text;
  return `${cutBytes(body, room - bytes(halt))}${halt}${tail}`;
}

module.exports = { shortRef, withRef, WAKE_TEXT_MAX };
