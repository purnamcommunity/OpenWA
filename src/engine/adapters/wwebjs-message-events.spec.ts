import { EventEmitter } from 'events';
import { type Client } from 'whatsapp-web.js';
import { registerWwebjsMessageEvents } from './wwebjs-message-events';
import { type WwebjsEngineHost } from './wwebjs-host';

function ownSend(overrides: Record<string, unknown> = {}) {
  return {
    id: { _serialized: 'true_222@lid_3EB0AA' },
    from: '111@lid',
    to: '222@lid',
    fromMe: true,
    type: 'image',
    hasMedia: false,
    body: '/9j/4AAQSkZJRgABAQ',
    timestamp: 1790570855,
    ...overrides,
  };
}

function setup() {
  const client = new EventEmitter();
  const onMessageCreate = jest.fn<void, [Record<string, unknown>]>();
  const host = {
    getCallbacks: () => ({ onMessageCreate }),
    capInboundMediaFor: jest.fn(() => Promise.resolve({ mimetype: 'image/jpeg', data: 'aGVsbG8=' })),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  } as unknown as WwebjsEngineHost;
  registerWwebjsMessageEvents(client as unknown as Client, host);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { client, onMessageCreate, settle };
}

describe('own sends announced before their upload finished', () => {
  it('announces the message again, with caption and media, once the upload completes', async () => {
    const { client, onMessageCreate, settle } = setup();

    client.emit('message_create', ownSend());
    await settle();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessageCreate.mock.calls[0][0]).not.toHaveProperty('media');

    client.emit('media_uploaded', ownSend({ hasMedia: true, body: 'Sankalpa LIVE Today 8 PM' }));
    await settle();
    expect(onMessageCreate).toHaveBeenCalledTimes(2);
    expect(onMessageCreate.mock.calls[1][0]).toMatchObject({
      id: 'true_222@lid_3EB0AA',
      body: 'Sankalpa LIVE Today 8 PM',
      media: { mimetype: 'image/jpeg' },
    });
  });

  it('does not repeat a send whose first announcement already carried its media', async () => {
    const { client, onMessageCreate, settle } = setup();

    client.emit('message_create', ownSend({ hasMedia: true, body: 'caption' }));
    client.emit('media_uploaded', ownSend({ hasMedia: true, body: 'caption' }));
    await settle();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
  });

  it('announces a completed upload once, however often WhatsApp reports it', async () => {
    const { client, onMessageCreate, settle } = setup();

    client.emit('message_create', ownSend());
    client.emit('media_uploaded', ownSend({ hasMedia: true, body: 'caption' }));
    client.emit('media_uploaded', ownSend({ hasMedia: true, body: 'caption' }));
    await settle();
    expect(onMessageCreate).toHaveBeenCalledTimes(2);
  });

  it('never waits on a text message', async () => {
    const { client, onMessageCreate, settle } = setup();

    client.emit('message_create', ownSend({ type: 'chat', body: 'hello' }));
    client.emit('media_uploaded', ownSend({ type: 'chat', body: 'hello' }));
    await settle();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
  });
});
