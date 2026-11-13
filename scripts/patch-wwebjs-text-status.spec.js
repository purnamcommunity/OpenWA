'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyTextStatusPatch,
  isApplied,
  SET_FIND,
  SET_REPLACE,
  GET_FIND,
  GET_REPLACE,
  CLIENT_PATH,
  CONTACT_PATH,
  NEW_MODULE,
} = require('./patch-wwebjs-text-status.js');

/**
 * The fixtures are the INSTALLED files, with the transform reversed when postinstall already ran,
 * so the suite behaves the same before and after a local install.
 */
const INSTALLED = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

function pristine(file, find, replace) {
  const source = fs.readFileSync(path.join(INSTALLED, file), 'utf8');
  return source.includes(replace) ? source.replace(replace, find) : source;
}
const pristineClient = () => pristine(CLIENT_PATH, SET_FIND, SET_REPLACE);
const pristineContact = () => pristine(CONTACT_PATH, GET_FIND, GET_REPLACE);

function makeDependency(client = pristineClient(), contact = pristineContact()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-text-status-'));
  for (const [file, source] of [
    [CLIENT_PATH, client],
    [CONTACT_PATH, contact],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return { root, client: path.join(root, CLIENT_PATH), contact: path.join(root, CONTACT_PATH) };
}

/** One method of the patched file, as a function of `window`. */
function methodOf(source, name) {
  const start = source.indexOf(`    async ${name}(`);
  const end = source.indexOf('\n    async ', start + 1);
  const method = source
    .slice(start, end)
    .trim()
    .replace(new RegExp(`^async ${name}`), 'async function');
  return new Function('window', `return ${method};`);
}

/** A page registry as the current build has it: no setMyStatus/getStatus, the text bridge instead. */
function fakePage({ setResult = 'SUCCESS', textStatus = { text: 'Hello' } } = {}) {
  const sent = [];
  const local = [];
  const modules = {
    WAWebContactStatusBridge: { queryStatusAll() {}, sendReadStatus() {} },
    [NEW_MODULE]: {
      setTextStatus: async (text, emoji, duration) => {
        sent.push({ text, emoji, duration });
        return { result: setResult };
      },
      getTextStatus: async wid => ({ id: wid, ...textStatus }),
    },
    WAWebTextStatusUtils: { TEXT_STATUS_DURATION_INFINITE: -1 },
    WAWebContactCollection: { ContactCollection: { getMeContact: () => ({ id: 'me@c.us' }) } },
    WAWebUpdateTextStatusForContact: { updateTextStatusForContact: u => local.push(u) },
    WATimeUtils: { unixTime: () => 1700000000 },
    WAWebWidFactory: { createWid: id => `wid:${id}` },
  };
  return { window: { require: name => modules[name] }, sent, local };
}

const evaluate = (fn, value) => fn(value);

async function setStatus(page, text) {
  const { root, client } = makeDependency();
  applyTextStatusPatch(root);
  const method = methodOf(fs.readFileSync(client, 'utf8'), 'setStatus')(page.window);
  return method.call({ pupPage: { evaluate } }, text);
}

async function getAbout(page) {
  const { root, contact } = makeDependency();
  applyTextStatusPatch(root);
  const method = methodOf(fs.readFileSync(contact, 'utf8'), 'getAbout')(page.window);
  return method.call({ client: { pupPage: { evaluate } }, id: { _serialized: '123@c.us' } });
}

test('the installed tree still has the shapes the patcher targets', () => {
  assert.equal(pristineClient().split(SET_FIND).length - 1, 1, 'upstream no longer matches Client.setStatus()');
  assert.equal(pristineContact().split(GET_FIND).length - 1, 1, 'upstream no longer matches Contact.getAbout()');
});

test('setStatus sends plain text that never expires and updates the own contact', async () => {
  const page = fakePage();
  await setStatus(page, 'Available');
  assert.deepEqual(page.sent, [{ text: 'Available', emoji: null, duration: -1 }]);
  assert.equal(page.local.length, 1);
  assert.equal(page.local[0].textString, 'Available');
  assert.equal(page.local[0].contactId, 'me@c.us');
});

test('setStatus throws when WhatsApp refuses the change, and leaves the local copy alone', async () => {
  const page = fakePage({ setResult: 'FAILURE' });
  await assert.rejects(setStatus(page, 'Available'), /did not accept the About change/);
  assert.equal(page.local.length, 0);
});

test('getAbout returns the text, and null when the server refuses', async () => {
  assert.equal(await getAbout(fakePage()), 'Hello');
  assert.equal(await getAbout(fakePage({ textStatus: { error: new Error('401'), text: '' } })), null);
  assert.equal(await getAbout(fakePage({ textStatus: { text: null } })), null);
});

test('patches once, and is idempotent', () => {
  const { root, client, contact } = makeDependency();
  assert.equal(isApplied(root), false);
  assert.deepEqual(applyTextStatusPatch(root), {
    skipped: false,
    note: 'About text read and written through the text status bridge',
  });
  assert.equal(isApplied(root), true);
  const before = [fs.readFileSync(client, 'utf8'), fs.readFileSync(contact, 'utf8')];
  assert.equal(applyTextStatusPatch(root).skipped, true);
  assert.deepEqual([fs.readFileSync(client, 'utf8'), fs.readFileSync(contact, 'utf8')], before);
});

test('finishes a tree where only one of the two files was patched', () => {
  const { root, contact } = makeDependency(pristineClient(), pristineContact().replace(GET_FIND, GET_REPLACE));
  assert.equal(applyTextStatusPatch(root).skipped, false);
  assert.equal(isApplied(root), true);
  assert.equal(fs.readFileSync(contact, 'utf8').split(GET_REPLACE).length - 1, 1);
});

test('rejects an unknown shape without changing either file', () => {
  const { root, client, contact } = makeDependency('class Client {}\n');
  const before = fs.readFileSync(contact, 'utf8');
  assert.throws(() => applyTextStatusPatch(root), /unsupported About-text shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), 'class Client {}\n');
  assert.equal(fs.readFileSync(contact, 'utf8'), before, 'the good file must not be written alone');
});

test('rejects an ambiguous shape without changing it', () => {
  const twice = `${SET_FIND}\n${SET_FIND}\n`;
  const { root, client } = makeDependency(twice);
  assert.throws(() => applyTextStatusPatch(root), /unsupported About-text shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), twice);
});
