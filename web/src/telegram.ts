export interface TelegramWebApp {
  version: string;
  platform: string;
  initDataUnsafe?: { start_param?: string; user?: { language_code?: string } };
  themeParams: Record<string, string | undefined>;
  colorScheme: 'light' | 'dark';
  safeAreaInset?: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;
  contentSafeAreaInset?: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;
  ready(): void;
  expand(): void;
  isVersionAtLeast?(version: string): boolean;
  disableVerticalSwipes?(): void;
  switchInlineQuery?(query: string, types?: string[]): void;
  openTelegramLink?(url: string): void;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export function getTelegram(): TelegramWebApp | undefined {
  const app = window.Telegram?.WebApp;
  return app?.platform && app.platform !== 'unknown' ? app : undefined;
}

export function initializeTelegram(app: TelegramWebApp | undefined): () => void {
  if (!app) return () => {};
  const update = () => {
    const root = document.documentElement;
    root.style.colorScheme = app.colorScheme;
    for (const name of ['bg_color', 'text_color', 'hint_color', 'button_color', 'button_text_color', 'secondary_bg_color']) {
      const color = app.themeParams[name];
      if (color && /^#[a-f0-9]{6}$/i.test(color)) root.style.setProperty(`--tg-theme-${name.replaceAll('_', '-')}`, color);
    }
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const inset = [app.safeAreaInset?.[side], app.contentSafeAreaInset?.[side]]
        .reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(200, value)) : 0), 0);
      root.style.setProperty(`--safe-${side}`, `${inset}px`);
    }
  };
  const events = ['themeChanged', 'safeAreaChanged', 'contentSafeAreaChanged'];
  update();
  for (const event of events) app.onEvent(event, update);
  app.ready();
  app.expand();
  if (app.isVersionAtLeast?.('7.7')) app.disableVerticalSwipes?.();
  return () => { for (const event of events) app.offEvent(event, update); };
}

export function shareInline(app: TelegramWebApp | undefined, query: string): 'inline' | 'manual' {
  if (app?.switchInlineQuery && app.isVersionAtLeast?.('6.7')) {
    try {
      app.switchInlineQuery(query, ['users', 'groups', 'channels']);
      return 'inline';
    } catch { /* A launch context can reject switching; copyable query guidance remains available. */ }
  }
  return 'manual';
}

export async function copyInlineQuery(input: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(input.value);
    return true;
  } catch {
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    return false;
  }
}
