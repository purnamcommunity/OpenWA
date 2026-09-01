import { indexChatActivity, probeChatActivity, type PageChatActivity } from './wwebjs-chat-activity';

/**
 * The chat-list line for things that are not messages. WhatsApp keeps one per chat because an
 * add-on — a reply on an announcement, a reaction, a vote — moves a chat to the top of the list
 * while changing nothing a message read can see.
 */
type PageRequire = (name: string) => unknown;

const withPageRequire = <T>(require: PageRequire | undefined, run: () => T): T => {
  const global = globalThis as unknown as { require?: PageRequire };
  const previous = global.require;
  if (require) global.require = require;
  else delete global.require;
  try {
    return run();
  } finally {
    if (previous) global.require = previous;
    else delete global.require;
  }
};

const pageWith =
  (models: unknown[], me: string[] = []): PageRequire =>
  (name: string) => {
    if (name === 'WAWebCollections') return { Chat: { getModelsArray: () => models } };
    // Whether the account caused an add-on is the page's to answer — see the isMe tests below.
    if (name === 'WAWebUserPrefsMeUser') return { isSerializedWidMe: (wid: string) => me.includes(wid) };
    throw new Error(`module not found: ${name}`);
  };

describe('probeChatActivity', () => {
  it('reads the preview off each chat that has one', () => {
    const result = withPageRequire(
      pageWith([
        {
          id: { _serialized: '120363@g.us' },
          attributes: {
            chatlistPreview: {
              type: 'comment',
              sender: { _serialized: '234@lid' },
              timestamp: 1788256182000,
              parentMsgKey: { _serialized: 'false_120363@g.us_ABC_53331@lid' },
            },
          },
        },
      ]),
      () => probeChatActivity(),
    );
    expect(result).toEqual({
      activity: [
        {
          chatId: '120363@g.us',
          kind: 'comment',
          senderId: '234@lid',
          isMe: false,
          timestampMs: 1788256182000,
          parentMessageId: 'false_120363@g.us_ABC_53331@lid',
        },
      ],
    });
  });

  it('skips a chat with no preview rather than inventing one', () => {
    // Most chats have none: their newest thing is an ordinary message.
    const result = withPageRequire(pageWith([{ id: { _serialized: 'a@c.us' }, attributes: {} }]), () =>
      probeChatActivity(),
    );
    expect(result).toEqual({ activity: [] });
  });

  it.each([
    ['window.require', undefined],
    [
      'WAWebCollections',
      () => {
        throw new Error('gone');
      },
    ],
  ])('reports %s as unsupported rather than throwing', (_label, require) => {
    // The chat list is the feature; these lines are a detail on it. A renamed internal must cost
    // the detail, never the list.
    const result = withPageRequire(require, () => probeChatActivity());
    expect(result).toHaveProperty('unsupported');
  });
});

describe('probeChatActivity — whose activity it is', () => {
  const chatWith = (sender: string) => ({
    id: { _serialized: 'c@g.us' },
    attributes: {
      chatlistPreview: { type: 'comment', sender: { _serialized: sender }, timestamp: 1, parentMsgKey: null },
    },
  });

  it('marks the account’s own activity, across the lid it uses in a group', () => {
    // The point of asking the page: in a group this account is an @lid sharing no digits with its
    // own phone number, so nothing outside the page could match the two.
    const result = withPageRequire(pageWith([chatWith('234@lid')], ['234@lid']), () => probeChatActivity());
    expect(result).toMatchObject({ activity: [{ isMe: true }] });
  });

  it('does not claim someone else’s activity as the account’s own', () => {
    const result = withPageRequire(pageWith([chatWith('999@lid')], ['234@lid']), () => probeChatActivity());
    expect(result).toMatchObject({ activity: [{ isMe: false }] });
  });

  it('reports not-me when the page cannot say', () => {
    // A wrong name on the line is recoverable; a wrong "You" is not.
    const require: PageRequire = (name: string) => {
      if (name === 'WAWebCollections') return { Chat: { getModelsArray: () => [chatWith('234@lid')] } };
      throw new Error('no me-user module on this build');
    };
    expect(withPageRequire(require, () => probeChatActivity())).toMatchObject({ activity: [{ isMe: false }] });
  });
});

describe('indexChatActivity', () => {
  const row = (over: Partial<PageChatActivity> = {}): PageChatActivity => ({
    chatId: 'c@g.us',
    kind: 'comment',
    senderId: '234@lid',
    isMe: false,
    timestampMs: 1788256182000,
    parentMessageId: null,
    ...over,
  });

  it('converts to seconds, as every other timestamp on the interface is', () => {
    // The preview is milliseconds while the chat's own stamp is seconds; comparing the two raw
    // would make every add-on look newer than every message, forever.
    expect(indexChatActivity([row()]).get('c@g.us')?.timestamp).toBe(1788256182);
  });

  it('drops a preview with no timestamp instead of dating it to the epoch', () => {
    // The caller decides whether the add-on is newer than the last message; a zero would answer
    // "no" for every one of them.
    expect(indexChatActivity([row({ timestampMs: null })]).size).toBe(0);
  });

  it('omits the parent rather than carrying an empty one', () => {
    expect(indexChatActivity([row()]).get('c@g.us')).not.toHaveProperty('parentMessageId');
    expect(indexChatActivity([row({ parentMessageId: 'p' })]).get('c@g.us')?.parentMessageId).toBe('p');
  });
});
