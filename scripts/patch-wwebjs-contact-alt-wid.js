/**
 * Stop one unreadable contact from failing the whole contact list.
 *
 * `window.WWebJS.getContactModel` decides `isBlocked` in two steps: the contact's own
 * `isContactBlocked`, and — only when that is false — a second look under the contact's alternate
 * identity, so a contact blocked under its `@lid` still reports blocked when it is read by phone
 * number. The second step calls `WAWebApiContact.getAlternateUserWid(wid)`, which THROWS for a wid
 * WhatsApp Web will not answer for: a device-addressed wid (`<user>:<device>@c.us`) rejects with
 * `getAlternateUserWid - Invalid get call using deviceWid`.
 *
 * Nothing catches it. `getContacts` maps the whole collection through this function inside a single
 * `page.evaluate`, so one such entry rejects the evaluate, and the gateway answers `500` for
 * `GET /contacts` — the entire address book, not the one contact. Observed in production: the
 * account holds a handful of device-addressed entries, every bulk contact read failed, and the only
 * names still resolvable were the ones a per-id `getContactById` could fetch one at a time.
 *
 * The lookup is wrapped instead of removed. A wid this call refuses tells us nothing about the
 * blocklist, and `isContactBlocked` — already assigned — remains the answer for that contact; the
 * alternate-identity check keeps working for every wid the page does accept.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/** The upstream alternate-identity lookup, byte-exact. */
const FIND = `        if (!res.isBlocked) {
            const alt = window
                .require('WAWebApiContact')
                .getAlternateUserWid(wid);
            if (alt) {
                res.isBlocked = !!window
                    .require('WAWebCollections')
                    .Blocklist.get(alt);
            }
        }`;

/** The same lookup, unable to reject the read it is only refining. */
const REPLACE = `        if (!res.isBlocked) {
            // getAlternateUserWid throws for a wid the page refuses to map — a device-addressed
            // wid answers "Invalid get call using deviceWid". This runs once per contact inside
            // getContacts' single page.evaluate, so an uncaught throw here fails the whole address
            // book rather than this one entry. A refused wid says nothing about the blocklist, and
            // isContactBlocked above already stands as the answer.
            try {
                const alt = window
                    .require('WAWebApiContact')
                    .getAlternateUserWid(wid);
                if (alt) {
                    res.isBlocked = !!window
                        .require('WAWebCollections')
                        .Blocklist.get(alt);
                }
            } catch (error) {
                // Deliberately ignored — see above.
            }
        }`;

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

function applyContactAltWidPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }
  const source = fs.readFileSync(utilsFile, 'utf8');

  if (source.includes(REPLACE)) {
    return { applied: false, reason: 'already present' };
  }
  if (!source.includes(FIND)) {
    throw new Error(`unexpected getAlternateUserWid shape in ${UTILS_PATH}: refusing to patch blind`);
  }

  fs.writeFileSync(utilsFile, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyContactAltWidPatch();
    console.log(`patch-wwebjs-contact-alt-wid: ${result.applied ? 'applied' : `skipped (${result.reason})`}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-contact-alt-wid: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-contact-alt-wid: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyContactAltWidPatch, isApplied, FIND, REPLACE, UTILS_PATH };
