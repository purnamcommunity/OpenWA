/**
 * Let a call's OUTCOME reach whatsapp-web.js, not just its arrival.
 *
 * wwjs raises its `call` event from an injected override of the call collection's internal Map.
 * That override runs on EVERY write to the map — including each state transition of a call already
 * ringing — but forwards a fixed field whitelist: id, peerJid, isVideo, isGroup, canHandleLocally,
 * outgoing, webClientShouldHandle, participants. The `value` it reads is the live call model, which
 * also carries the call's state; that field is simply not on the list. So the transition that says
 * "answered" or "rejected" arrives stripped of the one value distinguishing it from the ring, and
 * a call can only ever be reported as RINGING.
 *
 * The patch forwards every own enumerable PRIMITIVE field of the call model alongside the existing
 * ones. It names no field: WhatsApp Web's own name for the state is not knowable without a live
 * call, and a patch that guessed one would break silently the day it changed. A superset cannot.
 *
 * The explicit fields are spread LAST so they still win: this is strictly additive, and every
 * existing consumer sees exactly the values it saw before. Enumeration is wrapped — a model that
 * refuses it still reports the call rather than throwing inside WhatsApp's own Map.set.
 *
 * Objects and functions are skipped deliberately. They are what makes a model expensive to
 * serialize across the page boundary, and `participants` (the one structured field wwjs wants) is
 * already forwarded explicitly.
 *
 * The transform is exact and self-disabling: an unknown shape fails the build instead of silently
 * shipping without the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The upstream body, byte-exact. */
const FIND = `                internalCallMap.set = function (key, value) {
                    window.onIncomingCall({
                        id: value.id,`;

const REPLACE = `                internalCallMap.set = function (key, value) {
                    const scalars = {};
                    try {
                        for (const k of Object.keys(value)) {
                            const v = value[k];
                            const t = typeof v;
                            if (v === null || t === 'string' || t === 'number' || t === 'boolean') {
                                scalars[k] = v;
                            }
                        }
                    } catch (e) {
                        // A model that refuses enumeration still reports the call.
                    }
                    window.onIncomingCall({
                        ...scalars,
                        id: value.id,`;

/** Present once the patch has been applied — makes a second run a no-op rather than a failure. */
const MARKER = 'const scalars = {};';

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8').includes(MARKER);
  } catch {
    return true;
  }
}

function applyCallStatePatch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`${CLIENT_PATH} not found under ${wwjsDir}`);
  }
  const source = fs.readFileSync(clientFile, 'utf8');

  if (source.includes(MARKER)) {
    return { applied: false, reason: 'already present' };
  }
  const occurrences = source.split(FIND).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one internalCallMap.set injection in ${CLIENT_PATH}, found ${occurrences} — ` +
        'the upstream shape changed and the patch would be applied blind',
    );
  }
  fs.writeFileSync(clientFile, source.replace(FIND, REPLACE));
  return { applied: true };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, reason } = applyCallStatePatch();
    console.log(`patch-wwebjs-call-state: ${applied ? 'applied' : `skipped (${reason})`}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-call-state: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-call-state: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyCallStatePatch, isApplied, FIND, REPLACE, MARKER, CLIENT_PATH };
