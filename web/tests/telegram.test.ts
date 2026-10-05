import { describe, expect, it, vi } from 'vitest';
import { initializeTelegram, shareInline, telegramShareURL, type TelegramWebApp } from '../src/telegram';

function telegram(overrides: Partial<TelegramWebApp> = {}): TelegramWebApp {
  return {
    version: '10.3', platform: 'android', colorScheme: 'dark',
    themeParams: { bg_color: '#17212b', text_color: '#ffffff', button_color: '#2481cc' },
    ready: vi.fn(), expand: vi.fn(), isVersionAtLeast: vi.fn(() => true),
    onEvent: vi.fn(), offEvent: vi.fn(),
    ...overrides,
  };
}

describe('Telegram inline handoff', () => {
  it.each(['skin 069a79f444e94726a5befca90e38aaf5', `view upload:${'a'.repeat(64)}`])('shares self-contained content through the chat chooser', (query) => {
    const switchInlineQuery = vi.fn();
    expect(shareInline(telegram({ switchInlineQuery }), query, 'minecraft_skin_bot')).toBe('inline');
    expect(switchInlineQuery).toHaveBeenCalledWith(query, ['users', 'groups', 'channels']);
  });
  it.each(['older client', 'unavailable launch context'])('opens a public inline link for %s', (reason) => {
    const openTelegramLink = vi.fn();
    const app = telegram({
      openTelegramLink,
      isVersionAtLeast: () => reason !== 'older client',
      switchInlineQuery: () => { throw new Error('WebAppInlineModeDisabled'); },
    });
    expect(shareInline(app, 'view 1234', 'minecraft_skin_bot')).toBe('link');
    const url = new URL(openTelegramLink.mock.calls[0][0]);
    expect(url.origin).toBe('https://t.me');
    expect(url.pathname).toBe('/minecraft_skin_bot');
    expect(url.searchParams.get('startinline')).toBe('view 1234');
  });
  it('keeps a manual handoff when a bot link is unavailable', () => {
    expect(shareInline(undefined, 'view 1234', '')).toBe('manual');
    expect(telegramShareURL('https://attacker.example', 'view 1234')).toBeNull();
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
