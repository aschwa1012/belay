'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RESET_SEQUENCE, restoreTerminal } = require('../../src/run/term-restore.cjs');

const ESC = String.fromCharCode(27);

test('the reset sequence turns off mouse, paste and focus modes, shows the cursor and resets SGR', () => {
  for (const m of [1000, 1002, 1003, 1006, 1015, 1016, 2004, 1004, 2031]) assert.ok(RESET_SEQUENCE.includes(`${ESC}[?${m}l`), `?${m}l`);
  assert.ok(RESET_SEQUENCE.includes(`${ESC}[?25h`));
  assert.ok(RESET_SEQUENCE.includes(`${ESC}[0m`));
  assert.ok(RESET_SEQUENCE.endsWith(`${String.fromCharCode(13)}${ESC}[J`), 'CR and erase-below come last');
  assert.ok(!RESET_SEQUENCE.includes(`${ESC}[3J`) && !RESET_SEQUENCE.includes(`${ESC}[2J`), 'the scrollback and the whole screen are not erased');
  assert.ok(!RESET_SEQUENCE.includes('1049') && !RESET_SEQUENCE.includes('1047'), 'the alternate screen is not touched');
});

test('with altScreen the alternate screen is left first, and not otherwise', () => {
  const { ALT_SCREEN_OFF } = require('../../src/run/term-restore.cjs');
  const out = [];
  restoreTerminal({ isTTY: true, write: (s) => out.push(s) }, { altScreen: true });
  assert.deepEqual(out, [ALT_SCREEN_OFF + RESET_SEQUENCE]);
  assert.equal(ALT_SCREEN_OFF, `${ESC}7${ESC}[?1049l`);
});

test('restoreTerminal writes to a TTY once and writes nothing to a pipe', () => {
  const out = [];
  assert.equal(restoreTerminal({ isTTY: true, write: (s) => out.push(s) }), true);
  assert.deepEqual(out, [RESET_SEQUENCE]);
  const none = [];
  assert.equal(restoreTerminal({ isTTY: false, write: (s) => none.push(s) }), false);
  assert.equal(restoreTerminal(null), false);
  assert.deepEqual(none, []);
  assert.equal(restoreTerminal({ isTTY: true, write: () => { throw new Error('gone'); } }), false);
});

test('the alternate-screen exit saves the cursor (ESC 7) before ?1049l: a kill during the trust dialog is on the main screen (receipts/alt)', () => {
  const out = [];
  restoreTerminal({ isTTY: true, write: (s) => out.push(s) }, { altScreen: true });
  const w = out.join('');
  assert.ok(w.startsWith(`${ESC}7${ESC}[?1049l`), 'a bare ?1049l moves the cursor home on the main screen under ConPTY');
  assert.ok(w.indexOf(`${ESC}7`) < w.indexOf('?1049l'));
  assert.ok(!w.includes('1047'), '?1047l is ignored by conhost');
  assert.ok(!out.join('').includes('1049') || w.indexOf(`${ESC}7`) === 0);
});
