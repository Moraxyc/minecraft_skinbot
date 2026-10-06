import { afterEach, describe, expect, it } from 'vitest';
import { localizeDocument, translator, viewerLocale } from '../src/i18n';

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer language sources', () => {
  it('uses the Telegram display language before browser preferences', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh_Hans']) {
      expect(viewerLocale({ initDataUnsafe: { user: { language_code: tag } } }, ['en-US'])).toBe('zh-Hans');
    }
    for (const tag of ['en-US', 'zh-Hant', 'zh-TW', 'fr', '']) {
      expect(viewerLocale({ initDataUnsafe: { user: { language_code: tag } } }, ['zh-CN'])).toBe('en');
    }
    expect(viewerLocale({}, ['zh-CN'])).toBe('en');
  });

  it('uses supported browser preferences and English when none match', () => {
    expect(viewerLocale(undefined, ['fr-FR', 'zh-CN', 'en'])).toBe('zh-Hans');
    expect(viewerLocale(undefined, ['en-US', 'zh-CN'])).toBe('en');
    expect(viewerLocale(undefined, ['zh-Hant', 'de'])).toBe('en');
    expect(viewerLocale(undefined, [])).toBe('en');
  });

  it('uses the requested language for inline launches without a Telegram user', () => {
    expect(viewerLocale({}, [], 'zh-Hans')).toBe('zh-Hans');
    expect(viewerLocale({}, [], 'zh-CN')).toBe('zh-Hans');
    expect(viewerLocale({}, ['en-US'], 'zh-Hant')).toBe('en');
    expect(viewerLocale({}, [], 'fr')).toBe('en');
  });

  it('prefers the Telegram user language over the requested language inside Telegram', () => {
    expect(viewerLocale({ initDataUnsafe: { user: { language_code: 'en-US' } } }, [], 'zh-CN')).toBe('en');
    expect(viewerLocale({ initDataUnsafe: { user: { language_code: 'zh' } } }, [], 'en')).toBe('zh-Hans');
  });

  it('accepts the requested language when Telegram reports no user', () => {
    expect(viewerLocale({ initDataUnsafe: {} }, ['en-US'], 'zh-CN')).toBe('zh-Hans');
  });
});

it('localizes visible controls and accessibility labels while preserving player identity', () => {
  document.body.innerHTML = '<h1 id="name">Notch</h1><button data-i18n="reset">Reset camera</button><canvas data-i18n-aria="canvas"></canvas>';
  localizeDocument('zh-Hans');
  expect(document.documentElement.lang).toBe('zh-Hans');
  expect(document.title).toBe('Minecraft 皮肤查看器');
  expect(document.querySelector('button')?.textContent).toBe('重置视角');
  expect(document.querySelector('canvas')?.getAttribute('aria-label')).toBe('拖动旋转，双指或滚动缩放。');
  expect(document.getElementById('name')?.textContent).toBe('Notch');
  localizeDocument('en');
  expect(document.querySelector('button')?.textContent).toBe('Reset camera');
  expect(translator('zh-Hans')('uploadExpired')).toBe('上传已过期，请重新向机器人发送 PNG。');
});
