/**
 * Let a logged-out whatsapp-web.js session reach its QR code and pairing code on WhatsApp Web's
 * `/login/` route.
 *
 * Since late November 2026 WhatsApp Web sends a logged-out page to `web.whatsapp.com/login/`. That
 * page registers `WAWebSocketModel` but loads its dependencies only after login, so
 * `window.require('WAWebSocketModel')` answers `null` there. Stock 1.34.8 reads the socket state and
 * the synced flag from that model, so a session that has to link fails with
 * `Cannot read properties of null (reading 'Socket')` before it shows a QR code or a pairing code.
 * A page that is already logged in loads the full app and never meets the problem.
 *
 * Port of upstream commit 38eb45b2 (wwebjs/whatsapp-web.js#201990, "fix: Socket"), merged after
 * 1.34.8: on `/login/` the state, the synced signal, logout and reconnect come from
 * `WAWebBackendEventBus` (`socketState`, `set_socket_state`, `open_socket_stream`,
 * `isMainStreamReadyMd`, `triggerLogout`, `triggerReconnectSocket`). One adaptation: upstream reads
 * the event bus everywhere outside the inject listeners, also on a logged-in page. Here every such
 * read chooses by route, as the inject listeners do: the event bus on `/login/`, the socket model
 * everywhere else, so a linked session runs exactly the code it ran before. The route decides rather
 * than a null check because on `/login/` the socket model answers `null` once and then throws
 * (`Requiring module ... with unresolved dependencies`) on every later require, and a throwing
 * predicate keeps puppeteer's waitForFunction polling until it times out (measured live, build
 * 2.3000.1056332094).
 *
 * Seven transforms, one group (all-or-nothing). The inject listeners edit sits beside the
 * readiness marker of patch-wwebjs-ready-sync.js but shares no text with it, so the two apply in
 * either order; the hasSynced level check after the listeners is left as it is and reads the
 * event bus's `isMainStreamReadyMd` on `/login/`, as upstream does.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, and a library that already listens on the event bus stands the patcher down.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The event the upstream fix listens on; a library that carries it needs nothing from us. */
const UPSTREAM_MARKER = "'open_socket_stream'";

const NEED_AUTH_FIND = `                    const state =
                        window.require?.('WAWebSocketModel')?.Socket?.state;`;
const NEED_AUTH_REPLACE = `                    // On /login/ the socket model cannot be required until login; the event bus has the state.
                    const state = window.location.pathname.startsWith('/login')
                        ? window.require?.('WAWebBackendEventBus')?.BackendEventBus
                              ?.socketState
                        : window.require?.('WAWebSocketModel')?.Socket?.state;`;

const QR_OFF_FIND = `                        // Remove QR listener once authentication succeeds
                        window
                            .require('WAWebSocketModel')
                            .Socket.on('change:hasSynced', () => {
                                window
                                    .require('WAWebConnModel')
                                    .Conn.off('change:ref', onRefChange);
                            });`;
const QR_OFF_REPLACE = `                        // Remove QR listener once authentication succeeds
                        const offRefChange = () => {
                            window
                                .require('WAWebConnModel')
                                .Conn.off('change:ref', onRefChange);
                        };
                        if (window.location.pathname.startsWith('/login')) {
                            window
                                .require('WAWebBackendEventBus')
                                .BackendEventBus.on('open_socket_stream', offRefChange);
                        } else {
                            window
                                .require('WAWebSocketModel')
                                .Socket.on('change:hasSynced', offRefChange);
                        }`;

const LISTENERS_FIND = `                const Socket = window.require('WAWebSocketModel').Socket;
                const Cmd = window.require('WAWebCmd').Cmd;

                const listeners = [
                    [
                        Socket,
                        'change:state',
                        (_AppState, state) => {
                            window.onAuthAppStateChangedEvent(state);
                        },
                    ],
                    [
                        Socket,
                        'change:hasSynced',
                        () => {
                            window.onAppStateHasSyncedEvent();
                        },
                    ],
`;
const LISTENERS_REPLACE = `                const Cmd = window.require('WAWebCmd').Cmd;

                // A logged-out page lives on /login/, where WAWebSocketModel resolves null until
                // login; the backend event bus carries the same two signals there.
                const loginRoute =
                    window.location.pathname.startsWith('/login');
                let Socket = null;
                let socketListeners;
                if (loginRoute) {
                    Socket = window.require(
                        'WAWebBackendEventBus',
                    ).BackendEventBus;
                    Socket.hasSynced = Socket.isMainStreamReadyMd;
                    socketListeners = [
                        [
                            Socket,
                            'set_socket_state',
                            (state) => {
                                window.onAuthAppStateChangedEvent(state);
                            },
                        ],
                        [
                            Socket,
                            'open_socket_stream',
                            () => {
                                window.onAppStateHasSyncedEvent();
                            },
                        ],
                    ];
                } else {
                    Socket = window.require('WAWebSocketModel').Socket;
                    socketListeners = [
                        [
                            Socket,
                            'change:state',
                            (_AppState, state) => {
                                window.onAuthAppStateChangedEvent(state);
                            },
                        ],
                        [
                            Socket,
                            'change:hasSynced',
                            () => {
                                window.onAppStateHasSyncedEvent();
                            },
                        ],
                    ];
                }

                const listeners = [
                    ...socketListeners,
`;

