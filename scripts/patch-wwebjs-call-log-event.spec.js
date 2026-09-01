'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyCallLogEventPatch, FIND, REPLACE, CLIENT_PATH } = require('./patch-wwebjs-call-log-event.js');

function fakeWwjs(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-calllog-'));
  fs.mkdirSync(path.join(dir, path.dirname(CLIENT_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, CLIENT_PATH), body);
  return dir;
}
const read = (dir) => fs.readFileSync(path.join(dir, CLIENT_PATH), 'utf8');

test('admits a call_log, which carries no isNewMsg to be judged by', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);

  assert.deepStrictEqual(applyCallLogEventPatch({ wwjsDir: dir }), { applied: true });
  assert.ok(read(dir).includes("msg.type !== 'call_log'"));
});

test('keeps the isNewMsg guard for every other type', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyCallLogEventPatch({ wwjsDir: dir });

  // The guard is what stops a history replay being re-announced as new; only call_log is exempt.
  assert.ok(read(dir).includes('if (!msg.isNewMsg &&'));
});

test('is idempotent, so a second install changes nothing', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyCallLogEventPatch({ wwjsDir: dir });
  const after = read(dir);

  assert.deepStrictEqual(applyCallLogEventPatch({ wwjsDir: dir }), { applied: false, reason: 'already present' });
  assert.strictEqual(read(dir), after);
});

test('refuses to patch an unrecognised shape rather than shipping without the fix', () => {
  const dir = fakeWwjs("Msg.on('add', (msg) => { if (!msg.somethingElse) return;");

  assert.throws(() => applyCallLogEventPatch({ wwjsDir: dir }), /refusing to patch blind/);
});

test('fails loudly when Client.js is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-empty-'));

  assert.throws(() => applyCallLogEventPatch({ wwjsDir: dir }), /Client\.js not found/);
});

test('writes nothing when it refuses', () => {
  const body = "Msg.on('add', (msg) => { if (!msg.somethingElse) return;";
  const dir = fakeWwjs(body);

  try {
    applyCallLogEventPatch({ wwjsDir: dir });
  } catch {
    /* expected */
  }
  assert.strictEqual(read(dir), body);
});

test('the replacement still contains the original guard, not a removal of it', () => {
  assert.ok(REPLACE.includes('!msg.isNewMsg'));
});
