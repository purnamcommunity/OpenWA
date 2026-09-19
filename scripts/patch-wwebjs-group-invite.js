/**
 * Load WhatsApp Web's lazy invite-link bundle before whatsapp-web.js touches the invite jobs.
 *
 * `WAWebMexFetchGroupInviteCodeJob` and `WAWebGroupInviteJob` ship in the chunk WhatsApp Web
 * fetches only when a human opens "Invite to group via link". A headless page never opens it, so
 * both names are absent from the page registry and `window.require` answers `undefined` for them
 * instead of throwing. Three wwjs calls then fail inside the page:
 *
 * - `GroupChat.getInviteCode()` reads `.fetchMexGroupInviteCode` off `undefined`.
 * - `GroupChat.revokeInvite()` calls `WAWebGroupQueryJob.resetGroupInviteCode`, which is no longer
 *   there: the function now lives in `WAWebGroupInviteJob`, inside the same lazy chunk.
 * - `Client.acceptInvite()` reads `.joinGroupViaInvite` off `undefined`.
 *
 * `WAWebGroupInviteLinkDrawerLoadable.requireBundle()` loads the chunk, and each patched call runs
 * it only when its job is still missing, so a page that already holds the chunk pays nothing. The
 * bundle is cached, and a page reload drops it, so the check belongs to every call rather than to
 * startup.
 *
 * `joinGroupViaInvite(code, membershipApprovalMode)` takes the group's approval mode as its second
 * argument and parses the reply as a membership request when it is set, and as a joined group when
 * it is not. Joining a group that requires approval without it throws
 * `UnexpectedJoinGroupViaInviteResponse`, so `acceptInvite` reads the mode from the invite first,
 * as WhatsApp Web's own join action does.
 *
 * `fetchMexGroupInviteCode` throws a plain `err` reading "group invite code is null" when the query
 * answers no code, where the replaced job rejected with `ServerStatusCodeError`. Both mean "no code
 * for this account", which `getInviteCode` reports as `undefined`, so the caller's refusal mapping
 * sees the case it already handles.
 *
 * Signatures are read from the live page bundle (`WAWebGroupInviteJob`, `WAWebGroupInviteAction`,
 * `WAWebMexFetchGroupInviteCodeJob`); the loader is the one the open upstream fix uses
 * (wwebjs/whatsapp-web.js#201917, issue #201916), which covers the code read and the join but not
 * the revoke. Each call is its own group: a group already carrying the loader stands down, so a
 * library that ships the upstream fix leaves only the revoke to patch.
 *
 * Exact and self-disabling: an unknown shape fails the build rather than silently shipping without
 * the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const GROUP_CHAT_PATH = path.join('src', 'structures', 'GroupChat.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The loadable whose bundle holds both invite jobs. Its presence in a call means it is fixed. */
const LOADER = 'WAWebGroupInviteLinkDrawerLoadable';

