'use strict';
// Verification aid: run a test with `node --require ./tests/helpers/short-uptime.cjs --test <file>` to see it as it runs on a freshly booted machine.
require('node:os').uptime = () => 120;
