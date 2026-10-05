import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const uuid = '069a79f444e94726a5befca90e38aaf5';
const hash = 'a'.repeat(64);

async function installFixtures(page: Page, model: 'classic' | 'slim' | 'unknown' = 'classic', legacy = false): Promise<void> {
  const png = await readFile(new URL(`./fixtures/${legacy ? 'legacy' : 'modern'}.png`, import.meta.url));
  const cape = await readFile(new URL('./fixtures/legacy.png', import.meta.url));
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(() => {
    const events = new Map<string, () => void>();
    const app = {
      platform: 'android', version: '10.3', colorScheme: 'dark',
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
  });
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
  await expect(page.getByLabel('Inline query', { exact: true })).toHaveValue(`@minecraft_skin_bot view upload:${hash}`);
  await expect(page.getByRole('link', { name: 'Open Telegram' })).toHaveAttribute('href', 'https://t.me/minecraft_skin_bot');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
    await viewer.load({ uuid, name: 'Skin', model: 'classic', reference: uuid, skin_url: `${location.origin}/api/skin/${hash}.png`, cape_url: null });
    const classicModel = viewer.skin.playerObject.skin.modelType;
    await viewer.load({ uuid, name: 'Skin', model: 'slim', reference: uuid, skin_url: `${location.origin}/api/skin/${hash}.png`, cape_url: `${location.origin}/api/cape/${hash}.png` });
    const model = viewer.skin.playerObject.skin.modelType;
    const capeVisible = viewer.skin.playerObject.cape.visible;
    viewer.setLayer('outer', false);
    const layersHidden = viewer.skin.playerObject.skin.head.outerLayer.visible === false;
    viewer.setAnimation('walk');
    const animation = viewer.skin.animation.constructor.name;
    viewer.skin.camera.position.set(100, 12, 40);
    viewer.reset();
    const cameraReset = Math.abs(viewer.skin.camera.position.x) < 1e-6 && Math.abs(viewer.skin.camera.position.y) < 1e-6 && viewer.skin.camera.position.z > 0;
    Object.assign(window, { verificationViewer: viewer });
    canvas.id = 'touch-verification';
    return { classicModel, model, capeVisible, layersHidden, animation, cameraReset, touchAction: canvas.style.touchAction };
  }, { uuid, hash });
  expect(result).toEqual({ classicModel: 'default', model: 'slim', capeVisible: true, layersHidden: true, animation: 'WalkingAnimation', cameraReset: true, touchAction: 'none' });

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
});

test('expired upload remains recoverable in the Mini App', async ({ page }) => {
  await installFixtures(page);
  await page.route(`**/api/upload/${hash}`, (route) => route.fulfill({ status: 410, json: { error: 'Upload expired' } }));
  await page.goto(`/?upload=${hash}`);
  await expect(page.locator('#status')).toHaveText('This upload has expired. Send the PNG to the bot again.');
  await expect(page.getByRole('button', { name: 'Share Skin', exact: true })).toBeDisabled();
});

test('plain browser shares a selectable query and opens the documented bot link', async ({ page }) => {
  await installFixtures(page);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: 'delete window.Telegram;', contentType: 'text/javascript' }));
  await page.goto(`/?upload=${hash}`);
  await expect(page.getByRole('button', { name: 'Share Three-view' })).toBeEnabled();
  await page.getByRole('button', { name: 'Share Three-view' }).click();
  const input = page.getByLabel('Inline query', { exact: true });
  await expect(input).toHaveValue(`@minecraft_skin_bot view upload:${hash}`);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return Promise.reject(new Error('Permission denied')); } } }));
  await page.getByRole('button', { name: 'Copy inline query' }).click();
  await expect(page.locator('#share-status')).toHaveText('Select and copy the query, then paste it into your target Telegram chat.');
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionEnd)).toBe(`@minecraft_skin_bot view upload:${hash}`.length);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.route('https://t.me/minecraft_skin_bot', (route) => route.fulfill({ body: 'Telegram bot handoff', contentType: 'text/plain' }));
  await page.getByRole('link', { name: 'Open Telegram' }).click();
  await page.waitForURL('https://t.me/minecraft_skin_bot');
  expect(page.url()).toBe('https://t.me/minecraft_skin_bot');
});
