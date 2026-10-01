'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyForwardBundlePatch, isApplied, ANCHOR, FIX, LOADER } = require('./patch-wwebjs-forward-bundle.js');

// The real shape around the anchor: the forwardMessage helper between its two neighbours.
const helper = tail => `    window.WWebJS.forwardMessage = async (chatId, msgId) => {
        const msg = window.require('WAWebCollections').Msg.get(msgId);
${tail}            chat: chat,
            msgs: [msg],
        });
    };

    window.WWebJS.sendSeen = async (chatId) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
    };
`;
const BEFORE = helper(ANCHOR);
const AFTER = helper(FIX);

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-forward-bundle-'));
  const utils = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
  fs.mkdirSync(path.dirname(utils), { recursive: true });
  fs.writeFileSync(utils, source);
  return { root, utils };
}

test('loads the forward bundle before the forward call', () => {
  const { root, utils } = makeDependency(`head\n${BEFORE}tail\n`);

  const result = applyForwardBundlePatch(root);

  assert.deepEqual(result, { skipped: false, note: 'forward bundle loaded before a forward' });
  assert.equal(fs.readFileSync(utils, 'utf8'), `head\n${AFTER}tail\n`);
});

test('loads the bundle only when the module is missing, and keeps the call as it was', () => {
  assert.match(FIX, /if \(!window\.require\('WAWebChatForwardMessage'\)\) \{/);
  assert.match(FIX, new RegExp(`\\.require\\('${LOADER}'\\)\\s+\\.requireBundle\\(\\);`));
  assert.ok(FIX.endsWith("return await window.require('WAWebChatForwardMessage').forwardMessages({\n"));
});

test('is idempotent once the fix is present', () => {
  const { root, utils } = makeDependency(`head\n${AFTER}tail\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.deepEqual(applyForwardBundlePatch(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already loads the forward bundle',
  });
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('stands down when the library loads the bundle itself, in another shape', () => {
  const own = helper(
    `        await window.require('${LOADER}').requireBundle();\n` +
      '        const chat = await window.WWebJS.getChat(chatId);\n' +
      "        return await window.require('WAWebChatForwardMessage').forwardMessages({\n",
  );
  const { root, utils } = makeDependency(own);

  assert.equal(isApplied(root), true);
  assert.equal(applyForwardBundlePatch(root).skipped, true);
  assert.equal(fs.readFileSync(utils, 'utf8'), own);
});

test('does not read a loader in a neighbouring helper as the fix', () => {
  const neighbour = `${BEFORE}    window.WWebJS.other = async () => {\n        await window.require('${LOADER}').requireBundle();\n    };\n`;
  const { root } = makeDependency(neighbour);

  assert.equal(isApplied(root), false);
  assert.equal(applyForwardBundlePatch(root).skipped, false);
  assert.equal(isApplied(root), true);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(`head\n${BEFORE}tail\n`);

  assert.equal(isApplied(root), false);
  applyForwardBundlePatch(root);
  assert.equal(isApplied(root), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, utils } = makeDependency('window.WWebJS = {};\n');
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyForwardBundlePatch(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, utils } = makeDependency(`${BEFORE}${BEFORE}`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyForwardBundlePatch(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

// A tree carrying both the fix and an unpatched call is not one the patch understands.
test('rejects a fix present alongside an unpatched call', () => {
  const { root, utils } = makeDependency(`${AFTER}${BEFORE}`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyForwardBundlePatch(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
  assert.equal(isApplied(root), false);
});
