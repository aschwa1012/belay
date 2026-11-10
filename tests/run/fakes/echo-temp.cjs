'use strict';
// Run by fake-claude (FAKE_SPAWN_SCRIPT): writes the temp variables this process inherited from the worker's launch to FAKE_TEMP_OUT.
require('node:fs').writeFileSync(process.env.FAKE_TEMP_OUT, JSON.stringify({ TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }));