const GROUPS = [
  {
    name: 'getInviteCode',
    file: GROUP_CHAT_PATH,
    find: `            try {
                return await window
                    .require('WAWebMexFetchGroupInviteCodeJob')
                    .fetchMexGroupInviteCode(chatId);
            } catch (err) {
                if (err.name === 'ServerStatusCodeError') return undefined;
                throw err;
            }`,
    replace: `            try {
                // The job ships in the lazy invite-link bundle a headless page never opens.
                if (!window.require('WAWebMexFetchGroupInviteCodeJob')) {
                    await window
                        .require('${LOADER}')
                        .requireBundle();
                }
                return await window
                    .require('WAWebMexFetchGroupInviteCodeJob')
                    .fetchMexGroupInviteCode(chatId);
            } catch (err) {
                if (err.name === 'ServerStatusCodeError') return undefined;
                // The MEX job's own "no code" answer, where the old job rejected with a status.
                if (/invite code is null/.test(err.message)) return undefined;
                throw err;
            }`,
  },
  {
    name: 'revokeInvite',
    file: GROUP_CHAT_PATH,
    find: `        const codeRes = await this.client.pupPage.evaluate((chatId) => {
            const chatWid = window.require('WAWebWidFactory').createWid(chatId);
            return window
                .require('WAWebGroupQueryJob')
                .resetGroupInviteCode(chatWid);
        }, this.id._serialized);`,
    replace: `        const codeRes = await this.client.pupPage.evaluate(async (chatId) => {
            const chatWid = window.require('WAWebWidFactory').createWid(chatId);
            // resetGroupInviteCode moved to WAWebGroupInviteJob, in the lazy invite-link bundle.
            if (!window.require('WAWebGroupInviteJob')) {
                await window
                    .require('${LOADER}')
                    .requireBundle();
            }
            return await window
                .require('WAWebGroupInviteJob')
                .resetGroupInviteCode(chatWid);
        }, this.id._serialized);`,
  },
  {
    name: 'acceptInvite',
    file: CLIENT_PATH,
    find: `        const res = await this.pupPage.evaluate(async (inviteCode) => {
            return await window
                .require('WAWebGroupInviteJob')
                .joinGroupViaInvite(inviteCode);
        }, inviteCode);`,
    replace: `        const res = await this.pupPage.evaluate(async (inviteCode) => {
            // The approval mode picks how the join reply is parsed; without it a group that
            // requires approval throws UnexpectedJoinGroupViaInviteResponse.
            const inviteInfo = await window
                .require('WAWebGroupQueryJob')
                .queryGroupInvite(inviteCode);
            // The job ships in the lazy invite-link bundle a headless page never opens.
            if (!window.require('WAWebGroupInviteJob')) {
                await window
                    .require('${LOADER}')
                    .requireBundle();
            }
            return await window
                .require('WAWebGroupInviteJob')
                .joinGroupViaInvite(
                    inviteCode,
                    inviteInfo.membershipApprovalMode,
                );
        }, inviteCode);`,
  },
];

/** The method body a group lives in, so the stand-down check cannot see a neighbour's loader. */
function methodBody(source, name) {
  const start = source.indexOf(`    async ${name}(`);
  if (start < 0) return null;
  const next = source.indexOf('\n    async ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Ours, or upstream's own loader in the same method: either way the call no longer needs us. */
function groupDone(source, group) {
  if (source.includes(group.replace)) return true;
  const body = methodBody(source, group.name);
  return body !== null && body.includes(LOADER) && !body.includes(group.find);
}

/**
 * Every group's stand-down branch as one predicate, for the startup guard
 * (engine-patch-status.ts). A half-patched tree reads as NOT applied: whichever call is missing its
 * loader still fails in the page. Unreadable reads as applied, since a tree we cannot inspect is
 * not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const sources = {};
    for (const file of [GROUP_CHAT_PATH, CLIENT_PATH]) {
      sources[file] = fs.readFileSync(path.join(wwjsDir, file), 'utf8');
    }
    return GROUPS.every((group) => groupDone(sources[group.file], group));
  } catch {
    return true;
  }
}

function applyGroupInvitePatches({ wwjsDir = DEFAULT_WWJS } = {}) {
  const sources = {};
  for (const file of [GROUP_CHAT_PATH, CLIENT_PATH]) {
    const full = path.join(wwjsDir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`whatsapp-web.js ${path.basename(file)} not found at ${full}`);
    }
    sources[file] = fs.readFileSync(full, 'utf8');
  }

  // Every group is checked before anything is written, so a refusal leaves both files untouched.
  const applied = [];
  const skipped = [];
  for (const group of GROUPS) {
    const source = sources[group.file];
    if (groupDone(source, group)) {
      skipped.push(group.name);
      continue;
    }
    if (source.split(group.find).length - 1 !== 1) {
      throw new Error(`unexpected ${group.name}() shape in ${group.file}: refusing to patch blind`);
    }
    sources[group.file] = source.replace(group.find, group.replace);
    applied.push(group);
  }

  for (const file of new Set(applied.map((group) => group.file))) {
    fs.writeFileSync(path.join(wwjsDir, file), sources[file]);
  }
  return { applied: applied.map((group) => group.name), skipped };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, skipped } = applyGroupInvitePatches();
    const report = [
      ...applied.map((name) => `applied ${name}`),
      ...skipped.map((name) => `skipped ${name} (already present)`),
    ].join('; ');
    console.log(`patch-wwebjs-group-invite: ${report}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-group-invite: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-group-invite: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyGroupInvitePatches, isApplied, GROUPS, LOADER, GROUP_CHAT_PATH, CLIENT_PATH };
