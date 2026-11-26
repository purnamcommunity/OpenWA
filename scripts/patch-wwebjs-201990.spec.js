'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { apply201990Patch, isApplied, EDITS, CLIENT_PATH, UPSTREAM_MARKER } = require('./patch-wwebjs-201990.js');
const readySync = require('./patch-wwebjs-ready-sync.js');

/**
 * The fixture is the INSTALLED Client.js rather than a hand-written approximation. When postinstall
 * already patched it, the transforms are reversed to recover the text upstream ships, so the suite
 * behaves the same before and after a local install.
 */
const INSTALLED = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

function pristine() {
  let source = fs.readFileSync(path.join(INSTALLED, CLIENT_PATH), 'utf8');
  // The ready-sync edits are reversed too, so the order test below meets the tree both were written for.
  for (const edit of [...EDITS, ...readySync.EDITS]) source = source.split(edit.replace).join(edit.find);
  return source;
}

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-201990-'));
  const client = path.join(root, CLIENT_PATH);
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, source);
  return { root, client };
}

const edit = name => EDITS.find(e => e.name === name);

/**
 * A page as WhatsApp Web serves it. On `/login/` the socket model is registered but cannot be
 * required (its dependencies load only after login) while the backend event bus answers; a logged-in
 * page has both.
 */
function fakePage({ route, socketState = 'CONNECTED', busState = 'UNPAIRED' }) {
  const calls = [];
  const bus = {
    socketState: busState,
    isMainStreamReadyMd: false,
    on: (event, handler) => calls.push(['bus.on', event, handler]),
    triggerLogout: () => calls.push(['bus.triggerLogout']),
    triggerReconnectSocket: () => calls.push(['bus.triggerReconnectSocket']),
  };
  const socket = {
    state: socketState,
    hasSynced: true,
    on: (event, handler) => calls.push(['socket.on', event, handler]),
    logout: () => calls.push(['socket.logout']),
    reconnect: () => calls.push(['socket.reconnect']),
  };
  const modules = {
    WAWebBackendEventBus: { BackendEventBus: bus },
    WAWebSocketModel: route === '/login/' ? null : { Socket: socket },
    WAWebCmd: { Cmd: { on: () => undefined } },
    WAWebConnModel: { Conn: { off: (event, handler) => calls.push(['conn.off', event, handler]) } },
  };
  // On /login/ the socket model answers null once, then throws on every later require (measured live).
  let socketRequires = 0;
  const requireModule = name => {
    if (name === 'WAWebSocketModel' && route === '/login/' && socketRequires++ > 0) {
      throw new Error('Requiring module "WAWebSocketModel" with unresolved dependencies');
    }
    return modules[name];
  };
  const window = { location: { pathname: route }, require: requireModule };
  return { window, calls, bus, socket };
}

/** Run a page-side snippet of the patched file against a fake page. */
function runSnippet(code, window, extra = {}) {
  const names = Object.keys(extra);
  return new Function('window', ...names, code)(window, ...names.map(n => extra[n]));
}

test('applies every edit to the installed 1.34.8 Client.js, and the result still parses', () => {
  const { root, client } = makeDependency(pristine());

  assert.equal(isApplied(root), false);
  const result = apply201990Patch(root);

  assert.equal(result.skipped, false);
  const patched = fs.readFileSync(client, 'utf8');
  for (const e of EDITS) assert.equal(patched.split(e.replace).length - 1, 1, e.name);
  const check = spawnSync(process.execPath, ['--check', client], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(isApplied(root), true);
});

test('is idempotent: a second run is a no-op, not a double patch', () => {
  const { root, client } = makeDependency(pristine());
  apply201990Patch(root);
  const once = fs.readFileSync(client, 'utf8');

  const result = apply201990Patch(root);

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(client, 'utf8'), once);
});

test('stands down on a library that already carries the upstream event-bus listener', () => {
  const upstream = pristine().replace(edit('inject listeners').find, `                // ${UPSTREAM_MARKER}\n`);
  const { root, client } = makeDependency(upstream);

  const result = apply201990Patch(root);

  assert.equal(result.skipped, true);
  assert.match(result.reason, /WAWebBackendEventBus/);
  assert.equal(fs.readFileSync(client, 'utf8'), upstream);
  assert.equal(isApplied(root), true);
});

test('refuses an unknown shape and leaves the file untouched', () => {
  const moved = pristine().replace(edit('getState').find, '            return null;');
  const { root, client } = makeDependency(moved);

  assert.throws(() => apply201990Patch(root), /unsupported Client\.js shape.*getState 0\/0/);
  assert.equal(fs.readFileSync(client, 'utf8'), moved);
  assert.equal(isApplied(root), false);
});

