'use strict';
// A substrate that never becomes ready: it writes a line to stderr and exits 1. Drives the
// E_NO_READY path (contract §5): an error with pid, exit_code and stderr_tail, and a `dead` row —
// never a `running` one (ADR 0004 §2, invariant "no success without effect").
process.stderr.write('fake substrate: refusing to start (no ready event)\n');
process.exit(1);
