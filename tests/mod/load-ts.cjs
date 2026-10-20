'use strict';
// Loads the panel's TypeScript model from a cjs test by Node's own type stripping (no build step, no dependency). The sources import
// each other without an extension, as the mod host resolves them, so a resolve hook adds `.ts` to a relative specifier that has none,
// and a load hook names the format so Node does not try the file as CommonJS first. Only `model.ts` and `wrap.ts` are loaded: they are
// pure (no `$`, no drawing, no host import), which is what makes this possible.
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier)) return nextResolve(specifier + '.ts', context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.ts')) return nextLoad(url, { ...context, format: 'module-typescript' });
      return nextLoad(url, context);
    },
  });
}

const PANEL = path.join(__dirname, '..', '..', 'src', 'mod', 'hooks', 'panel');

async function loadPanelModule(name) {
  hook();
  return import(pathToFileURL(path.join(PANEL, name + '.ts')).href);
}

module.exports = { loadPanelModule, PANEL };
