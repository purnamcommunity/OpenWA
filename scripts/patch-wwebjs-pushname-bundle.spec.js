'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyPushnameBundlePatch, isApplied, FIND, REPLACE, LOADER, COMPONENT, CLIENT_PATH } = require(
  './patch-wwebjs-pushname-bundle.js',
);

/**
 * The fixture is the INSTALLED Client.js rather than a hand-written approximation. When postinstall
 * already patched it, the transform is reversed to recover the text upstream ships, so the suite
 * behaves the same before and after a local install.
 */
const INSTALLED = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

function pristine() {
  const source = fs.readFileSync(path.join(INSTALLED, CLIENT_PATH), 'utf8');
  return source.includes(REPLACE) ? source.replace(REPLACE, FIND) : source;
}

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-pushname-bundle-'));
  const client = path.join(root, CLIENT_PATH);
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, source);
  return { root, client };
}

/** setDisplayName's body as a method, the way the patched file defines it. */
function setDisplayNameOf(source) {
  const start = source.indexOf('    async setDisplayName(');
  const end = source.indexOf('\n    async ', start + 1);
  const method = source.slice(start, end).trim().replace(/^async setDisplayName/, 'async function');
  return new Function('window', `return ${method};`);
}

/**
 * A page registry as WhatsApp Web has it on a headless session: the pushname action is absent
 * until the profile bundle arrives, and `window.require` answers `undefined` for it, not a throw.
 */
function fakePage({ canSet = true, bundled = false } = {}) {
  const set = [];
  const action = { setPushname: async (name) => set.push(name) };
  const modules = { WAWebConnModel: { Conn: { canSetMyPushname: () => canSet } } };
  if (bundled) modules.WAWebSetPushnameConnAction = action;
  let loads = 0;
  modules[LOADER] = {
    requireBundle: async () => {
      loads += 1;
      modules.WAWebSetPushnameConnAction = action;
    },
  };
  return { window: { require: (name) => modules[name] }, set, loads: () => loads };
}

async function callPatched(page, name) {
  const { root, client } = makeDependency(pristine());
  applyPushnameBundlePatch(root);
  const method = setDisplayNameOf(fs.readFileSync(client, 'utf8'))(page.window);
  const self = { pupPage: { evaluate: (fn, value) => fn(value) } };
  return method.call(self, name);
}

test('the installed tree still has the shape the patcher targets', () => {
  assert.equal(pristine().split(FIND).length - 1, 1, 'upstream no longer matches the setDisplayName() shape');
});

test('a rename on a page without the profile bundle loads it, then sets the name', async () => {
  const page = fakePage();
  assert.equal(await callPatched(page, 'Purnam'), true);
  assert.deepEqual(page.set, ['Purnam']);
  assert.equal(page.loads(), 1);
});

test('a page that already holds the bundle does not load it again', async () => {
  const page = fakePage({ bundled: true });
  assert.equal(await callPatched(page, 'Purnam'), true);
  assert.equal(page.loads(), 0);
});

test('an account that may not rename still answers false without loading anything', async () => {
  const page = fakePage({ canSet: false });
  assert.equal(await callPatched(page, 'Purnam'), false);
  assert.deepEqual(page.set, []);
  assert.equal(page.loads(), 0);
});

test('patches once, and is idempotent', () => {
  const { root, client } = makeDependency(pristine());
  assert.deepEqual(applyPushnameBundlePatch(root), {
    skipped: false,
    note: 'profile bundle loaded before a display-name change',
  });
  const patched = fs.readFileSync(client, 'utf8');
  assert.equal(patched.split(REPLACE).length - 1, 1);

  assert.deepEqual(applyPushnameBundlePatch(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already loads the profile bundle',
  });
  assert.equal(fs.readFileSync(client, 'utf8'), patched, 'a second run must not change Client.js');
});

test('isApplied tracks the transform, false before it runs and true after', () => {
  const { root } = makeDependency(pristine());
  assert.equal(isApplied(root), false);
  applyPushnameBundlePatch(root);
  assert.equal(isApplied(root), true);
});

test("stands down when setDisplayName already carries upstream's loader", () => {
  // wwebjs/whatsapp-web.js#201950 rewrites the call around the component, in its own words.
  const upstream = pristine().replace(
    FIND,
    `            if (!window.require('WAWebConnModel').Conn.canSetMyPushname())
                return false;
            const { setPushname } = await window.WWebJS.requireLazy(
                'WAWebSetPushnameConnAction',
                '${COMPONENT}',
            );
            await setPushname(displayName);`,
  );
  const { root, client } = makeDependency(upstream);
  assert.equal(isApplied(root), true);
  assert.equal(applyPushnameBundlePatch(root).skipped, true);
  assert.equal(fs.readFileSync(client, 'utf8'), upstream);
});

test('does not read a loader in a neighbouring method as the fix', () => {
  const neighbour = pristine().replace(
    '    async setDisplayName(',
    `    async other() {\n        await window.require('${LOADER}').requireBundle();\n    }\n\n    async setDisplayName(`,
  );
  const { root } = makeDependency(neighbour);
  assert.equal(isApplied(root), false);
  assert.equal(applyPushnameBundlePatch(root).skipped, false);
  assert.equal(isApplied(root), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, client } = makeDependency('class Client {}\n');
  assert.throws(() => applyPushnameBundlePatch(root), /unsupported setDisplayName\(\) shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), 'class Client {}\n');
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const twice = `${FIND}\n${FIND}\n`;
  const { root, client } = makeDependency(twice);
  assert.throws(() => applyPushnameBundlePatch(root), /unsupported setDisplayName\(\) shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), twice);
});

// A tree carrying both the fix and an unpatched call is not one the patch understands.
test('rejects a fix present alongside an unpatched call', () => {
  const both = `${REPLACE}\n${FIND}\n`;
  const { root, client } = makeDependency(both);
  assert.equal(isApplied(root), false);
  assert.throws(() => applyPushnameBundlePatch(root), /unsupported setDisplayName\(\) shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), both);
});
