/**
 * Load WhatsApp Web's lazy forward bundle before whatsapp-web.js forwards a message.
 *
 * `WAWebChatForwardMessage` ships in the chunk WhatsApp Web fetches only when a human opens the
 * forward dialog. A headless page never opens it, so the name is absent from the page registry and
 * `window.require` answers `undefined` for it instead of throwing. `window.WWebJS.forwardMessage`
 * then reads `.forwardMessages` off `undefined`, and every forward fails inside the page.
 *
 * `WAWebForwardMessageFlowLoadable.requireBundle()` loads the chunk. The patched call runs it only
 * when the module is still missing, so a page that already holds the chunk pays nothing. The bundle
 * is cached, and a page reload drops it, so the check belongs to every call rather than to startup.
 *
 * `forwardMessages` still takes the single options object whatsapp-web.js passes
 * (`{chat, msgs, multicast, includeCaption, appendedText}`); only its location changed. Read from
 * the live page bundle.
 *
 * The source transform is deliberately exact and self-disabling. An unknown shape fails the
 * production image build instead of silently shipping without the fix, and the patch stands down
 * once the installed tree loads the bundle itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/** The loadable whose bundle holds the forward module. */
const LOADER = 'WAWebForwardMessageFlowLoadable';

// The last two statements of window.WWebJS.forwardMessage, adjacent and unique in the file.
const CHAT_LINE = '        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });\n';
const CALL_LINE = "        return await window.require('WAWebChatForwardMessage').forwardMessages({\n";
const ANCHOR = CHAT_LINE + CALL_LINE;
const FIX =
  CHAT_LINE +
  '        // forwardMessages ships in the lazy forward bundle a headless page never opens.\n' +
  "        if (!window.require('WAWebChatForwardMessage')) {\n" +
  '            await window\n' +
  `                .require('${LOADER}')\n` +
  '                .requireBundle();\n' +
  '        }\n' +
  CALL_LINE;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** The forwardMessage helper's body, so the stand-down check cannot see a neighbour's loader. */
function forwardBody(source) {
  const start = source.indexOf('    window.WWebJS.forwardMessage = ');
  if (start < 0) return null;
  const next = source.indexOf('\n    window.WWebJS.', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Ours, or the library's own loader in the same helper: either way the call no longer needs us. */
function alreadyLoads(source) {
  if (occurrences(source, ANCHOR) !== 0) return false;
  if (occurrences(source, FIX) === 1) return true;
  const body = forwardBody(source);
  return body !== null && body.includes(LOADER);
}

function applyForwardBundlePatch(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  const source = fs.readFileSync(utilsFile, 'utf8');
  if (alreadyLoads(source)) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already loads the forward bundle',
    };
  }
  const anchorCount = occurrences(source, ANCHOR);
  const fixCount = occurrences(source, FIX);
  if (anchorCount !== 1 || fixCount !== 0) {
    throw new Error(
      `unsupported Utils.js shape (anchors: ${anchorCount}, fixes: ${fixCount}); ` +
        're-evaluate the forward bundle loader against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(ANCHOR, FIX));
  return { skipped: false, note: 'forward bundle loaded before a forward' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return alreadyLoads(fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8'));
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyForwardBundlePatch();
    console.log(`patch-wwebjs-forward-bundle: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-forward-bundle: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-forward-bundle: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyForwardBundlePatch, isApplied, ANCHOR, FIX, LOADER };
