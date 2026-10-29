/**
 * Send a private group invite through WhatsApp Web's own invite module, loading its lazy bundle first.
 *
 * When a participant cannot be added directly (WhatsApp answers 403 because of their privacy
 * settings), whatsapp-web.js sends them a private group invite instead: `GroupChat.addParticipants()`
 * and `Client.createGroup()`, both with `autoSendInviteV4` on by default. Each call has two faults:
 *
 * - `sendGroupInviteMessage` no longer lives on `WAWebChatSendMessages`. It moved to its own module,
 *   `WAWebChatSendGroupInviteMessage`, in the chunk WhatsApp Web fetches only when a human opens the
 *   "invite privately" flow. A headless page never opens it, so `window.require` answers `undefined`
 *   for the module instead of throwing.
 * - The function takes ONE options object, `{caption, chat_, code, exp, gid, name, thumb}`, where
 *   whatsapp-web.js passes seven positional arguments. Positionally, `chat_` reads as `undefined` and
 *   the send throws inside the page, so the add failed for that participant instead of inviting them.
 *
 * `JSResourceForInteraction('WAWebGroupsV4InviteFlow.react').load()` loads the chunk, as WhatsApp
 * Web's own `WAWebGroupsV4InviteFlowLoadable` does. Each patched call runs it only when the module
 * is still missing, so a page that already holds the chunk pays nothing; a page reload drops the
 * chunk, so the check belongs to every call rather than to startup. The object's fields are those
 * WhatsApp Web's own flow passes: `gid` is the group id as a string, `code` falls back to `''`.
 * Read from the live page bundle.
 *
 * Exact and self-disabling, like the sibling patchers: an unknown shape fails the build rather than
 * silently shipping without the fix, and a call that already loads the bundle is left alone.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const GROUP_CHAT_PATH = path.join('src', 'structures', 'GroupChat.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The lazy component whose bundle holds the invite module. Its presence in a method means it is fixed. */
const COMPONENT = 'WAWebGroupsV4InviteFlow.react';
const MODULE = 'WAWebChatSendGroupInviteMessage';
/** Where the send used to live. Named apart so the build probe does not read the removed call as a live one. */
const OLD_MODULE = 'WAWebChatSendMessages';

/** The bundle load, indented to sit at `indent` inside the page function. */
const loadBundle = indent =>
  `${indent}// The send lives in the lazy private-invite bundle a headless page never opens.\n` +
  `${indent}if (!window.require('${MODULE}')) {\n` +
  `${indent}    await window\n` +
  `${indent}        .require('JSResourceForInteraction')('${COMPONENT}')\n` +
  `${indent}        .load();\n` +
  `${indent}}\n`;

