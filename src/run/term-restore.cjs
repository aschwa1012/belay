'use strict';
// term-restore.cjs — what a killed claude never gets to do: put the operator's terminal back. An interactive
// claude turns on mouse tracking, bracketed paste and focus events and hides the cursor; a kill by exact pid
// skips its exit handler, and the shell is left printing every mouse move as `[555;51;48M`. Only the modes
// claude is known to set are reset. The alternate screen is left alone unless the launch forced fullscreen:
// leaving an alternate screen that was never entered moves the cursor.

const ESC = String.fromCharCode(27);
const OFF = [1000, 1002, 1003, 1006, 1015, 1016, 2004, 1004, 2031]; // mouse (X10, drag, any, SGR, urxvt, SGR pixel), bracketed paste, focus events, colour-scheme reports
// Last: CR and erase-below (ED 0, never the scrollback), so a receipt printed over a dialog claude left on the main
// screen (a kill during the trust dialog) leaves none of the dialog's text behind it.
const RESET_SEQUENCE = `${OFF.map((m) => `${ESC}[?${m}l`).join('')}${ESC}[?25h${ESC}[0m${String.fromCharCode(13)}${ESC}[J`;

// Fullscreen (CLAUDE_CODE_NO_FLICKER=1) runs on the alternate screen, and a killed claude leaves it there: the
// operator's prompt would come back on a screen they cannot scroll. Written only when the launch forced fullscreen.
// ESC 7 (save cursor) first, then ?1049l. Claude shows its trust dialog on the main screen BEFORE it enters the
// alternate one, and a bare ?1049l there makes ConPTY emit ESC[H, so the receipt prints over the operator's screen.
// With the cursor saved first, ?1049l on the main screen produces no output and no cursor move, and on the alternate
// screen conhost repaints the main one and restores the cursor. ?1047l does not do: ConPTY passes it through without
// acting, conhost stays on its alternate buffer and the console is out of sync for the rest of the shell session
// (ide-leak/receipts/alt).
const ALT_SCREEN_OFF = `${ESC}7${ESC}[?1049l`;

// Writes the reset to `stream` only if it is a terminal. Returns whether it wrote; a write that throws is not
// an error for the close (the terminal may already be gone).
function restoreTerminal(stream = process.stdout, { altScreen = false } = {}) {
  if (!stream || !stream.isTTY || typeof stream.write !== 'function') return false;
  try { stream.write(altScreen ? ALT_SCREEN_OFF + RESET_SEQUENCE : RESET_SEQUENCE); return true; } catch { return false; }
}

module.exports = { ALT_SCREEN_OFF, RESET_SEQUENCE, restoreTerminal };
