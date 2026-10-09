// log-writer.test.cjs — build 12 A1: the adapter's bounded, non-blocking log writer.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogWriter } = require('../../src/mcp/log-writer.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-logw-')), 'adapter.log');
const rm = (f) => { try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* temp sweep */ } };

test('lines are written in order, asynchronously, and drain waits for them', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'one'); log('>>', 'two'); log('##', 'three');
    await log.drain();
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((l) => l.split(' ').slice(3).join(' ')), ['one', 'two', 'three']);
    assert.deepEqual(lines.map((l) => l.split(' ')[2]), ['##', '>>', '##']);
  } finally { rm(f); }
});

test('a write does not complete inside the call (the adapter is not blocked on the disk)', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'a');
    assert.ok(!fs.existsSync(f) || fs.readFileSync(f, 'utf8') === '', 'the append had not landed when log() returned');
    await log.drain();
    assert.match(fs.readFileSync(f, 'utf8'), /## a\n/);
  } finally { rm(f); }
});

test('flushSync writes what is still queued (the exit path)', () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'a');
    log.flushSync();
    assert.match(fs.readFileSync(f, 'utf8'), /## a\n/);
  } finally { rm(f); }
});

test('wire frames stop at the frame cap, own lines continue to the file cap, then one line says so', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f, { frameCap: 300, fileCap: 600 });
    for (let i = 0; i < 20; i++) log('>>', 'x'.repeat(60));
    assert.ok(log.bytes() <= 300, `frames wrote ${log.bytes()} past a 300 cap`);
    for (let i = 0; i < 20; i++) log('##', 'lease-keepalive ' + 'y'.repeat(30));
    log('>>', 'dropped');
    await log.drain();
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.includes('lease-keepalive'), 'own lines were still written after the frames were cut off');
    assert.ok(Buffer.byteLength(text) <= 600 + 100, `file grew to ${Buffer.byteLength(text)}`);
    assert.equal(text.split('\n').filter((l) => l.includes('log capped')).length, 1);
    assert.ok(!text.includes('dropped'));
    log('##', 'after cap'); await log.drain();
    assert.ok(!fs.readFileSync(f, 'utf8').includes('after cap'));
  } finally { rm(f); }
});

test('the caps are per launch: bytes an earlier launch left in the file do not count (review B1)', async () => {
  const f = tmpFile();
  try {
    fs.writeFileSync(f, 'z'.repeat(500));
    const log = createLogWriter(f, { frameCap: 400, fileCap: 520 });
    log('>>', 'frame'); // the file is already past the frame cap, this process is not
    await log.drain();
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.startsWith('z'.repeat(500)) && text.includes('>> frame'), 'the frame was written despite the file already being past the cap');
  } finally { rm(f); }
});

test('exit flush writes the in-flight batch before the queue, never after it (review N1)', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'first');
    await new Promise((r) => setImmediate(r)); // the append for 'first' is now in flight
    await new Promise((r) => setImmediate(r));
    log('##', 'second');
    log.flushSync();
    const lines = fs.readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).map((l) => l.split(' ').slice(3).join(' '));
    assert.ok(lines.includes('first') && lines.includes('second'), lines.join('|'));
    assert.ok(lines.indexOf('first') < lines.lastIndexOf('second'));
    assert.ok(lines.lastIndexOf('first') < lines.lastIndexOf('second'), 'a line landed after a later one');
  } finally { rm(f); }
});

test('a log that cannot be written never throws', async () => {
  const log = createLogWriter(path.join(os.tmpdir(), 'belay-no-such-dir-a1', 'x', 'adapter.log'));
  log('##', 'lost');
  await log.drain();
  log.flushSync();
});

// Records the timers drain() arms (only during the synchronous call) and every handle passed to clearTimeout.
async function observeDrains(log, count, ms) {
  const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
  const armed = []; const cleared = [];
  globalThis.clearTimeout = (h) => { cleared.push(h); return realClear(h); };
  try {
    const drains = [];
    for (let i = 0; i < count; i++) {
      globalThis.setTimeout = (...a) => { const h = realSet(...a); armed.push(h); return h; };
      try { drains.push(log.drain(ms)); } finally { globalThis.setTimeout = realSet; }
    }
    await Promise.all(drains);
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
  return { armed, cleared };
}

test('a drain answered by the write clears its own timer (A1 review N2)', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'one');
    const { armed, cleared } = await observeDrains(log, 1, 60000);
    assert.match(fs.readFileSync(f, 'utf8'), /## one\n/);
    assert.equal(armed.length, 1);
    assert.ok(cleared.includes(armed[0]), 'the timer drain armed was not cleared');
  } finally { rm(f); }
});

test('concurrent drains answered by the write each clear their own timer', async () => {
  const f = tmpFile();
  try {
    const log = createLogWriter(f);
    log('##', 'one');
    const { armed, cleared } = await observeDrains(log, 20, 60000);
    assert.match(fs.readFileSync(f, 'utf8'), /## one\n/);
    assert.equal(armed.length, 20);
    assert.equal(new Set(armed).size, 20);
    for (const h of armed) assert.ok(cleared.includes(h), 'a drain timer was left armed');
  } finally { rm(f); }
});

test('no file given is a no-op writer', async () => {
  const log = createLogWriter(undefined);
  log('##', 'x'); await log.drain(); log.flushSync();
});