const GROUPS = [
  {
    name: 'addParticipants',
    file: GROUP_CHAT_PATH,
    find: `                            const res = await window
                                .require('${OLD_MODULE}')
                                .sendGroupInviteMessage(
                                    userChat,
                                    group.id._serialized || group.id.$1,
                                    groupName,
                                    rpcResult.inviteV4Code,
                                    rpcResult.inviteV4CodeExp,
                                    comment,
                                    await window.WWebJS.getProfilePicThumbToBase64(
                                        groupWid,
                                    ),
                                );
`,
    replace:
      loadBundle('                            ') +
      `                            const res = await window
                                .require('${MODULE}')
                                .sendGroupInviteMessage({
                                    caption: comment,
                                    chat_: userChat,
                                    code: rpcResult.inviteV4Code || '',
                                    exp: rpcResult.inviteV4CodeExp,
                                    gid: group.id._serialized || group.id.$1,
                                    name: groupName,
                                    thumb: await window.WWebJS.getProfilePicThumbToBase64(
                                        groupWid,
                                    ),
                                });
`,
  },
  {
    name: 'createGroup',
    file: CLIENT_PATH,
    find: `                        const addParticipantResult = await window
                            .require('${OLD_MODULE}')
                            .sendGroupInviteMessage(
                                window
                                    .require('WAWebCollections')
                                    .Chat.get(participant.wid) ||
                                    (await window
                                        .require('WAWebCollections')
                                        .Chat.find(participant.wid)),
                                createGroupResult.wid._serialized ||
                                    createGroupResult.wid.$1,
                                createGroupResult.subject,
                                participant.invite_code,
                                participant.invite_code_exp,
                                comment,
                                await window.WWebJS.getProfilePicThumbToBase64(
                                    createGroupResult.wid,
                                ),
                            );
`,
    replace:
      loadBundle('                        ') +
      `                        const addParticipantResult = await window
                            .require('${MODULE}')
                            .sendGroupInviteMessage({
                                caption: comment,
                                chat_:
                                    window
                                        .require('WAWebCollections')
                                        .Chat.get(participant.wid) ||
                                    (await window
                                        .require('WAWebCollections')
                                        .Chat.find(participant.wid)),
                                code: participant.invite_code || '',
                                exp: participant.invite_code_exp,
                                gid:
                                    createGroupResult.wid._serialized ||
                                    createGroupResult.wid.$1,
                                name: createGroupResult.subject,
                                thumb: await window.WWebJS.getProfilePicThumbToBase64(
                                    createGroupResult.wid,
                                ),
                            });
`,
  },
];

/** The method body a group lives in, so the stand-down check cannot see a neighbour's loader. */
function methodBody(source, name) {
  const start = source.indexOf(`    async ${name}(`);
  if (start < 0) return null;
  const next = source.indexOf('\n    async ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Ours, or the library's own loader in the same method: either way the call no longer needs us. */
function groupDone(source, group) {
  if (source.includes(group.replace)) return true;
  const body = methodBody(source, group.name);
  return body !== null && body.includes(COMPONENT) && !body.includes(group.find);
}

/**
 * Every group's stand-down branch as one predicate. A half-patched tree reads as NOT applied, and
 * an unreadable one as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const sources = {};
    for (const file of [GROUP_CHAT_PATH, CLIENT_PATH]) {
      sources[file] = fs.readFileSync(path.join(wwjsDir, file), 'utf8');
    }
    return GROUPS.every(group => groupDone(sources[group.file], group));
  } catch {
    return true;
  }
}

function applyInviteMessagePatches({ wwjsDir = DEFAULT_WWJS } = {}) {
  const sources = {};
  for (const file of [GROUP_CHAT_PATH, CLIENT_PATH]) {
    const full = path.join(wwjsDir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`whatsapp-web.js ${path.basename(file)} not found at ${full}`);
    }
    sources[file] = fs.readFileSync(full, 'utf8');
  }

  // Every group is checked before anything is written, so a refusal leaves both files untouched.
  const applied = [];
  const skipped = [];
  for (const group of GROUPS) {
    const source = sources[group.file];
    if (groupDone(source, group)) {
      skipped.push(group.name);
      continue;
    }
    if (source.split(group.find).length - 1 !== 1) {
      throw new Error(`unexpected ${group.name}() shape in ${group.file}: refusing to patch blind`);
    }
    sources[group.file] = source.replace(group.find, group.replace);
    applied.push(group);
  }

  for (const file of new Set(applied.map(group => group.file))) {
    fs.writeFileSync(path.join(wwjsDir, file), sources[file]);
  }
  return { applied: applied.map(group => group.name), skipped };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, skipped } = applyInviteMessagePatches();
    const report = [
      ...applied.map(name => `applied ${name}`),
      ...skipped.map(name => `skipped ${name} (already present)`),
    ].join('; ');
    console.log(`patch-wwebjs-invite-message: ${report}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-invite-message: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-invite-message: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyInviteMessagePatches, isApplied, GROUPS, COMPONENT, MODULE, GROUP_CHAT_PATH, CLIENT_PATH };
