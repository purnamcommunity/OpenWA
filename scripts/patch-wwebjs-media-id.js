/**
 * Keep an outgoing media message's own id when the media model is spread into it.
 *
 * `window.WWebJS.sendMessage` builds the outgoing message by spreading `mediaOptions` — the
 * `MediaData` model `processMediaData` returns — into it, both directly and through its `toJSON()`.
 * Current WhatsApp Web builds give that model a private `__x_id` field, which is the same private
 * field the outgoing `Msg` model keeps its id in. The spread overwrites the message's `MsgKey`, and
 * `Msg` initialization fails inside the page with `Data passed to getter must include an id property
 * (it's how we memoize) but got undefined`, so every image, video, audio and document send answers
 * 500 while text sends keep working.
 *
 * The field is deleted after the spread, so the message is initialized with the `id` it was built
 * with. Adopted from the open upstream fix (wwebjs/whatsapp-web.js#201923, issue #201921); the
 * patcher stands down once the installed library carries that same deletion.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/** The end of the outgoing message literal and the line after it, byte-exact. */
const FIND = `            ...extraOptions,
        };

        // Bot's won't reply if canonicalUrl is set (linking)`;

/** The same, with the media model's private id removed before the message is initialized. */
const REPLACE = `            ...extraOptions,
        };

        // A spread MediaData model carries a private __x_id, the same field Msg keeps its id in.
        // Left in place it replaces the MsgKey above and Msg initialization throws "Data passed to
        // getter must include an id property", failing every media send.
        delete message.__x_id;

        // Bot's won't reply if canonicalUrl is set (linking)`;

/** The upstream fix's own statement; its presence means the library no longer needs this patch. */
const UPSTREAM_FIX = 'delete message.__x_id;';

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8').includes(UPSTREAM_FIX);
  } catch {
    return true;
  }
}

function applyMediaIdPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }
  const source = fs.readFileSync(utilsFile, 'utf8');

  if (source.includes(UPSTREAM_FIX)) {
    return { applied: false, reason: 'already present' };
  }
  if (source.split(FIND).length - 1 !== 1) {
    throw new Error(`unexpected outgoing message shape in ${UTILS_PATH}: refusing to patch blind`);
  }

  fs.writeFileSync(utilsFile, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMediaIdPatch();
    console.log(`patch-wwebjs-media-id: ${result.applied ? 'applied' : `skipped (${result.reason})`}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-id: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-id: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyMediaIdPatch, isApplied, FIND, REPLACE, UPSTREAM_FIX, UTILS_PATH };
