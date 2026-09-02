import { Client } from 'whatsapp-web.js';
import configuration from '../../config/configuration';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

/**
 * The browser identity a session presents to WhatsApp Web.
 *
 * Two invariants worth pinning: a configured user agent reaches the Client, and an unset one
 * leaves whatsapp-web.js's own default exactly as it was. The second is the load-bearing half —
 * this knob exists to be opt-in, and a deployment that never sets it must launch identically to
 * one built before the knob existed.
 */
describe('whatsapp-web.js user agent', () => {
  const SESSION_ID = 'sess-user-agent';
  const MODERN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  const launchedUserAgent = async (userAgent?: string): Promise<string | false | undefined> => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: SESSION_ID,
      sessionDataPath: './data/sessions',
      puppeteer: { userAgent },
    });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { userAgent?: string | false } } }).client.options.userAgent;
  };

  beforeEach(() => {
    // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    // Build the real wwebjs Client — that is what carries the option — but launch no browser.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('hands a configured identity to the Client', async () => {
    expect(await launchedUserAgent(MODERN)).toBe(MODERN);
  });

  it('leaves the library default in place when unset', async () => {
    // Compared against a bare Client rather than a copied literal: the point is that the default
    // is UNTOUCHED, and a literal would keep passing after a library bump moved it.
    const libraryDefault = (new Client({}) as unknown as { options: { userAgent?: string } }).options.userAgent;

    expect(typeof libraryDefault).toBe('string');
    expect(await launchedUserAgent(undefined)).toBe(libraryDefault);
    expect(await launchedUserAgent(undefined)).not.toBe(MODERN);
  });

  it('reads a blank forward as unset rather than as an empty identity', () => {
    const parsed = (raw?: string): string | undefined => {
      const saved = process.env.PUPPETEER_USER_AGENT;
      if (raw === undefined) delete process.env.PUPPETEER_USER_AGENT;
      else process.env.PUPPETEER_USER_AGENT = raw;
      try {
        return (configuration() as { engine: { puppeteer: { userAgent?: string } } }).engine.puppeteer.userAgent;
      } finally {
        if (saved === undefined) delete process.env.PUPPETEER_USER_AGENT;
        else process.env.PUPPETEER_USER_AGENT = saved;
      }
    };

    // An empty compose forward must not reach Chromium as `--user-agent=`, which would announce a
    // blank identity — a louder anomaly than the stale default this knob exists to replace.
    expect(parsed(undefined)).toBeUndefined();
    expect(parsed('')).toBeUndefined();
    expect(parsed('   ')).toBeUndefined();
    expect(parsed(MODERN)).toBe(MODERN);
    expect(parsed(`  ${MODERN}  `)).toBe(MODERN);
  });
});
