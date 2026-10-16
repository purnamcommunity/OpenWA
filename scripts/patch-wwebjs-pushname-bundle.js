/**
 * Load WhatsApp Web's lazy profile bundle before whatsapp-web.js sets the account's display name.
 *
 * From build 2.3000.1050428120 `WAWebSetPushnameConnAction` ships in the chunk WhatsApp Web fetches
 * only when a human opens their own profile drawer. A headless page never opens it, so the name is
 * absent from the page registry and `window.require` answers `undefined` for it instead of
 * throwing. `Client.setDisplayName()` then reads `.setPushname` off `undefined`, and every rename
 * fails inside the page. The other pushname modules a logged-out page holds
 * (`WAWebSetPushnameLocallyAction`, `WAWebPushNameSync`) only write the local copy or apply an
 * incoming sync; neither sends the new name to the server.
 *
 * `WAWebProfileDrawerLoadableRequireBundle.requireBundle()` loads the chunk, the same loader the
 * profile drawer itself uses. The patched call runs it only when the action is still missing, so a
 * page that already holds the chunk pays nothing. The bundle is cached, and a page reload drops it,
 * so the check belongs to every call rather than to startup.
 *
 * `setPushname(pushname, onDismiss)` keeps the shape whatsapp-web.js calls it with; only its
 * location changed. Read from the live page bundle (2.3000.1050532919), where loading the drawer
 * bundle on a logged-out page registers it. The open upstream fix
 * (wwebjs/whatsapp-web.js#201950) loads the same bundle through `JSResourceForInteraction`; a
 * method that already carries either loader stands down.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The loader whose bundle holds the pushname action. */
const LOADER = 'WAWebProfileDrawerLoadableRequireBundle';
/** The bundle's component, which the upstream fix loads directly. */
const COMPONENT = 'WAWebProfileDrawer.react';

const FIND = `            if (!window.require('WAWebConnModel').Conn.canSetMyPushname())
                return false;
            await window
                .require('WAWebSetPushnameConnAction')
                .setPushname(displayName);`;
const REPLACE = `            if (!window.require('WAWebConnModel').Conn.canSetMyPushname())
                return false;
            // The action ships in the lazy profile bundle a headless page never opens.
            if (!window.require('WAWebSetPushnameConnAction')) {
                await window
                    .require('${LOADER}')
                    .requireBundle();
            }
            await window
                .require('WAWebSetPushnameConnAction')
                .setPushname(displayName);`;

/** The setDisplayName body, so the stand-down check cannot see a neighbour's loader. */
function methodBody(source) {
  const start = source.indexOf('    async setDisplayName(');
  if (start < 0) return null;
  const next = source.indexOf('\n    async ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Ours, or upstream's own loader in the same method: either way the call no longer needs us. */
function alreadyLoads(source) {
  if (source.includes(FIND)) return false;
  if (source.split(REPLACE).length - 1 === 1) return true;
  const body = methodBody(source);
  return body !== null && (body.includes(LOADER) || body.includes(COMPONENT));
}

function applyPushnameBundlePatch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  const source = fs.readFileSync(clientFile, 'utf8');
  if (alreadyLoads(source)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already loads the profile bundle' };
  }
  const findCount = source.split(FIND).length - 1;
  const fixCount = source.split(REPLACE).length - 1;
  if (findCount !== 1 || fixCount !== 0) {
    throw new Error(
      `unsupported setDisplayName() shape (anchors: ${findCount}, fixes: ${fixCount}); ` +
        're-evaluate the profile bundle loader against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(clientFile, source.replace(FIND, REPLACE));
  return { skipped: false, note: 'profile bundle loaded before a display-name change' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return alreadyLoads(fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8'));
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyPushnameBundlePatch();
    console.log(`patch-wwebjs-pushname-bundle: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-pushname-bundle: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-pushname-bundle: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyPushnameBundlePatch, isApplied, FIND, REPLACE, LOADER, COMPONENT, CLIENT_PATH };
