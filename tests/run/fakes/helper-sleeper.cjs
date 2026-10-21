'use strict';
// A helper a fake worker starts: writes its own pid to FAKE_HELPER_PIDFILE and idles until it is killed.
require('node:fs').writeFileSync(process.env.FAKE_HELPER_PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
