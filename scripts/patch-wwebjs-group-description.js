/**
 * Pass the group description job the options object WhatsApp Web now takes.
 *
 * `WAWebGroupModifyInfoJob.setGroupDescription` takes a single `{desc, groupWid, newDescId,
 * prevDescId}`. The released whatsapp-web.js 1.34.7 calls it positionally, so the Wid lands where
 * the object is read, every field is undefined, and `widToGroupJid` throws inside the page —
 * reaching the caller as a bare 500 while the library still types the method `Promise<boolean>`.
 * `setGroupSubject` in the same module is still positional and is unaffected.
 *
 * The description id comes from `WARandomHex.randomHex(8)` and an empty description is sent as
 * `null`, both as WhatsApp Web itself does: `null` selects the job's delete branch, so `''` still
 * clears rather than writing an empty body element.
 *
 * The source transform is deliberately exact and self-disabling. An unknown shape fails the
 * production image build instead of silently shipping without the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const GROUP_CHAT_PATH = path.join('src', 'structures', 'GroupChat.js');
const POSITIONAL_CALL = `                let newId = await window.require('WAWebMsgKey').newId();
                try {
                    await window
                        .require('WAWebGroupModifyInfoJob')
                        .setGroupDescription(
                            chatWid,
                            description,
                            newId,
                            descId,
                        );`;
const OPTIONS_CALL = `                let newId = window.require('WARandomHex').randomHex(8);
                try {
                    await window
                        .require('WAWebGroupModifyInfoJob')
                        .setGroupDescription({
                            desc: description === '' ? null : description,
                            groupWid: chatWid,
                            newDescId: newId,
                            prevDescId: descId,
                        });`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyGroupDescriptionFix(wwjsDir = DEFAULT_WWJS) {
  const groupChatFile = path.join(wwjsDir, GROUP_CHAT_PATH);
  if (!fs.existsSync(groupChatFile)) {
    throw new Error(`whatsapp-web.js GroupChat.js not found at ${groupChatFile}`);
  }

  const source = fs.readFileSync(groupChatFile, 'utf8');
  const positionalCount = occurrences(source, POSITIONAL_CALL);
  const optionsCount = occurrences(source, OPTIONS_CALL);

  if (positionalCount === 0 && optionsCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already calls the description job with an options object',
    };
  }
  if (positionalCount !== 1 || optionsCount !== 0) {
    throw new Error(
      `unsupported GroupChat.js shape (positional calls: ${positionalCount}, options calls: ${optionsCount}); ` +
        're-evaluate the group description fix against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(groupChatFile, source.replace(POSITIONAL_CALL, OPTIONS_CALL));
  return { skipped: false, note: 'group description job called with an options object' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyGroupDescriptionFix();
    console.log(`patch-wwebjs-group-description: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-group-description: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-group-description: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyGroupDescriptionFix, POSITIONAL_CALL, OPTIONS_CALL };
