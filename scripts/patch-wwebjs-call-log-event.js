/**
 * Make whatsapp-web.js announce a CALL as a message.
 *
 * WhatsApp writes a `call_log` message into the chat for every call — placed, answered or missed —
 * and that record is the reliable history: it is written whichever linked device was rung, unlike
 * the live `call` event, which only fires when this client is the one WhatsApp chose to ring.
 *
 * whatsapp-web.js never delivers it. Its page-side hook is
 *
 *     Msg.on('add', (msg) => { if (!msg.isNewMsg) return; ... })
 *
 * and a call log carries NO `isNewMsg` at all, so the guard drops it. Measured in a live session by
 * instrumenting both ends of that hook across a real call: the collection recorded
 * `{ type: 'call_log', isNewMsg: null, fromMe: true }` while `onAddMessageEvent` — the very next
 * step — recorded nothing. So the message reaches the page and dies at this line.
 *
 * The consequence downstream is total: no `message_create`, therefore no `message.sent`, therefore
 * nothing for a consumer to store. Calls were invisible in the chat and in call history even though
 * the engine plainly held them.
 *
 * The guard is kept for everything else — it is what stops history replays being re-announced as
 * new — and widened only for `call_log`, which has no `isNewMsg` to be judged by. A call log is
 * written once, at the end of the call, so it cannot arrive as a replay of itself.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The upstream guard, byte-exact. */
const FIND = `            Msg.on('add', (msg) => {
                if (!msg.isNewMsg) return;`;

/** A call log has no isNewMsg, so it is admitted on its type instead. */
const REPLACE = `            Msg.on('add', (msg) => {
                // A call_log carries no isNewMsg, so the guard below would drop it and no call
                // would ever be announced as a message. It is written once, when the call ends,
                // so admitting it cannot re-announce a history replay.
                if (!msg.isNewMsg && msg.type !== 'call_log') return;`;

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8').includes(REPLACE);
  } catch {
    return true;
  }
}

function applyCallLogEventPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }
  const source = fs.readFileSync(clientFile, 'utf8');

  if (source.includes(REPLACE)) {
    return { applied: false, reason: 'already present' };
  }
  if (!source.includes(FIND)) {
    throw new Error(`unexpected Msg.on('add') shape in ${CLIENT_PATH}: refusing to patch blind`);
  }

  fs.writeFileSync(clientFile, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyCallLogEventPatch();
    console.log(`patch-wwebjs-call-log-event: ${result.applied ? 'applied' : `skipped (${result.reason})`}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-call-log-event: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-call-log-event: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyCallLogEventPatch, isApplied, FIND, REPLACE, CLIENT_PATH };
