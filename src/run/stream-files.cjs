'use strict';
// stream-files.cjs — the headless orchestrator's stream.jsonl and stderr.txt. The run settles (and closes them) on the child's 'exit',
// which can come before its last stdout and stderr chunks are read. Those chunks are appended by path once the files are closed,
// never written to the closed fd numbers, which the process may already have handed to another file.
const fs = require('node:fs');
const path = require('node:path');

function openStreamFiles(dir) {
  const files = { stream: path.join(dir, 'stream.jsonl'), stderr: path.join(dir, 'stderr.txt') };
  const fds = { stream: fs.openSync(files.stream, 'a'), stderr: fs.openSync(files.stderr, 'a') };
  let closed = false;
  const write = (which, data) => {
    try { if (closed) fs.appendFileSync(files[which], data); else fs.writeSync(fds[which], data); } catch { /* the run's folder is gone */ }
  };
  return {
    stream: (data) => write('stream', data),
    stderr: (data) => write('stderr', data),
    close() {
      if (closed) return;
      closed = true;
      for (const fd of Object.values(fds)) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    },
  };
}

module.exports = { openStreamFiles };
