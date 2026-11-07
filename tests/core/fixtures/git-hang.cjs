'use strict';
// A stand-in for a git call that never exits. Run as `node git-hang.cjs`.
setInterval(() => {}, 1 << 30);
