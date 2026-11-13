/**
 * Move whatsapp-web.js's About-text read and write to the module WhatsApp Web now keeps them in.
 *
 * From build 2.3000.1053820627 `WAWebContactStatusBridge` holds only `queryStatusAll` and
 * `sendReadStatus`: its `setMyStatus` and `getStatus` are gone, so `Client.setStatus()` (the
 * gateway's PUT /profile/status) and `Contact.getAbout()` throw inside the page. The About text
 * ("text status") now lives in `WAWebContactTextStatusBridge`:
 *
 * - `setTextStatus(text, emoji, ephemeralDuration)` runs the update job and resolves
 *   `{ result: 'SUCCESS' | 'FAILURE' }`. WhatsApp Web's own `WAWebTextStatusAction.setMyTextStatus`
 *   calls it the same way, then writes the new text onto the own contact with
 *   `WAWebUpdateTextStatusForContact`; the patched call does both. Plain text carries no emoji, and
 *   `WAWebTextStatusUtils.TEXT_STATUS_DURATION_INFINITE` is the duration of an About that never
 *   expires.
 * - `getTextStatus(wid)` resolves `{ text, … }`, or `{ error }` when the server refuses (401 = not
 *   allowed to see it). An error reads as null, as the old call's missing `status` did.
 *
 * Read from the live page bundle (2.3000.1054397709). The calls are written as
 * `window.require('X').member` so the gateway's build probe (wa-scheduler
 * scripts/probe-wa-web-build.cjs) sees and judges the new members.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers. Both files are resolved before either is written, so a
 * refused transform never leaves a half-patched tree.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');
const CONTACT_PATH = path.join('src', 'structures', 'Contact.js');

const NEW_MODULE = 'WAWebContactTextStatusBridge';

const SET_FIND = `        await this.pupPage.evaluate(async (status) => {
            return await window
                .require('WAWebContactStatusBridge')
                .setMyStatus(status);
        }, status);`;
const SET_REPLACE = `        await this.pupPage.evaluate(async (status) => {
            // The About text moved to ${NEW_MODULE} (build 2.3000.1053820627).
            const res = await window
                .require('${NEW_MODULE}')
                .setTextStatus(
                    status,
                    null,
                    window.require('WAWebTextStatusUtils').TEXT_STATUS_DURATION_INFINITE,
                );
            if (!res || res.result !== 'SUCCESS') {
                throw new Error('WhatsApp did not accept the About change');
            }
            const me = window.require('WAWebContactCollection').ContactCollection.getMeContact();
            if (me) {
                window.require('WAWebUpdateTextStatusForContact').updateTextStatusForContact({
                    contactId: me.id,
                    textString: status,
                    emoji: null,
                    ephemeralDuration: window.require('WAWebTextStatusUtils').TEXT_STATUS_DURATION_INFINITE,
                    newUpdateTime: status ? window.require('WATimeUtils').unixTime() : 0,
                    source: 'set-self',
                });
            }
        }, status);`;

const GET_FIND = `            const wid = window.require('WAWebWidFactory').createWid(contactId);
            return window
                .require('WAWebContactStatusBridge')
                .getStatus({ token: '', wid: wid });`;
const GET_REPLACE = `            const wid = window.require('WAWebWidFactory').createWid(contactId);
            // The About text moved to ${NEW_MODULE} (build 2.3000.1053820627).
            const res = await window
                .require('${NEW_MODULE}')
                .getTextStatus(wid);
            return { status: res && !res.error ? res.text : null };`;

const EDITS = [
  { file: CLIENT_PATH, find: SET_FIND, replace: SET_REPLACE, label: 'Client.setStatus()' },
  { file: CONTACT_PATH, find: GET_FIND, replace: GET_REPLACE, label: 'Contact.getAbout()' },
];

const count = (source, text) => source.split(text).length - 1;

/** Each edit is applied when its fix is present once and the old call is gone. */
function readTree(wwjsDir) {
  return EDITS.map(edit => {
    const fullPath = path.join(wwjsDir, edit.file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`whatsapp-web.js ${edit.file} not found at ${fullPath}`);
    }
    const source = fs.readFileSync(fullPath, 'utf8');
    return { ...edit, fullPath, source, finds: count(source, edit.find), fixes: count(source, edit.replace) };
  });
}

function applyTextStatusPatch(wwjsDir = DEFAULT_WWJS) {
  const tree = readTree(wwjsDir);
  if (tree.every(e => e.finds === 0 && e.fixes === 1)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already uses the text status bridge' };
  }
  const bad = tree.filter(e => !(e.finds === 1 && e.fixes === 0) && !(e.finds === 0 && e.fixes === 1));
  if (bad.length) {
    throw new Error(
      `unsupported About-text shape (${bad.map(e => `${e.label} anchors: ${e.finds}, fixes: ${e.fixes}`).join('; ')}); ` +
        're-evaluate the text status bridge against the installed whatsapp-web.js',
    );
  }
  for (const e of tree) {
    if (e.finds === 1) fs.writeFileSync(e.fullPath, e.source.replace(e.find, e.replace));
  }
  return { skipped: false, note: 'About text read and written through the text status bridge' };
}

/**
 * The stand-down branch above as a predicate, for a startup guard.
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return readTree(wwjsDir).every(e => e.finds === 0 && e.fixes === 1);
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyTextStatusPatch();
    console.log(`patch-wwebjs-text-status: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-text-status: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-text-status: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyTextStatusPatch,
  isApplied,
  SET_FIND,
  SET_REPLACE,
  GET_FIND,
  GET_REPLACE,
  CLIENT_PATH,
  CONTACT_PATH,
  NEW_MODULE,
};
