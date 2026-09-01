import { ChatActivityPreview } from '../interfaces/whatsapp-engine.interface';

/**
 * The line a chat list shows when the newest thing in a chat is not a message.
 *
 * "You replied to an announcement", "X reacted to your message" — WhatsApp keeps one of these per
 * chat as `chatlistPreview`, because the events behind them are message ADD-ONS rather than
 * messages: they move the chat to the top of the list and change nothing a message read can see.
 * Without this a chat jumps to the top showing its previous message, which is what a reply to an
 * announcement looked like here.
 *
 * Read from the chat models already in memory for the chat list, so it costs one page call for the
 * whole list rather than one per chat.
 */

/**
 * Whatever the page called it. Deliberately just `string` here: this is the raw value read out of
 * WhatsApp Web, and narrowing it would invent a guarantee the page does not give — the named kinds
 * belong on the neutral `ChatActivityPreview`, where they document what callers can expect.
 */
export type PageActivityKind = string;

export interface PageChatActivity {
  chatId: string;
  kind: PageActivityKind;
  senderId: string | null;
  /** Unix MILLIseconds, unlike the chat's own `timestamp`, which is seconds. */
  timestampMs: number | null;
  parentMessageId: string | null;
}

export type PageChatActivityResult = { activity: PageChatActivity[] } | { unsupported: string };

/**
 * Runs INSIDE the page: the body is stringified, so it may not close over anything from this file.
 *
 * Feature-detected and never thrown from: a build that renames the field must cost the chat list its
 * activity lines, not the chat list itself.
 */
export function probeChatActivity(): PageChatActivityResult {
  const req = (globalThis as unknown as { require?: (name: string) => unknown }).require;
  if (typeof req !== 'function') return { unsupported: 'window.require' };

  let collections: { Chat?: { getModelsArray?: () => unknown[] } } | undefined;
  try {
    collections = req('WAWebCollections') as typeof collections;
  } catch {
    return { unsupported: 'WAWebCollections' };
  }
  const chats = collections?.Chat?.getModelsArray?.();
  if (!Array.isArray(chats)) return { unsupported: 'Chat.getModelsArray' };

  const serialize = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    for (const key of ['_serialized', '$1']) {
      const candidate = record[key];
      if (typeof candidate === 'string') return candidate;
    }
    return null;
  };

  const activity: PageChatActivity[] = [];
  for (const model of chats) {
    const chat = (model ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
    const chatId = serialize(chat.id);
    const preview = chat.attributes?.chatlistPreview as
      { type?: unknown; sender?: unknown; timestamp?: unknown; parentMsgKey?: unknown } | undefined;
    if (!chatId || !preview || typeof preview.type !== 'string') continue;
    activity.push({
      chatId,
      kind: preview.type,
      senderId: serialize(preview.sender),
      timestampMs: typeof preview.timestamp === 'number' ? preview.timestamp : null,
      parentMessageId: serialize(preview.parentMsgKey),
    });
  }
  return { activity };
}

/**
 * Index the page's answer by chat id, dropping what cannot be shown.
 *
 * A preview with no timestamp is discarded rather than defaulted: the caller decides whether the
 * add-on is newer than the chat's last message, and a zero would make every one of them look older.
 */
export function indexChatActivity(rows: PageChatActivity[]): Map<string, ChatActivityPreview> {
  const byChat = new Map<string, ChatActivityPreview>();
  for (const row of rows) {
    if (!row.chatId || row.timestampMs === null) continue;
    byChat.set(row.chatId, {
      kind: row.kind,
      senderId: row.senderId ?? '',
      // Seconds, to match every other timestamp this interface carries.
      timestamp: Math.floor(row.timestampMs / 1000),
      ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
    });
  }
  return byChat;
}
