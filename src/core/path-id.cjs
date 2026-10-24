'use strict';
// path-id.cjs — pure. The one grammar for an id that becomes a path component (a worker id, a run id): it is checked before any file or row is written.
// Letters, digits, dot, underscore and hyphen; the first character is a letter or digit; at most 64 characters; no `..` anywhere. No separator, drive colon, NUL or space can pass.
const PATH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PATH_ID_GRAMMAR = 'letters, digits, ".", "_" and "-", starting with a letter or digit, 1 to 64 characters, with no ".."';
const isPathId = (id) => typeof id === 'string' && PATH_ID_RE.test(id) && !id.includes('..');
// The E_ARGS message for a bad id; `field` names what the caller passed.
const pathIdMessage = (field, id) => `${field} ${JSON.stringify(String(id).slice(0, 80))} is not a valid id: use ${PATH_ID_GRAMMAR}`;
module.exports = { PATH_ID_RE, PATH_ID_GRAMMAR, isPathId, pathIdMessage };
