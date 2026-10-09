'use strict';
// One error class for the run module. After src/core lands, the core's own CoreError is used so
// that `instanceof` holds across the boundary; until then this local class carries the same shape
// ({ code, message, detail }) that contract §6 names.

let CoreError;
try {
  ({ CoreError } = require('../core/index.cjs'));
} catch {
  CoreError = null;
}

if (typeof CoreError !== 'function') {
  CoreError = class CoreError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'CoreError';
      this.code = code;
      if (detail !== undefined) this.detail = detail;
    }
  };
}

function fail(code, message, detail) {
  throw new CoreError(code, message, detail);
}

module.exports = { CoreError, fail };
