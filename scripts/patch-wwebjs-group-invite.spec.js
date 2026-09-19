'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyGroupInvitePatches, isApplied, GROUPS, LOADER, GROUP_CHAT_PATH, CLIENT_PATH } = require(
  './patch-wwebjs-group-invite',
);

/**
 * The patcher rewrites files this repository does not own, so what has to hold is that it fires on
 * exactly the shapes it was written for, refuses everything else, and that the code it writes
 * reaches the invite jobs on a page that has not loaded them yet.
 *
 * The fixtures are the INSTALLED GroupChat.js and Client.js rather than hand-written
 * approximations. When postinstall already patched them, the transform is reversed to recover the
 * text upstream ships, so the suite behaves the same before and after a local install.
 */
const INSTALLED = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

function pristine(file) {
  let source = fs.readFileSync(path.join(INSTALLED, file), 'utf8');
  for (const group of GROUPS.filter((g) => g.file === file)) {
    if (source.includes(group.replace)) source = source.replace(group.replace, group.find);
  }
  return source;
}

/** A throwaway whatsapp-web.js tree holding the two files the patcher edits. */
function fakeWwjs({ groupChat = pristine(GROUP_CHAT_PATH), client = pristine(CLIENT_PATH) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-group-invite-'));
  fs.mkdirSync(path.join(dir, 'src', 'structures'), { recursive: true });
  fs.writeFileSync(path.join(dir, GROUP_CHAT_PATH), groupChat);
  fs.writeFileSync(path.join(dir, CLIENT_PATH), client);
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const group = (name) => GROUPS.find((g) => g.name === name);

/**
 * A page registry as WhatsApp Web has it on a headless session: the invite jobs are absent until
 * the loader's bundle arrives, and `window.require` answers `undefined` for them, not a throw.
 */
function fakePage(jobs) {
  const modules = {
    WAWebWidFactory: { createWid: (id) => ({ wid: id }) },
    WAWebGroupQueryJob: { queryGroupInvite: async () => ({ membershipApprovalMode: true }) },
  };
  let bundleLoads = 0;
  modules[LOADER] = {
    requireBundle: async () => {
      bundleLoads += 1;
      Object.assign(modules, jobs);
    },
  };
  return { window: { require: (name) => modules[name] }, loads: () => bundleLoads };
}

/** Run a group's replacement against a fake page, as the patched method would. */
async function runPatched(name, page, arg) {
  const { replace } = group(name);
  if (name === 'getInviteCode') {
    // The replacement is the whole page callback body.
    return new Function('window', `return async (chatId) => { ${replace} };`)(page.window)(arg);
  }
  const self = { id: { _serialized: arg }, client: {}, pupPage: { evaluate: (fn, value) => fn(value) } };
  self.client.pupPage = self.pupPage;
  const result = name === 'revokeInvite' ? 'codeRes' : 'res';
  return new Function('window', 'inviteCode', `return async function () { ${replace}\nreturn ${result}; };`)(
    page.window,
    arg,
  ).call(self);
}

test('the installed tree still has every shape the patcher targets', () => {
  for (const g of GROUPS) {
    assert.equal(pristine(g.file).split(g.find).length - 1, 1, `upstream no longer matches the ${g.name}() shape`);
  }
});

test('patches all three calls, and is idempotent', () => {
  const dir = fakeWwjs();
  const first = applyGroupInvitePatches({ wwjsDir: dir });
  assert.deepEqual(first.applied, ['getInviteCode', 'revokeInvite', 'acceptInvite']);
  assert.deepEqual(first.skipped, []);

  const groupChat = read(dir, GROUP_CHAT_PATH);
  const client = read(dir, CLIENT_PATH);
  assert.equal(groupChat.split(`.require('${LOADER}')`).length - 1, 2);
  assert.equal(client.split(`.require('${LOADER}')`).length - 1, 1);
  // The revoke no longer reaches for the module the function left.
  assert.ok(!methodOf(groupChat, 'revokeInvite').includes("require('WAWebGroupQueryJob')"));

  const second = applyGroupInvitePatches({ wwjsDir: dir });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['getInviteCode', 'revokeInvite', 'acceptInvite']);
  assert.equal(read(dir, GROUP_CHAT_PATH), groupChat, 'a second run must not change GroupChat.js');
  assert.equal(read(dir, CLIENT_PATH), client, 'a second run must not change Client.js');
  fs.rmSync(dir, { recursive: true, force: true });
});

function methodOf(source, name) {
  const start = source.indexOf(`    async ${name}(`);
  return source.slice(start, source.indexOf('\n    async ', start + 1));
}

test('isApplied tracks the transform, false before it runs and true after', () => {
  const dir = fakeWwjs();
  assert.equal(isApplied(dir), false);
  applyGroupInvitePatches({ wwjsDir: dir });
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a half-patched tree reads as not applied and gets the missing calls', () => {
  const g = group('getInviteCode');
  const dir = fakeWwjs({ groupChat: pristine(GROUP_CHAT_PATH).replace(g.find, g.replace) });
  assert.equal(isApplied(dir), false);
  const result = applyGroupInvitePatches({ wwjsDir: dir });
  assert.deepEqual(result.applied, ['revokeInvite', 'acceptInvite']);
  assert.deepEqual(result.skipped, ['getInviteCode']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a call that already carries upstream's loader stands down on its own", () => {
  // The upstream fix rewrites the code read around the same loader, in its own words.
  const upstream = pristine(GROUP_CHAT_PATH).replace(
    group('getInviteCode').find,
    `            try {
                let job = window.require('WAWebMexFetchGroupInviteCodeJob');
                if (!job) {
                    await window.require('${LOADER}').requireBundle();
                    job = window.require('WAWebMexFetchGroupInviteCodeJob');
                }
                return await job.fetchMexGroupInviteCode(chatId);
            } catch (err) {
                throw err;
            }`,
  );
  const dir = fakeWwjs({ groupChat: upstream });
  const result = applyGroupInvitePatches({ wwjsDir: dir });
  assert.deepEqual(result.skipped, ['getInviteCode']);
  assert.deepEqual(result.applied, ['revokeInvite', 'acceptInvite']);
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape and leaves both files untouched', () => {
  const client = pristine(CLIENT_PATH).replace('.joinGroupViaInvite(inviteCode);', '.joinGroup(inviteCode);');
  const dir = fakeWwjs({ client });
  const groupChatBefore = read(dir, GROUP_CHAT_PATH);
  assert.throws(() => applyGroupInvitePatches({ wwjsDir: dir }), /acceptInvite\(\) shape .*refusing to patch blind/);
  assert.equal(read(dir, GROUP_CHAT_PATH), groupChatBefore, 'a refusal must not write the other file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses a tree missing either file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-group-invite-empty-'));
  assert.throws(() => applyGroupInvitePatches({ wwjsDir: dir }), /GroupChat\.js not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getInviteCode loads the bundle, then answers the code', async () => {
  const seen = [];
  const page = fakePage({
    WAWebMexFetchGroupInviteCodeJob: { fetchMexGroupInviteCode: async (id) => (seen.push(id), 'AbC123') },
  });
  assert.equal(await runPatched('getInviteCode', page, '1203@g.us'), 'AbC123');
  assert.deepEqual(seen, ['1203@g.us']);
  assert.equal(page.loads(), 1);
});

test('getInviteCode skips the load when the job is already in the page', async () => {
  const page = fakePage({});
  page.window.require(LOADER).requireBundle = async () => assert.fail('loaded a bundle already present');
  const modules = { WAWebMexFetchGroupInviteCodeJob: { fetchMexGroupInviteCode: async () => 'AbC123' } };
  const window = { require: (name) => modules[name] ?? page.window.require(name) };
  assert.equal(await runPatched('getInviteCode', { window }, '1203@g.us'), 'AbC123');
});

test('getInviteCode answers undefined for a status refusal and for a null code', async () => {
  const statusError = Object.assign(new Error('401'), { name: 'ServerStatusCodeError' });
  for (const error of [statusError, new Error('[MEX][GROUP] group invite code is null')]) {
    const page = fakePage({
      WAWebMexFetchGroupInviteCodeJob: {
        fetchMexGroupInviteCode: async () => {
          throw error;
        },
      },
    });
    assert.equal(await runPatched('getInviteCode', page, '1203@g.us'), undefined);
  }
});

test('getInviteCode still throws anything else', async () => {
  const page = fakePage({
    WAWebMexFetchGroupInviteCodeJob: {
      fetchMexGroupInviteCode: async () => {
        throw new Error('socket closed');
      },
    },
  });
  await assert.rejects(runPatched('getInviteCode', page, '1203@g.us'), /socket closed/);
});

test('revokeInvite resets through WAWebGroupInviteJob with a Wid', async () => {
  const seen = [];
  const page = fakePage({
    WAWebGroupInviteJob: { resetGroupInviteCode: async (wid) => (seen.push(wid), { code: 'New456' }) },
  });
  assert.deepEqual(await runPatched('revokeInvite', page, '1203@g.us'), { code: 'New456' });
  assert.deepEqual(seen, [{ wid: '1203@g.us' }]);
  assert.equal(page.loads(), 1);
});

test("acceptInvite passes the invite's approval mode to the join", async () => {
  const seen = [];
  const page = fakePage({
    WAWebGroupInviteJob: {
      joinGroupViaInvite: async (...args) => (seen.push(args), { gid: { _serialized: '1203@g.us' } }),
    },
  });
  assert.deepEqual(await runPatched('acceptInvite', page, 'InvCode'), { gid: { _serialized: '1203@g.us' } });
  assert.deepEqual(seen, [['InvCode', true]]);
  assert.equal(page.loads(), 1);
});
