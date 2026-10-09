import { describe, expect, it, vi } from 'vitest';
import { callEndpoint, copyInlineQuery, endpointsAvailable, initializeTelegram, shareInline, type EndpointCallError, type TelegramWebApp } from '../src/telegram';

function telegram(overrides: Partial<TelegramWebApp> = {}): TelegramWebApp {
  return {
    version: '10.3', platform: 'android', colorScheme: 'dark',
    themeParams: { bg_color: '#17212b', text_color: '#ffffff', button_color: '#2481cc' },
    ready: vi.fn(), expand: vi.fn(), isVersionAtLeast: vi.fn(() => true),
    onEvent: vi.fn(), offEvent: vi.fn(),
    ...overrides,
  };
}

describe('Telegram endpoints', () => {
  it('passes results and endpoint errors through the authenticated bridge without forwarding a caller identity', async () => {
    const failure = Object.assign(new Error('Skin not found'), { type: 'ENDPOINT_ERROR', parameters: { code: 'NOT_FOUND' } });
    const call = vi.fn((_name: string, input: Record<string, unknown>, callback: (error: EndpointCallError | null, result?: unknown) => void) => {
      if (input.reference === 'missing') callback(failure);
      else callback(null, { card: { name: 'Notch' } });
    });
    const app = telegram({ initData: 'synthetic-init-data', Serverless: { call } });
    expect(endpointsAvailable(app)).toBe(true);
    await expect(callEndpoint(app, 'lookupSkin', { reference: 'Notch' })).resolves.toEqual({ card: { name: 'Notch' } });
    expect(call).toHaveBeenCalledWith('lookupSkin', { reference: 'Notch' }, expect.any(Function));
    await expect(callEndpoint(app, 'lookupSkin', { reference: 'missing' })).rejects.toBe(failure);
    app.initData = '';
    expect(endpointsAvailable(app)).toBe(false);
    await expect(callEndpoint(app, 'lookupSkin', { reference: 'Notch' })).rejects.toThrow('Open this Mini App in Telegram');
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe('Telegram inline handoff', () => {
  it.each([`skin texture:c-${'a'.repeat(64)}`, `view texture:s-${'a'.repeat(64)}`])('shares self-contained content through the chat chooser', (query) => {
    const switchInlineQuery = vi.fn();
    expect(shareInline(telegram({ switchInlineQuery }), query)).toBe('inline');
    expect(switchInlineQuery).toHaveBeenCalledWith(query, ['users', 'groups', 'channels']);
  });
  it.each(['older client', 'unavailable launch context'])('offers a copyable query for %s', (reason) => {
    const app = telegram({
      isVersionAtLeast: () => reason !== 'older client',
      switchInlineQuery: () => { throw new Error('WebAppInlineModeDisabled'); },
    });
    expect(shareInline(app, 'view 1234')).toBe('manual');
  });
  it('keeps a manual handoff in a plain browser', () => {
    expect(shareInline(undefined, 'view 1234')).toBe('manual');
  });
  it.each(['unavailable', 'rejected'])('keeps inline text selectable when clipboard is %s', async (mode) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } });
    const input = document.createElement('textarea');
    input.value = '@minecraft_skin_bot view texture:c-' + 'a'.repeat(64);
    document.body.append(input);
    expect(await copyInlineQuery(input)).toBe(false);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('WebView theme and insets', () => {
  it('updates live theme and combines device and Telegram content margins', () => {
    const events = new Map<string, () => void>();
    const app = telegram({
      safeAreaInset: { top: 24, bottom: 16 }, contentSafeAreaInset: { top: 40 },
      onEvent: (name, callback) => { events.set(name, callback); },
    });
    const cleanup = initializeTelegram(app);
    expect(document.documentElement.style.getPropertyValue('--tg-theme-bg-color')).toBe('#17212b');
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('64px');
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('16px');
    app.colorScheme = 'light';
    app.themeParams.bg_color = '#ffffff';
    app.contentSafeAreaInset = { top: 0 };
    events.get('themeChanged')?.();
    events.get('contentSafeAreaChanged')?.();
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--tg-theme-bg-color')).toBe('#ffffff');
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('24px');
    cleanup();
  });
});
