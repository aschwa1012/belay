'use strict';
// A stand-in nvidia-smi that never answers: a wedged driver. Run as `node smi-hang.cjs`.
setInterval(() => {}, 1 << 30);
