import { mapPageComments, probeMessageComments, submitMessageComment, type PageComment } from './wwebjs-comments';

/**
 * The reply thread is read out of WhatsApp Web internals that carry no compatibility promise, so
 * the contract these tests hold is mostly about DEGRADING: a renamed module must be reported, never
 * thrown, and never mistaken for "nobody replied".
 */

type PageRequire = (name: string) => unknown;
const withPageRequire = async <T>(require: PageRequire | undefined, run: () => Promise<T>): Promise<T> => {
  const global = globalThis as unknown as { require?: PageRequire };
  const previous = global.require;
  if (require) global.require = require;
  else delete global.require;
  try {
    return await run();
  } finally {
    if (previous) global.require = previous;
    else delete global.require;
  }
};

const PARENT = 'false_120363@g.us_3EB0PARENT_53331@lid';

/** A page whose comment table answers with `rows`, and whose MsgKey round-trips the id string. */
const pageWith = (rows: unknown[]): PageRequire => {
  const modules: Record<string, unknown> = {
    WAWebMsgKey: { fromString: (id: string) => ({ id }) },
    WAWebAddonCommentTableMode: {
      commentTableMode: { bulkGetByParentMsgKey: () => Promise.resolve(rows) },
    },
  };
  return (name: string) => {
    if (!(name in modules)) throw new Error(`module not found: ${name}`);
    return modules[name];
  };
};

describe('probeMessageComments', () => {
  it('reads a reply, taking the serialized id from the minified alias', async () => {
    // WhatsApp Web exposes a message key's string as `_serialized` on Wid objects but as a minified
    // alias on the key itself, so a build that only has `$1` must still produce an id.
    const rows = [
      {
        id: { $1: 'true_120363@g.us_3EB0REPLY_234@lid', fromMe: true },
        parentMsgKey: { _serialized: PARENT },
        author: { _serialized: '234@lid' },
        t: 1788239820,
        type: 'comment',
        body: '🙏🪷',
        ack: 1,
      },
    ];
    const result = await withPageRequire(pageWith(rows), () => probeMessageComments(PARENT));
    expect(result).toEqual({
      comments: [
        {
          id: 'true_120363@g.us_3EB0REPLY_234@lid',
          parentId: PARENT,
          author: '234@lid',
          timestamp: 1788239820,
          type: 'comment',
          body: '🙏🪷',
          revoked: false,
          fromMe: true,
          ack: 1,
        },
      ],
    });
  });

  it('keeps a deleted reply, which WhatsApp itself still shows in the thread', async () => {
    const rows = [
      {
        id: { _serialized: 'false_120363@g.us_3EB0GONE_999@lid' },
        parentMsgKey: { _serialized: PARENT },
        author: { _serialized: '999@lid' },
        t: 1788239700,
        revokeAddonType: 1,
        revokeTimestamp: 1788239800,
      },
    ];
    const result = await withPageRequire(pageWith(rows), () => probeMessageComments(PARENT));
    expect(result).toMatchObject({ comments: [{ revoked: true, body: null }] });
  });

  it.each([
    ['window.require', undefined],
    [
      'WAWebMsgKey',
      () => {
        throw new Error('gone');
      },
    ],
  ])('reports %s as unsupported rather than throwing', async (_label, require) => {
    const result = await withPageRequire(require, () => probeMessageComments(PARENT));
    expect(result).toHaveProperty('unsupported');
  });

  it('reports a renamed table method as unsupported, not as an empty thread', async () => {
    // The distinction that matters: an empty array is "asked, nobody replied", and showing that for
    // a build whose internals moved would report a thread of replies as unanswered.
    const require: PageRequire = (name: string) =>
      name === 'WAWebMsgKey' ? { fromString: (id: string) => ({ id }) } : { commentTableMode: {} };
    const result = await withPageRequire(require, () => probeMessageComments(PARENT));
    expect(result).toEqual({ unsupported: 'commentTableMode.bulkGetByParentMsgKey' });
  });
});