const CODE_STATE_FIND = `                    const state =
                        window.require('WAWebSocketModel').Socket.state;`;
const CODE_STATE_REPLACE = `                    const state = window.location.pathname.startsWith('/login')
                        ? window.require('WAWebBackendEventBus').BackendEventBus
                              .socketState
                        : window.require('WAWebSocketModel').Socket.state;`;

const LOGOUT_FIND = `            return window.require('WAWebSocketModel').Socket.logout();`;
const LOGOUT_REPLACE = `            if (window.location.pathname.startsWith('/login'))
                return window
                    .require('WAWebBackendEventBus')
                    .BackendEventBus.triggerLogout();
            return window.require('WAWebSocketModel').Socket.logout();`;

const GET_STATE_FIND = `            return window.require('WAWebSocketModel').Socket.state ?? null;`;
const GET_STATE_REPLACE = `            if (window.location.pathname.startsWith('/login'))
                return (
                    window.require('WAWebBackendEventBus').BackendEventBus
                        .socketState ?? null
                );
            return window.require('WAWebSocketModel').Socket.state ?? null;`;

const RESET_FIND = `            window.require('WAWebSocketModel').Socket.reconnect();`;
const RESET_REPLACE = `            if (window.location.pathname.startsWith('/login'))
                window
                    .require('WAWebBackendEventBus')
                    .BackendEventBus.triggerReconnectSocket();
            else window.require('WAWebSocketModel').Socket.reconnect();`;

const EDITS = [
  { name: 'need-auth state', find: NEED_AUTH_FIND, replace: NEED_AUTH_REPLACE },
  { name: 'QR listener removal', find: QR_OFF_FIND, replace: QR_OFF_REPLACE },
  { name: 'inject listeners', find: LISTENERS_FIND, replace: LISTENERS_REPLACE },
  { name: 'pairing-code state', find: CODE_STATE_FIND, replace: CODE_STATE_REPLACE },
  { name: 'logout', find: LOGOUT_FIND, replace: LOGOUT_REPLACE },
  { name: 'getState', find: GET_STATE_FIND, replace: GET_STATE_REPLACE },
  { name: 'resetState', find: RESET_FIND, replace: RESET_REPLACE },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** Each edit's find counted with every replacement removed: a replacement may contain a find's lines. */
function counts(source) {
  const stripped = EDITS.reduce((text, edit) => text.split(edit.replace).join(''), source);
  return {
    finds: EDITS.map(edit => occurrences(stripped, edit.find)),
    replaces: EDITS.map(edit => occurrences(source, edit.replace)),
  };
}

function isPatched(source) {
  const { finds, replaces } = counts(source);
  return finds.every(n => n === 0) && replaces.every(n => n === 1);
}

/** Upstream's own fix in the installed library: the event bus listener is there and ours is not. */
function carriesUpstreamFix(source) {
  return source.includes(UPSTREAM_MARKER) && counts(source).replaces.every(n => n === 0);
}

/**
 * The stand-down branch below as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied, since a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8');
    return isPatched(source) || carriesUpstreamFix(source);
  } catch {
    return true;
  }
}

function apply201990Patch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  let source = fs.readFileSync(clientFile, 'utf8');
  if (isPatched(source)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already carries the login-route socket port' };
  }
  if (carriesUpstreamFix(source)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already reads the socket from WAWebBackendEventBus' };
  }
  const { finds, replaces } = counts(source);
  // Applied from nothing: anything else is a shape this patcher was not written for.
  if (finds.every(n => n === 1) && replaces.every(n => n === 0)) {
    for (const edit of EDITS) {
      source = source.replace(edit.find, () => edit.replace);
    }
    writeFileAtomic(clientFile, source);
    return { skipped: false, note: 'login-route socket port (#201990) applied' };
  }
  const shape = EDITS.map((edit, i) => `${edit.name} ${finds[i]}/${replaces[i]}`).join(', ');
  throw new Error(
    `unsupported Client.js shape (unpatched/patched per edit: ${shape}); ` +
      're-evaluate the #201990 port against the installed whatsapp-web.js',
  );
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = apply201990Patch();
    console.log(`patch-wwebjs-201990: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-201990: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-201990: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  apply201990Patch,
  isApplied,
  EDITS,
  CLIENT_PATH,
  UPSTREAM_MARKER,
};
