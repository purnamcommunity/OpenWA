'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyContactAltWidPatch, isApplied, FIND, REPLACE, UTILS_PATH } = require('./patch-wwebjs-contact-alt-wid.js');

function fakeWwjs(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-altwid-'));
  fs.mkdirSync(path.join(dir, path.dirname(UTILS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, UTILS_PATH), body);
  return dir;
}
const read = (dir) => fs.readFileSync(path.join(dir, UTILS_PATH), 'utf8');

test('contains the alternate-identity lookup, so one refused wid cannot fail the address book', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);

  assert.deepStrictEqual(applyContactAltWidPatch({ wwjsDir: dir }), { applied: true });
  assert.ok(read(dir).includes('try {'));
  assert.ok(read(dir).includes('} catch (error) {'));
});

test('keeps the lookup itself, which is what reports a contact blocked under its other identity', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyContactAltWidPatch({ wwjsDir: dir });

  const after = read(dir);
  assert.ok(after.includes('getAlternateUserWid(wid)'));
  assert.ok(after.includes('Blocklist.get(alt)'));
});

test('is idempotent, so a second install changes nothing', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  applyContactAltWidPatch({ wwjsDir: dir });
  const after = read(dir);

  assert.deepStrictEqual(applyContactAltWidPatch({ wwjsDir: dir }), { applied: false, reason: 'already present' });
  assert.strictEqual(read(dir), after);
});

test('refuses to patch an unrecognised shape rather than shipping without the fix', () => {
  const dir = fakeWwjs('if (!res.isBlocked) { res.isBlocked = somethingElse(wid); }');

  assert.throws(() => applyContactAltWidPatch({ wwjsDir: dir }), /refusing to patch blind/);
});

test('fails loudly when Utils.js is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-empty-'));

  assert.throws(() => applyContactAltWidPatch({ wwjsDir: dir }), /Utils\.js not found/);
});

test('writes nothing when it refuses', () => {
  const body = 'if (!res.isBlocked) { res.isBlocked = somethingElse(wid); }';
  const dir = fakeWwjs(body);

  try {
    applyContactAltWidPatch({ wwjsDir: dir });
  } catch {
    // The assertion is the file, not the throw.
  }
  assert.strictEqual(read(dir), body);
});

test('reports its own state to the startup guard, and reads an unreadable tree as applied', () => {
  const dir = fakeWwjs(`prefix\n${FIND}\n suffix`);
  assert.strictEqual(isApplied(dir), false);

  applyContactAltWidPatch({ wwjsDir: dir });
  assert.strictEqual(isApplied(dir), true);

  // A tree we cannot inspect is not evidence of a broken one; a false alarm every boot is worse.
  assert.strictEqual(isApplied(path.join(dir, 'nope')), true);
  assert.ok(REPLACE.includes('catch'));
});