test('refuses a half-patched file rather than finishing it', () => {
  const half = pristine().replace(edit('logout').find, edit('logout').replace);
  const { root, client } = makeDependency(half);

  assert.throws(() => apply201990Patch(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), half);
});

test('applies alongside the ready-sync patcher in either order', () => {
  for (const order of [
    [apply201990Patch, readySync.applyReadySyncPatch],
    [readySync.applyReadySyncPatch, apply201990Patch],
  ]) {
    const { root } = makeDependency(pristine());
    for (const apply of order) assert.equal(apply(root).skipped, false);
    assert.equal(isApplied(root), true);
    assert.equal(readySync.isApplied(root), true);
  }
});

test('on /login/ the auth state, the listeners and the pairing-code state come from the event bus', () => {
  const page = fakePage({ route: '/login/', busState: 'UNPAIRED' });

  const needAuth = runSnippet(`${edit('need-auth state').replace}\nreturn state;`, page.window);
  const codeState = runSnippet(`${edit('pairing-code state').replace}\nreturn state;`, page.window);
  const { Socket, listeners } = runSnippet(
    `${edit('inject listeners').replace}];\nreturn { Socket, listeners };`,
    page.window,
  );

  assert.equal(needAuth, 'UNPAIRED');
  assert.equal(codeState, 'UNPAIRED');
  assert.equal(Socket, page.bus);
  assert.deepEqual(
    listeners.map(([target, event]) => [target === page.bus, event]),
    [
      [true, 'set_socket_state'],
      [true, 'open_socket_stream'],
    ],
  );
  // The level check after the listeners reads hasSynced; on the bus that is isMainStreamReadyMd.
  assert.equal(page.bus.hasSynced, false);
});

test('on /login/ the QR listener is removed when the socket stream opens', () => {
  const page = fakePage({ route: '/login/' });
  const onRefChange = () => undefined;

  runSnippet(edit('QR listener removal').replace, page.window, { onRefChange });
  const [, event, handler] = page.calls.find(([what]) => what === 'bus.on');
  handler();

  assert.equal(event, 'open_socket_stream');
  assert.deepEqual(page.calls.at(-1), ['conn.off', 'change:ref', onRefChange]);
});

test('on /login/ logout, getState and resetState reach the event bus', () => {
  const page = fakePage({ route: '/login/', busState: 'UNPAIRED_IDLE' });

  runSnippet(edit('logout').replace, page.window);
  const state = runSnippet(edit('getState').replace, page.window);
  runSnippet(edit('resetState').replace, page.window);

  assert.equal(state, 'UNPAIRED_IDLE');
  assert.deepEqual(
    page.calls.map(([what]) => what),
    ['bus.triggerLogout', 'bus.triggerReconnectSocket'],
  );
});

test('a logged-in page keeps reading the socket model, as stock 1.34.8 does', () => {
  const page = fakePage({ route: '/', socketState: 'CONNECTED', busState: 'SOMETHING_ELSE' });
  const onRefChange = () => undefined;

  const needAuth = runSnippet(`${edit('need-auth state').replace}\nreturn state;`, page.window);
  const codeState = runSnippet(`${edit('pairing-code state').replace}\nreturn state;`, page.window);
  const { Socket, listeners } = runSnippet(
    `${edit('inject listeners').replace}];\nreturn { Socket, listeners };`,
    page.window,
  );
  runSnippet(edit('QR listener removal').replace, page.window, { onRefChange });
  const state = runSnippet(edit('getState').replace, page.window);
  runSnippet(edit('logout').replace, page.window);
  runSnippet(edit('resetState').replace, page.window);

  assert.equal(needAuth, 'CONNECTED');
  assert.equal(codeState, 'CONNECTED');
  assert.equal(state, 'CONNECTED');
  assert.equal(Socket, page.socket);
  assert.deepEqual(
    listeners.map(([target, event]) => [target === page.socket, event]),
    [
      [true, 'change:state'],
      [true, 'change:hasSynced'],
    ],
  );
  assert.deepEqual(
    page.calls.map(([what, event]) => (event ? `${what} ${event}` : what)),
    ['socket.on change:hasSynced', 'socket.logout', 'socket.reconnect'],
  );
});

test('on /login/ no read touches the socket model, which throws once it has been required', () => {
  const page = fakePage({ route: '/login/', busState: 'UNPAIRED' });
  // Require it once, as any earlier code on the page may have.
  page.window.require('WAWebSocketModel');

  for (const name of ['need-auth state', 'pairing-code state']) {
    assert.equal(runSnippet(`${edit(name).replace}\nreturn state;`, page.window), 'UNPAIRED', name);
  }
  assert.equal(runSnippet(edit('getState').replace, page.window), 'UNPAIRED');
  assert.doesNotThrow(() => runSnippet(edit('logout').replace, page.window));
  assert.doesNotThrow(() => runSnippet(edit('resetState').replace, page.window));
});
