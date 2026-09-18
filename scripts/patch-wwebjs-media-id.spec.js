'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyMediaIdPatch, isApplied, FIND, REPLACE, UPSTREAM_FIX, UTILS_PATH } = require('./patch-wwebjs-media-id.js');

function fakeWwjs(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-media-id-'));
  fs.mkdirSync(path.join(dir, path.dirname(UTILS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, UTILS_PATH), body);
  return dir;
}
const read = dir => fs.readFileSync(path.join(dir, UTILS_PATH), 'utf8');

/** The send's message literal as upstream writes it, ending where FIND ends. */
const MESSAGE_LITERAL = `        const message = {
            ...options,
            id: newMsgKey,
            ...mediaOptions,
            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
${FIND}
        if (botOptions) {
            delete message.canonicalUrl;
        }
        return message;`;

/** Runs the patched literal with a media model that carries the private id, as current builds do. */
function buildMessage(source) {
  const body = source.slice(source.indexOf('const message = {'));
  const mediaOptions = { __x_id: undefined, mimetype: 'image/png', type: 'image' };
  return new Function('options', 'newMsgKey', 'mediaOptions', 'extraOptions', 'botOptions', body)(
    {},
    'msg-key',
    mediaOptions,
    {},
    undefined,
  );
}

test("keeps the message's own id when the media model carries a private one", () => {
  const dir = fakeWwjs(MESSAGE_LITERAL);
  assert.ok('__x_id' in buildMessage(read(dir)), 'the unpatched literal lets the private id through');

  assert.deepStrictEqual(applyMediaIdPatch({ wwjsDir: dir }), { applied: true });
  const message = buildMessage(read(dir));

  assert.ok(!('__x_id' in message));
  assert.strictEqual(message.id, 'msg-key');
  assert.strictEqual(message.mimetype, 'image/png');
});

test('is idempotent, so a second install changes nothing', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyMediaIdPatch({ wwjsDir: dir });
  const after = read(dir);

  assert.deepStrictEqual(applyMediaIdPatch({ wwjsDir: dir }), { applied: false, reason: 'already present' });
  assert.strictEqual(read(dir), after);
});

test('stands down once the library ships the upstream fix', () => {
  const upstream = `        };\n\n        ${UPSTREAM_FIX}\n`;
  const dir = fakeWwjs(upstream);

  assert.deepStrictEqual(applyMediaIdPatch({ wwjsDir: dir }), { applied: false, reason: 'already present' });
  assert.strictEqual(read(dir), upstream);
  assert.strictEqual(isApplied(dir), true);
});

test('refuses to patch an unrecognised shape rather than shipping without the fix', () => {
  const dir = fakeWwjs('const message = { ...mediaOptions };');

  assert.throws(() => applyMediaIdPatch({ wwjsDir: dir }), /refusing to patch blind/);
  assert.strictEqual(read(dir), 'const message = { ...mediaOptions };');
});

test('fails loudly when Utils.js is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-empty-'));

  assert.throws(() => applyMediaIdPatch({ wwjsDir: dir }), /Utils\.js not found/);
});

test('reports its own state to the startup guard, and reads an unreadable tree as applied', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  assert.strictEqual(isApplied(dir), false);

  applyMediaIdPatch({ wwjsDir: dir });
  assert.strictEqual(isApplied(dir), true);
  assert.ok(REPLACE.includes(UPSTREAM_FIX));

  // A tree we cannot inspect is not evidence of a broken one; a false alarm every boot is worse.
  assert.strictEqual(isApplied(path.join(dir, 'nope')), true);
});
