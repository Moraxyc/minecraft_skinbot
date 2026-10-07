import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const uuid = '069a79f444e94726a5befca90e38aaf5';
const hash = 'a'.repeat(64);
const botUsername = 'resolved_skin_bot';

async function installFixtures(page: Page, model: 'classic' | 'slim' | 'unknown' = 'classic', legacy = false, language = 'en'): Promise<void> {
  const png = await readFile(new URL(`./fixtures/${legacy ? 'legacy' : 'modern'}.png`, import.meta.url));
  const cape = await readFile(new URL('./fixtures/legacy.png', import.meta.url));
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript((language) => {
    const events = new Map<string, () => void>();
    const app = {
      platform: 'android', version: '10.3', colorScheme: 'dark',
      initDataUnsafe: { user: { language_code: language } },
      themeParams: { bg_color: '#17212b', text_color: '#ffffff', hint_color: '#aabbcc', secondary_bg_color: '#232e3c', button_color: '#2481cc', button_text_color: '#ffffff' },
      safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 },
      contentSafeAreaInset: { top: 20, right: 0, bottom: 0, left: 0 },
      ready() {}, expand() {}, isVersionAtLeast() { return true; },
      onEvent(name: string, callback: () => void) { events.set(name, callback); },
      offEvent(name: string) { events.delete(name); },
      switchInlineQuery(query: string, types: string[]) { Object.assign(window, { lastInline: { query, types } }); },
      openTelegramLink(url: string) { Object.assign(window, { lastTelegramLink: url }); },
    };
    Object.assign(window, { Telegram: { WebApp: app }, telegramTestEvents: events });
  }, language);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({ body: url.pathname.includes('/cape/') ? cape : png, contentType: 'image/png' });
      return;
    }
    const upload = url.pathname.includes('/upload/');
    await route.fulfill({
      json: {
        uuid: upload ? null : uuid,
        name: upload ? 'Uploaded skin' : 'Notch', model,
        reference: upload ? `upload:${hash}` : uuid,
        skin_url: `${url.origin}/api/skin/${hash}.png`,
        cape_url: null,
        cape_unavailable: false,
        upload_expires_at: upload ? 2_100_000_000.5 : null,
        bot_username: botUsername,
      },
    });
  });
}

