'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyInviteMessagePatches,
  isApplied,
  GROUPS,
  COMPONENT,
  MODULE,
  GROUP_CHAT_PATH,
  CLIENT_PATH,
} = require('./patch-wwebjs-invite-message.js');

const byName = Object.fromEntries(GROUPS.map(group => [group.name, group]));

// Each call inside its method, with a neighbouring method after it.
const method = (name, body) =>
  `    async ${name}(a, options = {}) {\n${body}    }\n\n    async neighbour() {\n        return 1;\n    }\n`;
const groupChat = body => `class GroupChat {\n${method('addParticipants', body)}}\n`;
const client = body => `class Client {\n${method('createGroup', body)}}\n`;

function makeDependency(groupChatSource, clientSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-invite-message-'));
  for (const [file, source] of [
    [GROUP_CHAT_PATH, groupChatSource],
    [CLIENT_PATH, clientSource],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('replaces both positional calls with the object call on the moved module', () => {
  const root = makeDependency(groupChat(byName.addParticipants.find), client(byName.createGroup.find));

  assert.deepEqual(applyInviteMessagePatches({ wwjsDir: root }), {
    applied: ['addParticipants', 'createGroup'],
    skipped: [],
  });
  assert.equal(read(root, GROUP_CHAT_PATH), groupChat(byName.addParticipants.replace));
  assert.equal(read(root, CLIENT_PATH), client(byName.createGroup.replace));
  assert.equal(isApplied(root), true);
});

test('loads the bundle only while the module is missing, then calls it with one object', () => {
  for (const group of GROUPS) {
    assert.match(group.replace, new RegExp(`if \\(!window\\.require\\('${MODULE}'\\)\\) \\{`));
    assert.ok(group.replace.includes(`.require('JSResourceForInteraction')('${COMPONENT}')`));
    assert.ok(group.replace.includes(`.require('${MODULE}')\n`));
    assert.match(group.replace, /\.sendGroupInviteMessage\(\{\n/);
    for (const field of ['caption:', 'chat_:', 'code:', 'exp:', 'gid:', 'name:', 'thumb:']) {
      assert.ok(group.replace.includes(field), `${group.name} passes ${field}`);
    }
    assert.ok(group.find.includes("require('WAWebChatSendMessages')"));
    assert.ok(!group.replace.includes('WAWebChatSendMessages'));
  }
});

test('the patched page code is valid JavaScript', () => {
  for (const group of GROUPS) {
    assert.doesNotThrow(() => new Function(`return async () => {\n${group.replace}};`));
  }
});

test('is idempotent once the fix is present', () => {
  const root = makeDependency(groupChat(byName.addParticipants.replace), client(byName.createGroup.replace));

  assert.deepEqual(applyInviteMessagePatches({ wwjsDir: root }), {
    applied: [],
    skipped: ['addParticipants', 'createGroup'],
  });
  assert.equal(read(root, GROUP_CHAT_PATH), groupChat(byName.addParticipants.replace));
});

test('stands down for a method that already loads the bundle in its own way', () => {
  const own = groupChat(`        await window.require('JSResourceForInteraction')('${COMPONENT}').load();\n`);
  const root = makeDependency(own, client(byName.createGroup.find));

  assert.deepEqual(applyInviteMessagePatches({ wwjsDir: root }), {
    applied: ['createGroup'],
    skipped: ['addParticipants'],
  });
  assert.equal(read(root, GROUP_CHAT_PATH), own);
});

test('reads a half-patched tree as not applied', () => {
  const root = makeDependency(groupChat(byName.addParticipants.replace), client(byName.createGroup.find));

  assert.equal(isApplied(root), false);
});

test('refuses an unknown shape and writes neither file', () => {
  const groupChatSource = groupChat(byName.addParticipants.find);
  const root = makeDependency(groupChatSource, client('        return 1;\n'));

  assert.throws(() => applyInviteMessagePatches({ wwjsDir: root }), /unexpected createGroup\(\) shape/);
  assert.equal(read(root, GROUP_CHAT_PATH), groupChatSource);
});
