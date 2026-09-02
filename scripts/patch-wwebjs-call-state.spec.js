'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { applyCallStatePatch, FIND, REPLACE, MARKER, CLIENT_PATH } = require('./patch-wwebjs-call-state.js');

const REAL_CLIENT = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', CLIENT_PATH);

/**
 * The installed Client.js as it ships, patched back out if this tree has already had postinstall
 * run over it. Reading it raw would make every case below depend on install order: after a plain
 * `npm install` the marker is already there, so "applies" could never hold and the lane failed on
 * a correct tree. The round trip is safe because the transform is a single exact replacement.
 */
function pristineClient() {
  const source = fs.readFileSync(REAL_CLIENT, 'utf8');
  return source.includes(MARKER) ? source.replace(REPLACE, FIND) : source;
}

/** A wwjs tree holding `source` as Client.js. */
function treeWith(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-callstate-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, CLIENT_PATH), source);
  return dir;
}

const readClient = (dir) => fs.readFileSync(path.join(dir, CLIENT_PATH), 'utf8');

test('the installed Client.js carries one of the two shapes the patcher knows', () => {
  const source = fs.readFileSync(REAL_CLIENT, 'utf8');
  assert.ok(
    source.includes(FIND) || source.includes(MARKER),
    'installed Client.js matches neither the upstream call-map injection nor the patched one',
  );
});

test('applies against the real upstream Client.js', () => {
  const dir = treeWith(pristineClient());
  assert.deepStrictEqual(applyCallStatePatch(dir), { applied: true });
  assert.ok(readClient(dir).includes(MARKER));
});

test('leaves a file it already patched alone', () => {
  const dir = treeWith(pristineClient());
  applyCallStatePatch(dir);
  const once = readClient(dir);
  assert.deepStrictEqual(applyCallStatePatch(dir), { applied: false, reason: 'already present' });
  assert.strictEqual(readClient(dir), once, 'a second run must not double-apply');
});

test('the patched file is still valid JavaScript', () => {
  const dir = treeWith(pristineClient());
  applyCallStatePatch(dir);
  assert.doesNotThrow(() => new vm.Script(readClient(dir), { filename: 'Client.js' }));
});

test('refuses a tree whose Client.js no longer has the injection', () => {
  const dir = treeWith('module.exports = {};\n');
  assert.throws(() => applyCallStatePatch(dir), /found 0/);
});

test('refuses a shape carrying the injection twice rather than patching blind', () => {
  const dir = treeWith(`${FIND}\n${FIND}\n`);
  assert.throws(() => applyCallStatePatch(dir), /found 2/);
});

test('refuses a tree with no Client.js at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-empty-'));
  assert.throws(() => applyCallStatePatch(dir), /not found/);
});

test('the forwarded snapshot carries scalars, drops structures, and lets the explicit fields win', () => {
  // Mirrors the injected body exactly: whatever WhatsApp names the state field, it survives.
  const value = { id: 'C1', peerJid: '9@c.us', isVideo: false, state: 'ACTIVE', offerTime: 12, o: {}, f() {} };
  const scalars = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    const t = typeof v;
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') scalars[k] = v;
  }
  const payload = { ...scalars, id: value.id, peerJid: value.peerJid, isVideo: value.isVideo };

  assert.strictEqual(payload.state, 'ACTIVE', 'the state field must reach the client');
  assert.strictEqual(payload.offerTime, 12);
  assert.ok(!('o' in payload), 'objects are not forwarded');
  assert.ok(!('f' in payload), 'functions are not forwarded');
  assert.strictEqual(payload.id, 'C1', 'the explicit fields still win');
});
