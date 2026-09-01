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

/**
 * These two functions are STRINGIFIED and evaluated inside the browser, so anything they reference
 * from this module is undefined at the only moment that matters. Calling them directly — as every
 * other test here does — runs them in module scope, where such a reference resolves and the bug is
 * invisible.
 *
 * It is not a hypothetical: a settle timeout held in a module constant threw `ReferenceError` in the
 * page AFTER the send had already been dispatched, so the reply was posted and the caller was told
 * it had failed. These rebuild each function from its own source, exactly as the page does.
 */
describe('the page functions close over nothing from this module', () => {
  const rebuild = (fn: unknown) => new Function(`return (${String(fn)})`)() as typeof fn;

  const sendable: PageRequire = (name: string) => {
    if (name === 'WAWebSendCommentMessageAction') {
      return { sendCommentMessage: () => Promise.resolve() };
    }
    if (name === 'WAWebCollections') return { Msg: { get: (id: string) => ({ id }) } };
    throw new Error(`module not found: ${name}`);
  };

  it('probeMessageComments runs with only page globals in scope', async () => {
    const rebuilt = rebuild(probeMessageComments) as typeof probeMessageComments;
    const result = await withPageRequire(pageWith([]), () => rebuilt(PARENT));
    expect(result).toEqual({ comments: [] });
  });

  it('submitMessageComment runs with only page globals in scope', async () => {
    // The regression: this threw ReferenceError here while passing every direct-call test above.
    const rebuilt = rebuild(submitMessageComment) as typeof submitMessageComment;
    const result = await withPageRequire(sendable, () => rebuilt({ parentMessageId: PARENT, text: 'x' }));
    expect(result).toEqual({ sent: true, confirmed: true });
  });
});

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
          revokes: null,
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
    revokes: null,
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

  it('shows a deleted reply once, not twice, while both rows exist', () => {
    // Deleting does not edit the comment: WhatsApp writes a separate revoke row naming it and
    // removes the original a moment later. Both are present in between, and rendering them as they
    // come showed one deleted reply twice — once still carrying its text.
    const out = mapPageComments(PARENT, [
      row({ id: 'original', body: 'oops', timestamp: 10 }),
      row({ id: 'the-revoke', revoked: true, body: null, revokes: 'original', timestamp: 20 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'original', revoked: true, body: null });
  });

  it('keeps a revoke whose original has already gone, which is the steady state', () => {
    // Once WhatsApp removes the original, the revoke row IS the deleted entry — dropping it would
    // shrink the thread below the count the message advertises.
    const out = mapPageComments(PARENT, [row({ id: 'the-revoke', revoked: true, body: null, revokes: 'long-gone' })]);
    expect(out).toEqual([expect.objectContaining({ id: 'the-revoke', revoked: true, body: null })]);
  });

  it('withholds the body of a deleted reply while keeping the reply', () => {
    const [comment] = mapPageComments(PARENT, [row({ revoked: true, body: 'was here' })]);
    expect(comment).toMatchObject({ revoked: true, body: null });
  });

  it('falls back to the asked-for parent when the row does not name one', () => {
    expect(mapPageComments(PARENT, [row({ parentId: null })])[0].parentMessageId).toBe(PARENT);
  });
});