describe('submitMessageComment', () => {
  const sendPage = (over: Record<string, unknown> = {}): PageRequire => {
    const sent: unknown[] = [];
    const modules: Record<string, unknown> = {
      WAWebSendCommentMessageAction: {
        sendCommentMessage: (parent: unknown, text: string) => {
          sent.push({ parent, text });
          return Promise.resolve();
        },
      },
      WAWebCollections: { Msg: { get: (id: string) => ({ id }) } },
      ...over,
    };
    const require = ((name: string) => {
      if (!(name in modules)) throw new Error(`module not found: ${name}`);
      return modules[name];
    }) as PageRequire & { sent: unknown[] };
    require.sent = sent;
    return require;
  };

  it('posts the reply against the parent message model, as WhatsApp own reply box does', async () => {
    const require = sendPage() as PageRequire & { sent: { parent: { id: string }; text: string }[] };
    const result = await withPageRequire(require, () =>
      submitMessageComment({ parentMessageId: PARENT, text: 'hello' }),
    );
    expect(result).toEqual({ sent: true, confirmed: true });
    // The model, not the id: `sendCommentMessage` takes the message the way `sendReactionToMsg` does.
    expect(require.sent).toEqual([{ parent: { id: PARENT }, text: 'hello' }]);
  });

  it('falls back to the store for a message not held in memory', async () => {
    // An announcement worth replying to is usually older than what is loaded, so the in-memory
    // collection missing it is the NORMAL case, not an error.
    const require = sendPage({
      WAWebCollections: {
        Msg: {
          get: () => undefined,
          getMessagesById: () => Promise.resolve({ messages: [{ id: 'from-store' }] }),
        },
      },
    }) as PageRequire & { sent: { parent: { id: string } }[] };
    await withPageRequire(require, () => submitMessageComment({ parentMessageId: PARENT, text: 'x' }));
    expect(require.sent[0].parent).toEqual({ id: 'from-store' });
  });

  it('reports a message it cannot find rather than sending somewhere else', async () => {
    const require = sendPage({
      WAWebCollections: { Msg: { get: () => undefined, getMessagesById: () => Promise.resolve({ messages: [] }) } },
    }) as PageRequire & { sent: unknown[] };
    const result = await withPageRequire(require, () => submitMessageComment({ parentMessageId: PARENT, text: 'x' }));
    expect(result).toEqual({ notFound: true });
    expect(require.sent).toEqual([]);
  });

  it('reports a send WhatsApp never settles as sent but unconfirmed', async () => {
    // Measured against a live announcement: the reply reaches the thread while the promise
    // `sendCommentMessage` returns never settles. Waiting on it forever is what wedged the request,
    // and reporting failure would invite a second reply for one already posted.
    const require = sendPage({
      WAWebSendCommentMessageAction: { sendCommentMessage: () => new Promise(() => {}) },
    });
    const result = await withPageRequire(require, () => submitMessageComment({ parentMessageId: PARENT, text: 'x' }));
    expect(result).toEqual({ sent: true, confirmed: false });
  }, 15_000);

  it('reports a renamed send module as unsupported, and sends nothing', async () => {
    // A send is not retryable-by-guessing: reporting unsupported is what stops a caller believing
    // the reply landed.
    const require = sendPage({ WAWebSendCommentMessageAction: {} }) as PageRequire & { sent: unknown[] };
    const result = await withPageRequire(require, () => submitMessageComment({ parentMessageId: PARENT, text: 'x' }));
    expect(result).toEqual({ unsupported: 'sendCommentMessage' });
    expect(require.sent).toEqual([]);
  });
});

describe('mapPageComments', () => {
  const row = (over: Partial<PageComment>): PageComment => ({
    id: 'r1',
    parentId: PARENT,
    author: 'a@lid',
    timestamp: 1,
    type: 'comment',
    body: 'hi',
    revoked: false,
    fromMe: false,
    ack: 1,
    ...over,
  });

  it('orders oldest first, as the thread reads', () => {
    const out = mapPageComments(PARENT, [row({ id: 'later', timestamp: 20 }), row({ id: 'earlier', timestamp: 10 })]);
    expect(out.map(c => c.id)).toEqual(['earlier', 'later']);
  });

  it('drops a row the page could not identify', () => {
    // A reply with no id or author cannot be shown or acted on, and a half-row would render as a
    // blank entry that silently inflates the thread.
    expect(mapPageComments(PARENT, [row({ id: null }), row({ author: null })])).toEqual([]);
  });

  it('withholds the body of a deleted reply while keeping the reply', () => {
    const [comment] = mapPageComments(PARENT, [row({ revoked: true, body: 'was here' })]);
    expect(comment).toMatchObject({ revoked: true, body: null });
  });

  it('falls back to the asked-for parent when the row does not name one', () => {
    expect(mapPageComments(PARENT, [row({ parentId: null })])[0].parentMessageId).toBe(PARENT);
  });
});
