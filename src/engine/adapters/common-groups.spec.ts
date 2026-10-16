import type { Client } from 'whatsapp-web.js';
import type { GroupMetadata, WASocket } from '@whiskeysockets/baileys';
import { WwebjsContacts } from './wwebjs-contacts';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';

/**
 * Groups in common with one contact. A person is listed in most groups under their privacy id
 * (`@lid`), whose digits share nothing with their phone, so both engines must find them from either
 * id — and neither may turn an unanswered lookup into "no groups in common".
 */

const logger = createLogger('common-groups.spec');

describe('WwebjsContacts.getCommonGroups', () => {
  function makeContacts(names: Record<string, { name?: string; formattedTitle?: string }>) {
    const evaluate = jest.fn((fn: (ids: string[]) => unknown, ids: string[]) => {
      const g = globalThis as unknown as { window?: unknown };
      const previous = g.window;
      g.window = { require: () => ({ Chat: { get: (id: string) => names[id] } }) };
      try {
        return Promise.resolve(fn(ids));
      } finally {
        g.window = previous;
      }
    });
    const client = { getCommonGroups: jest.fn(), pupPage: { evaluate } };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return { contacts: new WwebjsContacts(host), client, evaluate };
  }

  it('names each group from the chat collection in one page call', async () => {
    const { contacts, client, evaluate } = makeContacts({
      '120363001@g.us': { name: 'Volunteers' },
      '120363002@g.us': { formattedTitle: 'Organisers' },
    });
    client.getCommonGroups.mockResolvedValue([{ _serialized: '120363001@g.us' }, { _serialized: '120363002@g.us' }]);

    await expect(contacts.getCommonGroups('628111@c.us')).resolves.toEqual([
      { id: '120363001@g.us', name: 'Volunteers' },
      { id: '120363002@g.us', name: 'Organisers' },
    ]);
    expect(client.getCommonGroups).toHaveBeenCalledWith('628111@c.us');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('reports a group the collection cannot name as null rather than dropping it', async () => {
    const { contacts, client } = makeContacts({});
    client.getCommonGroups.mockResolvedValue([{ _serialized: '120363003@g.us' }]);

    await expect(contacts.getCommonGroups('628111@c.us')).resolves.toEqual([{ id: '120363003@g.us', name: null }]);
  });

  it('skips the naming call when there are no groups in common', async () => {
    const { contacts, client, evaluate } = makeContacts({});
    client.getCommonGroups.mockResolvedValue([]);

    await expect(contacts.getCommonGroups('628111@c.us')).resolves.toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('BaileysGroups.getCommonGroups', () => {
  const group = (id: string, subject: string, participants: GroupMetadata['participants'], extra = {}) =>
    ({ id, subject, participants, ...extra }) as GroupMetadata;

  function makeGroups(all: Record<string, GroupMetadata> | Promise<never>, lidToPhone: Record<string, string> = {}) {
    const addLidMappings = jest.fn();
    const host = {
      ensureReady: () => undefined,
      getSocket: () => ({ groupFetchAllParticipating: jest.fn(() => Promise.resolve(all)) }) as unknown as WASocket,
      logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      // The session's lid map: a lid it has learned folds to the phone, anything else to the neutral dialect.
      toNeutralJid: (j: string) => lidToPhone[j] ?? j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      addLidMappings,
    } as unknown as BaileysGroupsHost;
    return { groups: new BaileysGroups(host, 20), addLidMappings };
  }

  it('finds a member listed by phone', async () => {
    const { groups } = makeGroups({
      a: group('120363001@g.us', 'Volunteers', [{ id: '628111@s.whatsapp.net' }]),
      b: group('120363002@g.us', 'Elsewhere', [{ id: '628999@s.whatsapp.net' }]),
    });

    await expect(groups.getCommonGroups('628111@c.us')).resolves.toEqual([
      { id: '120363001@g.us', name: 'Volunteers' },
    ]);
  });

  it("finds a member listed by lid from their phone id, through the roster's phone twin", async () => {
    const { groups } = makeGroups({
      a: group('120363001@g.us', 'Volunteers', [{ id: '99887766@lid', phoneNumber: '628111@s.whatsapp.net' }]),
    });

    await expect(groups.getCommonGroups('628111@c.us')).resolves.toEqual([
      { id: '120363001@g.us', name: 'Volunteers' },
    ]);
  });

  it("finds a member listed by lid alone, through the session's lid map", async () => {
    const { groups } = makeGroups(
      { a: group('120363001@g.us', 'Volunteers', [{ id: '99887766@lid' }]) },
      { '99887766@lid': '628111@c.us' },
    );

    await expect(groups.getCommonGroups('628111@c.us')).resolves.toEqual([
      { id: '120363001@g.us', name: 'Volunteers' },
    ]);
  });

  it('finds a member from their lid id', async () => {
    const { groups } = makeGroups({ a: group('120363001@g.us', 'Volunteers', [{ id: '99887766@lid' }]) });

    await expect(groups.getCommonGroups('99887766@lid')).resolves.toEqual([
      { id: '120363001@g.us', name: 'Volunteers' },
    ]);
  });

  it("leaves out a community's parent group", async () => {
    const { groups } = makeGroups({
      a: group('120363001@g.us', 'Community', [{ id: '628111@s.whatsapp.net' }], { isCommunity: true }),
    });

    await expect(groups.getCommonGroups('628111@c.us')).resolves.toEqual([]);
  });

  it("feeds the rosters' lid twins to the lid map", async () => {
    const { groups, addLidMappings } = makeGroups({
      a: group('120363001@g.us', 'Volunteers', [{ id: '99887766@lid', phoneNumber: '628555@s.whatsapp.net' }]),
    });

    await groups.getCommonGroups('628111@c.us');
    expect(addLidMappings).toHaveBeenCalledWith([{ lid: '99887766@lid', pn: '628555@s.whatsapp.net' }]);
  });

  it('reports an unanswered group query instead of "no groups in common"', async () => {
    const { groups } = makeGroups(new Promise<never>(() => undefined));

    await expect(groups.getCommonGroups('628111@c.us')).rejects.toBeInstanceOf(EngineTransportError);
  });
});
