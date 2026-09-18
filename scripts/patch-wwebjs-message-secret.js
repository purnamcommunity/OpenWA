/**
 * Give every ordinary outgoing message a `messageSecret`, as WhatsApp's own clients do.
 *
 * A message's `messageSecret` (32 random bytes, sent as `messageContextInfo.messageSecret`) is the
 * key its add-ons are encrypted under. In a community announcement group, members' reactions and
 * replies are such add-ons, so a message that arrives without a secret gives their clients nothing
 * to encrypt with: WhatsApp hides React and Reply on it, on every device, for good. The secret
 * cannot be attached after the message is sent.
 *
 * `window.WWebJS.sendMessage` builds the message itself and only sets a secret for polls, events,
 * status posts and bot messages, so every text and media send through whatsapp-web.js lands in an
 * announcement group unreactable, while the same text typed on a phone collects reactions.
 *
 * The secret is added on the path that reaches `addAndSendMsgToChat`, which is every chat and group
 * send; channel and status sends return before it and are untouched. A secret already on the
 * message (a poll's or an event's) is kept, because their votes and responses are keyed to it.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/** The upstream chat-send call, byte-exact. */
const FIND = `        const [msgPromise, sendMsgResultPromise] = window
            .require('WAWebSendMsgChatAction')
            .addAndSendMsgToChat(chat, message);`;

/** The same call, on a message that always carries a secret. */
const REPLACE = `        // A message without a messageSecret cannot take add-ons: in a community announcement group
        // WhatsApp hides React and Reply on it for every member. WhatsApp's own clients give every
        // message one; a poll's or event's own secret is kept, since its votes are keyed to it.
        if (!message.messageSecret) {
            message.messageSecret = window.crypto.getRandomValues(
                new Uint8Array(32),
            );
        }

        const [msgPromise, sendMsgResultPromise] = window
            .require('WAWebSendMsgChatAction')
            .addAndSendMsgToChat(chat, message);`;

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8').includes(REPLACE);
  } catch {
    return true;
  }
}

function applyMessageSecretPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }
  const source = fs.readFileSync(utilsFile, 'utf8');

  if (source.includes(REPLACE)) {
    return { applied: false, reason: 'already present' };
  }
  if (source.split(FIND).length - 1 !== 1) {
    throw new Error(`unexpected addAndSendMsgToChat shape in ${UTILS_PATH}: refusing to patch blind`);
  }

  fs.writeFileSync(utilsFile, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMessageSecretPatch();
    console.log(`patch-wwebjs-message-secret: ${result.applied ? 'applied' : `skipped (${result.reason})`}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-message-secret: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-message-secret: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyMessageSecretPatch, isApplied, FIND, REPLACE, UTILS_PATH };
