import { MessageComment } from '../interfaces/whatsapp-engine.interface';

/**
 * Replies to a community announcement — what WhatsApp shows behind a message's "N replies" — read
 * out of the page.
 *
 * These are NOT messages in the chat. WhatsApp stores them as message ADD-ONS, the same family as
 * reactions and poll votes (`WAWebAddonCommentTableMode` sits beside `WAWebAddonReactionTableMode`
 * and `WAWebAddonPollVoteTableMode`), keyed by the parent message. They therefore never appear in
 * `fetchMessages`, never raise a `message` event, and cannot be reached through any whatsapp-web.js
 * API — the chat's sort timestamp moving is the only trace an ordinary read sees.
 *
 * Everything here is a read of the local add-on table. No request is made to WhatsApp.
 */

/** A row as the page hands it over: plain data only, because it crosses the evaluate boundary. */
export interface PageComment {
  id: string | null;
  parentId: string | null;
  author: string | null;
  timestamp: number | null;
  type: string | null;
  body: string | null;
  revoked: boolean;
  fromMe: boolean;
  ack: number | null;
}

/** Either the rows, or the name of the page module that has moved — never a throw. See below. */
export type PageCommentResult = { comments: PageComment[] } | { unsupported: string };

/**
 * Runs INSIDE the page: the body is stringified, so it may not close over anything from this file.
 *
 * Every module lookup is feature-detected and reported as `unsupported` rather than thrown. These
 * are WhatsApp Web internals with no compatibility promise, and a rename must degrade to "this
 * build cannot show replies" — a caller that loses the whole message read because an add-on table
 * was renamed is a worse failure than a missing reply list.
 */
export async function probeMessageComments(parentMessageId: string): Promise<PageCommentResult> {
  const req = (globalThis as unknown as { require?: (name: string) => unknown }).require;
  if (typeof req !== 'function') return { unsupported: 'window.require' };

  let MsgKey: { fromString?: (id: string) => unknown } | undefined;
  let table: { bulkGetByParentMsgKey?: (keys: unknown[]) => Promise<unknown[]> } | undefined;
  try {
    MsgKey = req('WAWebMsgKey') as typeof MsgKey;
  } catch {
    return { unsupported: 'WAWebMsgKey' };
  }
  try {
    table = (req('WAWebAddonCommentTableMode') as { commentTableMode?: typeof table })?.commentTableMode;
  } catch {
    return { unsupported: 'WAWebAddonCommentTableMode' };
  }
  if (typeof MsgKey?.fromString !== 'function') return { unsupported: 'WAWebMsgKey.fromString' };
  if (typeof table?.bulkGetByParentMsgKey !== 'function') {
    return { unsupported: 'commentTableMode.bulkGetByParentMsgKey' };
  }

  // A key's serialized form is `_serialized` on the Wid objects but a minified alias on the message
  // key itself, so the string is taken from whichever of the three the current build carries. The
  // alias is not stable across WhatsApp Web releases; `toString()` is the fallback that is.
  const serialize = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown> & { toString?: () => string };
    for (const key of ['_serialized', '$1']) {
      if (typeof record[key] === 'string') return record[key];
    }
    const asString = typeof record.toString === 'function' ? record.toString() : null;
    return asString && asString !== '[object Object]' ? asString : null;
  };

  const rows = (await table.bulkGetByParentMsgKey([MsgKey.fromString(parentMessageId)])) ?? [];
  const comments = Array.from(rows).map((row): PageComment => {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = r.id as { fromMe?: boolean } | undefined;
    return {
      id: serialize(r.id),
      parentId: serialize(r.parentMsgKey),
      author: serialize(r.author) ?? serialize(r.from),
      timestamp: typeof r.t === 'number' ? r.t : null,
      type: typeof r.type === 'string' ? r.type : null,
      body: typeof r.body === 'string' ? r.body : null,
      // A deleted reply stays in the table carrying only its revoke marker: it is reported as a
      // comment so "this was deleted" can be shown where WhatsApp shows it, rather than silently
      // shrinking the list below the reply count the parent advertises.
      revoked: Boolean(r.revokeAddonType) || typeof r.revokeTimestamp === 'number',
      fromMe: Boolean(id?.fromMe),
      ack: typeof r.ack === 'number' ? r.ack : null,
    };
  });
  return { comments };
}

/** Either sent, or the reason it could not be — never a throw, for the reasons above. */
export type PageCommentSendResult = { sent: true } | { unsupported: string } | { notFound: true };

/**
 * Runs INSIDE the page: posts a reply into an announcement's thread.
 *
 * `sendCommentMessage(parentMessage, text)` is what WhatsApp Web's own "Add a reply" box calls, and
 * it takes the parent MESSAGE MODEL rather than an id — the same shape as `sendReactionToMsg`. The
 * model is resolved the way whatsapp-web.js resolves one for a reaction (`Client.js`): from the
 * in-memory collection first, then by asking the store, because an announcement worth replying to is
 * usually older than what is loaded.
 *
 * Feature-detected like the read: a build that has moved the module reports `unsupported` rather
 * than throwing, so a WhatsApp Web release degrades to "replying is unavailable" instead of a 500
 * on a send the caller cannot tell succeeded or failed.
 */
export async function submitMessageComment(input: {
  parentMessageId: string;
  text: string;
}): Promise<PageCommentSendResult> {
  const req = (globalThis as unknown as { require?: (name: string) => unknown }).require;
  if (typeof req !== 'function') return { unsupported: 'window.require' };

  let action: { sendCommentMessage?: (parent: unknown, text: string) => Promise<unknown> } | undefined;
  let collections:
    | {
        Msg?: {
          get?: (id: string) => unknown;
          getMessagesById?: (ids: string[]) => Promise<{ messages?: unknown[] } | undefined>;
        };
      }
    | undefined;
  try {
    action = req('WAWebSendCommentMessageAction') as typeof action;
  } catch {
    return { unsupported: 'WAWebSendCommentMessageAction' };
  }
  try {
    collections = req('WAWebCollections') as typeof collections;
  } catch {
    return { unsupported: 'WAWebCollections' };
  }
  if (typeof action?.sendCommentMessage !== 'function') {
    return { unsupported: 'sendCommentMessage' };
  }

  const Msg = collections?.Msg;
  const parent =
    Msg?.get?.(input.parentMessageId) ?? (await Msg?.getMessagesById?.([input.parentMessageId]))?.messages?.[0];
  // Not found is its own answer: replying to a message this account can no longer see is a 404,
  // not a failed send, and certainly not a comment posted somewhere else.
  if (!parent) return { notFound: true };

  await action.sendCommentMessage(parent, input.text);
  return { sent: true };
}

/** Drops rows the page could not identify: a comment with no id or author cannot be shown or acted on. */
export function mapPageComments(parentMessageId: string, rows: PageComment[]): MessageComment[] {
  return rows
    .filter((row): row is PageComment & { id: string; author: string } => Boolean(row.id && row.author))
    .map(row => ({
      id: row.id,
      parentMessageId: row.parentId ?? parentMessageId,
      authorId: row.author,
      timestamp: row.timestamp ?? 0,
      body: row.revoked ? null : row.body,
      revoked: row.revoked,
      fromMe: row.fromMe,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}
