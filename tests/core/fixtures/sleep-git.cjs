'use strict';
// sleep-git.cjs — stands in for git in a slow-git test: waits SLEEP_GIT_MS, then runs the real git with the same arguments.
const { spawnSync } = require('node:child_process');
const [real, ...args] = process.argv.slice(2);
setTimeout(() => { const r = spawnSync(real, args, { stdio: 'inherit', windowsHide: true }); process.exit(r.status === null ? 1 : r.status); }, Number(process.env.SLEEP_GIT_MS || 0));
