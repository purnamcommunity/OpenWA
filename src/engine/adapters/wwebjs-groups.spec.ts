import { adminChangeResult, changeAdminStatusInPage } from './wwebjs-groups';

/**
 * changeAdminStatusInPage runs inside the WhatsApp Web page. These tests run it against a stand-in
 * `window` carrying the page modules it reads, shaped like the ones WA Web exposes: a group model
 * whose participant collection holds the local `canPromote`/`canDemote` gate, and the request jobs
 * under the UI action.
 */
describe('changeAdminStatusInPage', () => {
  const GROUP = '120363000@g.us';
  const COMMUNITY = '120363999@g.us';
  const ME = '1000@lid';
  const wid = (s: string) => ({ _serialized: s });

  type Member = { id: { _serialized: string }; isAdmin?: boolean; isSuperAdmin?: boolean };
  type Job = jest.Mock<Promise<unknown>, [unknown, unknown[], boolean]>;

  interface Setup {
    members?: Member[];
    announcement?: boolean;
    iAmAdmin?: boolean;
    gate?: boolean;
    groupLid?: boolean;
    parentLid?: boolean;
    /** requested id → the LID and phone forms enforceLidAndPnRetrieval answers for it */
    forms?: Record<string, { lid?: string; phone?: string }>;
    answer?: (target: unknown, wids: unknown[], isLid: boolean) => Promise<unknown>;
  }

  const setup = (o: Setup = {}) => {
    const members = new Map((o.members ?? []).map(m => [m.id._serialized, m]));
    const canPromote = jest.fn(() => o.gate ?? true);
    const canDemote = jest.fn(() => o.gate ?? true);
    const groupMetadata = {
      participants: { get: (id: string) => members.get(id), canPromote, canDemote },
      defaultSubgroup: o.announcement === true,
      parentGroup: o.announcement ? wid(COMMUNITY) : null,
      isLidAddressingMode: o.groupLid ?? true,
      isSuspendedOrTerminated: () => false,
    };
    const answer: NonNullable<Setup['answer']> =
      o.answer ?? ((_t, wids) => Promise.resolve({ participants: wids.map(w => ({ userWid: w, code: '200' })) }));
    const jobs: Record<string, Job> = {
      promoteGroupParticipants: jest.fn(answer),
      demoteGroupParticipants: jest.fn(answer),
      promoteCommunityParticipants: jest.fn(answer),
      demoteCommunityParticipants: jest.fn(answer),
    };
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { asUserWidOrThrow: (w: unknown) => w },
      WAWebUserPrefsMeUser: { isMeAccount: (w: { _serialized: string }) => w._serialized === ME },
      WAWebCollections: {
        Chat: {
          get: (w: { _serialized: string }) =>
            w._serialized === COMMUNITY ? { groupMetadata: { isLidAddressingMode: o.parentLid ?? true } } : undefined,
        },
      },
      WAWebGroupModifyParticipantsJob: jobs,
    };
    (globalThis as unknown as { window: unknown }).window = {
      require: (name: string) => modules[name],
      WWebJS: {
        getChat: () => Promise.resolve({ id: wid(GROUP), groupMetadata, iAmAdmin: () => o.iAmAdmin ?? true }),
        enforceLidAndPnRetrieval: (id: string) => {
          const f = o.forms?.[id] ?? { lid: id };
          return Promise.resolve({ lid: f.lid ? wid(f.lid) : undefined, phone: f.phone ? wid(f.phone) : undefined });
        },
      },
    };
    return { jobs, canPromote };
  };

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("promotes in a community's announcement group through the community-admin job on the parent", async () => {
    // WA Web's gate refuses every promote in an announcement group; its own "Make community admin"
    // flow sends the change to the parent community instead.
    const { jobs, canPromote } = setup({
      announcement: true,
      gate: false,
      parentLid: false,
      members: [{ id: wid('2000@lid') }],
    });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(outcome).toEqual({ community: COMMUNITY, participants: [{ member: true, code: '200' }] });
    expect(jobs.promoteCommunityParticipants).toHaveBeenCalledWith(wid(COMMUNITY), [wid('2000@lid')], false);
    expect(jobs.promoteGroupParticipants).not.toHaveBeenCalled();
    expect(canPromote).not.toHaveBeenCalled();
  });

  it('demotes in an announcement group through the community-admin job too', async () => {
    const { jobs } = setup({ announcement: true, members: [{ id: wid('2000@lid'), isAdmin: true }] });
    await changeAdminStatusInPage(GROUP, ['2000@lid'], false);
    expect(jobs.demoteCommunityParticipants).toHaveBeenCalledWith(wid(COMMUNITY), [wid('2000@lid')], true);
  });

  it('promotes in an ordinary group through the group job, with the group addressing mode', async () => {
    const { jobs } = setup({ groupLid: false, members: [{ id: wid('2000@lid') }] });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(outcome.community).toBeNull();
    expect(jobs.promoteGroupParticipants).toHaveBeenCalledWith(wid(GROUP), [wid('2000@lid')], false);
  });

  it('resolves a phone-number id to its member by the LID WhatsApp maps it to', async () => {
    const { jobs } = setup({
      members: [{ id: wid('2000@lid') }],
      forms: { '919000@c.us': { lid: '2000@lid', phone: '919000@c.us' } },
      // WhatsApp may answer under the phone form; the code still reaches the right entry.
      answer: () => Promise.resolve({ participants: [{ userWid: wid('919000@c.us'), code: '200' }] }),
    });
    const outcome = await changeAdminStatusInPage(GROUP, ['919000@c.us'], true);
    expect(outcome.participants).toEqual([{ member: true, code: '200' }]);
    expect(jobs.promoteGroupParticipants).toHaveBeenCalledTimes(1);
  });

  it('names the local gate refusal and never sends the request', async () => {
    const { jobs } = setup({ gate: false, members: [{ id: wid('2000@lid') }] });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(outcome.participants).toEqual([{ member: true, code: 'gate' }]);
    expect(jobs.promoteGroupParticipants).not.toHaveBeenCalled();
  });

  it('skips members already in the requested state, the own account and the creator', async () => {
    const { jobs } = setup({
      members: [
        { id: wid('2000@lid'), isAdmin: true },
        { id: wid(ME), isAdmin: true },
        { id: wid('3000@lid'), isAdmin: true, isSuperAdmin: true },
      ],
    });
    const promoted = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(promoted.participants).toEqual([{ member: true, code: 'unchanged' }]);
    const demoted = await changeAdminStatusInPage(GROUP, [ME, '3000@lid'], false);
    expect(demoted.participants).toEqual([
      { member: true, code: 'self' },
      { member: true, code: 'creator' },
    ]);
    expect(jobs.promoteGroupParticipants).not.toHaveBeenCalled();
    expect(jobs.demoteGroupParticipants).not.toHaveBeenCalled();
  });

  it('reports a requested id that is not a member without asking WhatsApp about it', async () => {
    const { jobs } = setup({ members: [{ id: wid('2000@lid') }] });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid', '9999@lid'], true);
    expect(outcome.participants).toEqual([
      { member: true, code: '200' },
      { member: false, code: null },
    ]);
    expect(jobs.promoteGroupParticipants).toHaveBeenCalledWith(wid(GROUP), [wid('2000@lid')], true);
  });

  it("returns WhatsApp's refusal as status and text instead of letting it cross the page minified", async () => {
    setup({
      announcement: true,
      members: [{ id: wid('2000@lid') }],
      answer: () => Promise.reject(Object.assign(new Error(''), { name: 't', status: 401, text: 'not-authorized' })),
    });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(outcome.error).toEqual({ status: 401, text: 'not-authorized' });
  });

  it("carries WhatsApp's per-participant codes, and marks one its answer left out", async () => {
    setup({
      announcement: true,
      members: [{ id: wid('2000@lid') }, { id: wid('3000@lid') }],
      answer: () => Promise.resolve({ participants: [{ userWid: wid('2000@lid'), code: '419' }] }),
    });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid', '3000@lid'], true);
    expect(outcome.participants).toEqual([
      { member: true, code: '419' },
      { member: true, code: 'missing' },
    ]);
  });

  it('refuses the batch when this account is not an admin', async () => {
    const { jobs } = setup({ announcement: true, iAmAdmin: false, members: [{ id: wid('2000@lid') }] });
    const outcome = await changeAdminStatusInPage(GROUP, ['2000@lid'], true);
    expect(outcome.refused).toBe('this account is not an admin of the community');
    expect(jobs.promoteCommunityParticipants).not.toHaveBeenCalled();
  });
});

describe('adminChangeResult', () => {
  it.each([
    ['200', true, true, 200, /made a community admin/],
    ['200', true, false, 200, /^made an admin$/],
    ['unchanged', true, false, 200, /already an admin — nothing to change/],
    ['403', false, true, 403, /only of members of the announcement group/],
    ['419', false, true, 419, /as many admins as WhatsApp allows/],
    ['419', false, false, 419, /code 419/],
    ['gate', false, false, 403, /will not promote/],
    ['500', false, false, 500, /code 500/],
  ] as const)('code %s (success %s, community %s) → %s', (code, success, community, status, message) => {
    const result = adminChangeResult('1@c.us', { member: true, code }, true, community);
    expect(result).toEqual(expect.objectContaining({ id: '1@c.us', success, status }));
    expect(result.message).toMatch(message);
  });

  it('reports a non-member as 404', () => {
    expect(adminChangeResult('1@c.us', { member: false, code: null }, true, false)).toEqual(
      expect.objectContaining({ success: false, status: 404 }),
    );
  });
});
