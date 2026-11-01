'use strict';
// argv: <flag file> <exit|hold>. Starts a detached grandchild that inherits stdout and stderr and lives only while the flag
// file exists (it checks every 100 ms and gives up after 60 s), prints "up", then exits at once ("exit") or stays alive ("hold").
const { spawn } = require('node:child_process');
const [flag, mode] = process.argv.slice(2);
const code = 'const fs=require("fs");const t0=Date.now();setInterval(()=>{if(!fs.existsSync(process.argv[1])||Date.now()-t0>60000)process.exit(0)},100)';
spawn(process.execPath, ['-e', code, flag], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
process.stdout.write('up\n', () => { if (mode === 'exit') process.exit(0); else setInterval(() => {}, 60000); });
