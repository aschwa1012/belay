'use strict';
// core-method.cjs: moved verbatim out of belay-mcp.cjs to keep it under its line budget.


// The contract names Core methods with dots. Whether the module hangs them off nested namespaces
// (core.memory.store), flat dotted keys or camelCase is not stated, so all three are accepted and a
// method that is genuinely absent fails loudly with E_INTERNAL naming it.
function resolveCoreMethod(c, dotted) {
  const parts = dotted.split('.');
  let owner = c;
  let cur = c;
  for (const p of parts) {
    if (cur == null) { cur = undefined; break; }
    owner = cur;
    cur = cur[p];
  }
  if (typeof cur === 'function') return cur.bind(owner);
  if (typeof c[dotted] === 'function') return c[dotted].bind(c);
  const camel = parts[0] + parts.slice(1).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  if (typeof c[camel] === 'function') return c[camel].bind(c);
  return null;
}

const fail = (code, message, detail) => {
  const e = new Error(message);
  e.code = code;
  if (detail !== undefined) e.detail = detail;
  return e;
};


module.exports = { resolveCoreMethod, fail };