test('mobile WebGL viewer loads, rotates, zooms, resizes, themes, and shares both launch paths', async ({ page }) => {
  await installFixtures(page);
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Notch' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('main').evaluate((element) => getComputedStyle(element).paddingTop)).toBe('60px');

  const canvas = page.locator('#viewer');
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas has no visible dimensions');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  const rotated = await canvas.screenshot();
  expect(rotated.equals(before)).toBe(false);
  await page.getByRole('button', { name: 'Reset camera' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Outer', { exact: true }).uncheck();
  await page.getByLabel('Inner', { exact: true }).uncheck();
  expect((await canvas.screenshot()).equals(rotated)).toBe(false);
  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(async () => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeLessThanOrEqual(288);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.evaluate(() => {
    const state = window as unknown as { Telegram: { WebApp: { colorScheme: string; themeParams: { bg_color: string; text_color: string; secondary_bg_color: string } } }; telegramTestEvents: Map<string, () => void> };
    state.Telegram.WebApp.colorScheme = 'light';
    state.Telegram.WebApp.themeParams.bg_color = '#ffffff';
    state.Telegram.WebApp.themeParams.text_color = '#202b36';
    state.Telegram.WebApp.themeParams.secondary_bg_color = '#edf2f6';
    state.telegramTestEvents.get('themeChanged')?.();
  });
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(32, 43, 54)');
  await page.getByRole('button', { name: 'Share Three-view' }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`view ${uuid}`);

  await page.goto(`/?tgWebAppStartParam=u${Buffer.from(hash, 'hex').toString('base64url')}`);
  await expect(page.getByRole('heading', { name: 'Uploaded skin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share Skin', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Share Skin', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`skin upload:${hash}`);
  await page.evaluate(() => {
    (window as unknown as { Telegram: { WebApp: { switchInlineQuery(): void } } }).Telegram.WebApp.switchInlineQuery = () => { throw new Error('WebAppInlineModeDisabled'); };
  });
  await page.getByRole('button', { name: 'Share Three-view' }).click();
  await expect(page.getByLabel('Inline query', { exact: true })).toHaveValue(`@${botUsername} view upload:${hash}`);
  await expect(page.getByRole('link', { name: 'Open Telegram' })).toHaveAttribute('href', `https://t.me/${botUsername}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Chinese Telegram language localizes the viewer and errors while preserving share identity', async ({ page }) => {
  await installFixtures(page, 'slim', false, 'zh-CN');
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { name: 'Notch' })).toBeVisible();
  await expect(page.locator('#details')).toHaveText('模型: 纤细');
  await expect(page.locator('#viewer')).toHaveAttribute('aria-label', '拖动旋转，双指或滚动缩放。');
  await page.getByRole('button', { name: '分享三视图' }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`view ${uuid}`);
  await expect(page.locator('#share-status')).toHaveText('选择聊天，再选择内联结果。');
  await page.evaluate(() => { if (window.Telegram?.WebApp) delete window.Telegram.WebApp.switchInlineQuery; });
  await page.getByRole('button', { name: '分享皮肤', exact: true }).click();
  await expect(page.getByLabel('内联查询', { exact: true })).toHaveValue(`@${botUsername} skin ${uuid}`);
  await expect(page.getByRole('link', { name: '打开 Telegram' })).toHaveAttribute('href', `https://t.me/${botUsername}`);
  await expect(page.locator('#share-status')).toHaveText('复制查询并粘贴到目标 Telegram 聊天。');
  await page.route(`**/api/upload/${hash}`, (route) => route.fulfill({ status: 410, json: { error: 'raw upstream detail' } }));
  await page.goto(`/?upload=${hash}`);
  await expect(page.locator('#status')).toHaveText('上传已过期，请重新向机器人发送 PNG。');
  await expect(page.getByRole('button', { name: '分享三视图' })).toBeDisabled();
});

test('real renderer respects explicit slim metadata, layers, reset, legacy conversion, and touch controls', async ({ page }) => {
  await installFixtures(page, 'slim');
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  const result = await page.evaluate(async ({ uuid, hash }) => {
    const modulePath = '/src/viewer.ts';
    const { Viewer } = await import(modulePath);
    const canvas = document.createElement('canvas');
    const stage = document.createElement('div');
    stage.style.cssText = 'width:240px;height:320px;';
    stage.append(canvas);
    document.body.append(stage);
    const viewer = new Viewer(canvas, stage, () => {});
    await viewer.load({ uuid, name: 'Skin', model: 'classic', reference: uuid, skin_url: `${location.origin}/api/skin/${hash}.png`, cape_url: null, cape_unavailable: false, upload_expires_at: null, bot_username: 'resolved_skin_bot' });
    const classicModel = viewer.skin.playerObject.skin.modelType;
    await viewer.load({ uuid, name: 'Skin', model: 'slim', reference: uuid, skin_url: `${location.origin}/api/skin/${hash}.png`, cape_url: `${location.origin}/api/cape/${hash}.png`, cape_unavailable: false, upload_expires_at: null, bot_username: 'resolved_skin_bot' });
    const model = viewer.skin.playerObject.skin.modelType;
    const capeVisible = viewer.skin.playerObject.cape.visible;
    viewer.setLayer('outer', false);
    const layersHidden = viewer.skin.playerObject.skin.head.outerLayer.visible === false;
    viewer.setAnimation('walk');
    const animation = viewer.skin.animation.constructor.name;
    viewer.skin.camera.position.set(100, 12, 40);
    viewer.reset();
    const cameraReset = Math.abs(viewer.skin.camera.position.x) < 1e-6 && Math.abs(viewer.skin.camera.position.y) < 1e-6 && viewer.skin.camera.position.z > 0;
    const distance = viewer.skin.camera.position.length();
    viewer.zoom('in');
    const zoomsIn = viewer.skin.camera.position.length() < distance;
    viewer.zoom('out');
    const zoomRestored = Math.abs(viewer.skin.camera.position.length() - distance) < 1e-6;
    Object.assign(window, { verificationViewer: viewer });
    canvas.id = 'touch-verification';
    return { classicModel, model, capeVisible, layersHidden, animation, cameraReset, zoomsIn, zoomRestored, touchAction: canvas.style.touchAction };
  }, { uuid, hash });
  expect(result).toEqual({ classicModel: 'default', model: 'slim', capeVisible: true, layersHidden: true, animation: 'WalkingAnimation', cameraReset: true, zoomsIn: true, zoomRestored: true, touchAction: 'none' });

  const touchCanvas = page.locator('#touch-verification');
  await touchCanvas.scrollIntoViewIfNeeded();
  const box = await touchCanvas.boundingBox();
  if (!box) throw new Error('Touch canvas unavailable');
  const session = await page.context().newCDPSession(page);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + 60, y: startY }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await page.evaluate(() => (window as unknown as { verificationViewer: { skin: { camera: { position: { x: number } } } } }).verificationViewer.skin.camera.position.x)).not.toBe(0);

  const zoomBefore = await page.evaluate(() => {
    const v = (window as unknown as { verificationViewer: { skin: { camera: { position: { length(): number } } } } }).verificationViewer;
    return v.skin.camera.position.length();
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX - 20, y: startY }, { x: startX + 20, y: startY }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - 40, y: startY }, { x: startX + 40, y: startY }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const zoomAfter = await page.evaluate(() => (window as unknown as { verificationViewer: { skin: { camera: { position: { length(): number } } } } }).verificationViewer.skin.camera.position.length());
  expect(zoomAfter).toBeLessThan(zoomBefore);
  await session.detach();

  await installFixtures(page, 'unknown', true);
  await page.goto(`/?upload=${hash}`);
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  await expect(page.locator('#details')).toHaveText('Model: Unknown');
  await expect(page.getByLabel('Preview model', { exact: true })).toBeHidden();
});

test('keyboard camera controls and upload model overrides work while motion is paused', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installFixtures(page, 'unknown');
  await page.goto(`/?upload=${hash}`);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  const canvas = page.locator('#viewer');
  const front = await canvas.screenshot();
  await page.waitForTimeout(160);
  expect((await canvas.screenshot()).equals(front)).toBe(true);
  await page.getByRole('button', { name: 'Side', exact: true }).focus();
  await page.keyboard.press('Enter');
  const side = await canvas.screenshot();
  expect(side.equals(front)).toBe(false);
  await page.getByRole('button', { name: 'Back', exact: true }).focus();
  await page.keyboard.press('Space');
  expect((await canvas.screenshot()).equals(side)).toBe(false);
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect.poll(async () => (await canvas.screenshot()).equals(front)).toBe(true);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect((await canvas.screenshot()).equals(front)).toBe(false);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  expect((await canvas.screenshot()).equals(front)).toBe(true);

  const model = page.getByLabel('Preview model', { exact: true });
  await model.selectOption('slim');
  const slim = await canvas.screenshot();
  await model.selectOption('classic');
  expect((await canvas.screenshot()).equals(slim)).toBe(false);
  await model.selectOption('auto');
  expect((await canvas.screenshot()).equals(front)).toBe(true);
  await expect(page.locator('#details')).toHaveText('Model: Unknown');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const running = await canvas.screenshot();
  await page.waitForTimeout(160);
  expect((await canvas.screenshot()).equals(running)).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await canvas.screenshot();
  await page.waitForTimeout(160);
  expect((await canvas.screenshot()).equals(paused)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  await expect(model).toBeHidden();
});

test('uploads display the server expiry and explain how to recover expired links', async ({ page }) => {
  await installFixtures(page);
  await page.goto(`/?upload=${hash}`);
  const expires = await page.evaluate(() => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(2_100_000_000_500)));
  await expect(page.locator('#upload-expiry')).toBeVisible();
  await expect(page.locator('#upload-expiry')).toHaveText(`Available until ${expires} · Send the same PNG again to renew its links.`);
  await page.route(`**/api/upload/${hash}`, (route) => route.fulfill({ status: 410, json: { error: 'Upload expired' } }));
  await page.goto(`/?upload=${hash}`);
  await expect(page.locator('#status')).toHaveText('This upload has expired. Send the PNG to the bot again.');
  await expect(page.getByRole('button', { name: 'Share Skin', exact: true })).toBeDisabled();
});

test('retry recovers a profile outage and WebGL failure while sharing stays available', async ({ page }) => {
  await installFixtures(page);
  await page.addInitScript(() => {
    const state = window as unknown as { webGLUnavailable: boolean };
    state.webGLUnavailable = true;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId, options) {
      if (state.webGLUnavailable && (contextId.startsWith('webgl') || contextId === 'experimental-webgl')) return null;
      return getContext.call(this, contextId, options);
    } as typeof getContext;
  });
  await page.route(`**/api/profile/${uuid}`, (route) => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.locator('#status')).toHaveText('Skin service is busy. Try again.');
  await expect(page.getByRole('button', { name: 'Share Skin', exact: true })).toBeDisabled();
  await page.unroute(`**/api/profile/${uuid}`);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('The 3D viewer is unavailable. Try again.');
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Share Three-view' })).toBeEnabled();
  await page.getByRole('button', { name: 'Share Three-view' }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`view ${uuid}`);
  await page.evaluate(() => { (window as unknown as { webGLUnavailable: boolean }).webGLUnavailable = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeEnabled();
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Walk', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a failed optional cape retains a usable skin, including an upstream cape warning', async ({ page }) => {
  await installFixtures(page, 'classic', false, 'zh-CN');
  await page.route(`**/api/profile/${uuid}`, (route) => route.fulfill({
    json: { uuid, name: 'Notch', model: 'classic', reference: uuid, skin_url: `${new URL(route.request().url()).origin}/api/skin/${hash}.png`, cape_url: `${new URL(route.request().url()).origin}/api/cape/${hash}.png`, cape_unavailable: false, upload_expires_at: null, bot_username: botUsername },
  }));
  await page.route(`**/api/cape/${hash}.png`, (route) => route.fulfill({ status: 503 }));
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await expect(page.locator('#viewer-notice')).toHaveText('披风暂不可用，仍可查看和分享皮肤。');
  await page.getByRole('button', { name: '分享皮肤', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`skin ${uuid}`);
  await page.route(`**/api/profile/${uuid}`, (route) => route.fulfill({
    json: { uuid, name: 'Notch', model: 'classic', reference: uuid, skin_url: `${new URL(route.request().url()).origin}/api/skin/${hash}.png`, cape_url: null, cape_unavailable: true, upload_expires_at: null, bot_username: botUsername },
  }));
  await page.goto(`/?uuid=${uuid}`);
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await expect(page.locator('#viewer-notice')).toHaveText('披风暂不可用，仍可查看和分享皮肤。');
});

test('plain browser shares a selectable query and opens the documented bot link', async ({ page }) => {
  await installFixtures(page);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: 'delete window.Telegram;', contentType: 'text/javascript' }));
  await page.goto(`/?upload=${hash}`);
  await expect(page.getByRole('button', { name: 'Share Three-view' })).toBeEnabled();
  await page.getByRole('button', { name: 'Share Three-view' }).click();
  const input = page.getByLabel('Inline query', { exact: true });
  await expect(input).toHaveValue(`@${botUsername} view upload:${hash}`);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return Promise.reject(new Error('Permission denied')); } } }));
  await page.getByRole('button', { name: 'Copy inline query' }).click();
  await expect(page.locator('#share-status')).toHaveText('Select and copy the query, then paste it into your target Telegram chat.');
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionEnd)).toBe(`@${botUsername} view upload:${hash}`.length);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.route(`https://t.me/${botUsername}`, (route) => route.fulfill({ body: 'Telegram bot handoff', contentType: 'text/plain' }));
  await page.getByRole('link', { name: 'Open Telegram' }).click();
  await page.waitForURL(`https://t.me/${botUsername}`);
  expect(page.url()).toBe(`https://t.me/${botUsername}`);
});
