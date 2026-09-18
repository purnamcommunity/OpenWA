'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

const { applyMessageSecretPatch, isApplied, FIND, REPLACE, UTILS_PATH } = require('./patch-wwebjs-message-secret.js');

function fakeWwjs(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-secret-'));
  fs.mkdirSync(path.join(dir, path.dirname(UTILS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, UTILS_PATH), body);
  return dir;
}
const read = dir => fs.readFileSync(path.join(dir, UTILS_PATH), 'utf8');

/**
 * Runs the patched send tail against a stand-in page and returns the message it handed to
 * addAndSendMsgToChat. `await msgPromise` is left out: only what reaches the send call matters.
 */
function sendThroughPatch(message) {
  let sent;
  const window = {
    crypto: webcrypto,
    require: () => ({
      addAndSendMsgToChat: (_chat, msg) => {
        sent = msg;
        return [Promise.resolve(), Promise.resolve()];
      },
    }),
  };
  new Function('window', 'chat', 'message', REPLACE)(window, {}, message);
  return sent;
}

test('gives an ordinary send a fresh 32-byte secret, so members can react to it', () => {
  const first = sendThroughPatch({ type: 'chat', body: 'hello' });
  const second = sendThroughPatch({ type: 'chat', body: 'hello' });

  assert.ok(first.messageSecret instanceof Uint8Array);
  assert.strictEqual(first.messageSecret.length, 32);
  assert.notDeepStrictEqual(first.messageSecret, second.messageSecret);
});

test("keeps a poll's own secret, which its votes are keyed to", () => {
  const pollSecret = new Uint8Array(32).fill(7);

  const sent = sendThroughPatch({ type: 'poll_creation', messageSecret: pollSecret });

  assert.strictEqual(sent.messageSecret, pollSecret);
});

test('applies to the chat-send call and leaves the call itself intact', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n        await msgPromise;\n`);

  assert.deepStrictEqual(applyMessageSecretPatch({ wwjsDir: dir }), { applied: true });
  const after = read(dir);
  assert.ok(after.includes('message.messageSecret = window.crypto.getRandomValues('));
  assert.ok(after.includes('.addAndSendMsgToChat(chat, message);'));
  assert.ok(after.indexOf('messageSecret') < after.indexOf('addAndSendMsgToChat'));
});

test('is idempotent, so a second install changes nothing', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyMessageSecretPatch({ wwjsDir: dir });
  const after = read(dir);

  assert.deepStrictEqual(applyMessageSecretPatch({ wwjsDir: dir }), { applied: false, reason: 'already present' });
  assert.strictEqual(read(dir), after);
});

test('refuses to patch an unrecognised shape rather than shipping without the fix', () => {
  const dir = fakeWwjs("const r = window.require('WAWebSendMsgChatAction').sendMsg(chat, message);");

  assert.throws(() => applyMessageSecretPatch({ wwjsDir: dir }), /refusing to patch blind/);
});

test('refuses a tree where the send call appears twice, since it cannot tell which one sends', () => {
  const dir = fakeWwjs(`${FIND}\n${FIND}\n`);

  assert.throws(() => applyMessageSecretPatch({ wwjsDir: dir }), /refusing to patch blind/);
});

test('fails loudly when Utils.js is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-empty-'));

  assert.throws(() => applyMessageSecretPatch({ wwjsDir: dir }), /Utils\.js not found/);
});

test('writes nothing when it refuses', () => {
  const body = "window.require('WAWebSendMsgChatAction').sendMsg(chat, message);";
  const dir = fakeWwjs(body);

  try {
    applyMessageSecretPatch({ wwjsDir: dir });
  } catch {
    // The assertion is the file, not the throw.
  }
  assert.strictEqual(read(dir), body);
});

test('reports its own state to the startup guard, and reads an unreadable tree as applied', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  assert.strictEqual(isApplied(dir), false);

  applyMessageSecretPatch({ wwjsDir: dir });
  assert.strictEqual(isApplied(dir), true);

  // A tree we cannot inspect is not evidence of a broken one; a false alarm every boot is worse.
  assert.strictEqual(isApplied(path.join(dir, 'nope')), true);
});
