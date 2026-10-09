import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const skinHash = 'a'.repeat(64);
const capeHash = 'b'.repeat(64);
const skinURL = `https://textures.minecraft.net/texture/${skinHash}`;
const capeURL = `https://textures.minecraft.net/texture/${capeHash}`;
const botUsername = 'minecraft_skin_bot';

async function installFixtures(page: Page, options: { legacy?: boolean; telegram?: boolean; language?: string; startParam?: string } = {}): Promise<Buffer> {
  const png = await readFile(new URL(`./fixtures/${options.legacy ? 'legacy' : 'modern'}.png`, import.meta.url));
  const cape = await readFile(new URL('./fixtures/legacy.png', import.meta.url));
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: '', contentType: 'text/javascript' }));
  if (options.telegram) {
    await page.addInitScript(({ language, startParam }) => {
      const events = new Map<string, () => void>();
      const app = {
        platform: 'android', version: '10.3', colorScheme: 'dark', initData: '',
        initDataUnsafe: { start_param: startParam, user: language ? { language_code: language } : undefined },
        themeParams: { bg_color: '#17212b', text_color: '#ffffff', hint_color: '#aabbcc', secondary_bg_color: '#232e3c', button_color: '#2481cc', button_text_color: '#ffffff' },
        safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 },
        contentSafeAreaInset: { top: 20, right: 0, bottom: 0, left: 0 },
        ready() {}, expand() {}, isVersionAtLeast() { return true; },
        onEvent(name: string, callback: () => void) { events.set(name, callback); },
        offEvent(name: string) { events.delete(name); },
        switchInlineQuery(query: string, types: string[]) { Object.assign(window, { lastInline: { query, types } }); },
        openTelegramLink(url: string) { Object.assign(window, { lastTelegramLink: url }); },
        Serverless: { call() { throw new Error('WebAppServerlessInitDataUnavailable'); } },
      };
      Object.assign(window, { Telegram: { WebApp: app }, telegramTestEvents: events });
    }, { language: options.language, startParam: options.startParam });
  }
  await page.route(skinURL, (route) => route.fulfill({ body: png, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route(capeURL, (route) => route.fulfill({ body: cape, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  return png;
}

async function expectViewer(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Reset camera', exact: true })).toBeEnabled();
  await expect(page.locator('#status')).toBeHidden();
}

for (const [view, width, height] of [['head', 384, 384], ['front', 384, 640], ['back', 384, 640], ['three-view', 1152, 672], ['3d', 0, 0]] as const) {
  test(`bot URL starts the requested ${view} view`, async ({ page }) => {
    await installFixtures(page);
    await page.goto(`/?texture=c-${skinHash}&lang=en&view=${view}`);
    await expectViewer(page);
    const output = page.locator('#preview-output');
    if (view === '3d') {
      await expect(output).toBeHidden();
      await expect(page.getByRole('link', { name: 'Download preview' })).toBeHidden();
    } else {
      await expect(page.getByRole('combobox', { name: 'Flat previews' })).toHaveValue(view);
      await expect(output).toBeVisible();
      await expect.poll(() => output.evaluate((image) => [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight])).toEqual([width, height]);
      await expect(page.getByRole('link', { name: 'Download preview' })).toHaveAttribute('download', `skin-${view}.png`);
    }
  });
}

test('invalid or ambiguous view parameters fall back to a usable 3D viewer', async ({ page }) => {
  await installFixtures(page);
  for (const search of ['view=../../head', 'view=head&view=back']) {
    await page.goto(`/?texture=c-${skinHash}&lang=en&${search}`);
    await expectViewer(page);
    await expect(page.getByRole('combobox', { name: 'Flat previews' })).toHaveValue('three-view');
    await expect(page.locator('#preview-output')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
  }
});

test('official Telegram initData with a numeric language still opens the viewer', async ({ page }) => {
  test.skip(process.env.VIEWER_TEST_OFFICIAL_TELEGRAM !== '1', 'Run with VIEWER_TEST_OFFICIAL_TELEGRAM=1 for the official script network check.');
  await installFixtures(page);
  await page.route('https://telegram.org/js/telegram-web-app.js', async (route) => {
    const response = await route.fetch({ timeout: 15_000 });
    if (!response.ok()) throw new Error(`Official Telegram script HTTP ${response.status()}`);
    await route.fulfill({ response });
  });
  const wire = new URLSearchParams({ user: JSON.stringify({ id: 1, first_name: 'Fixture', language_code: 123 }) });
  const fragment = new URLSearchParams({ tgWebAppData: wire.toString(), tgWebAppVersion: '10.3', tgWebAppPlatform: 'android' });
  for (const language of ['&lang=zh-Hans', '']) {
    await page.goto(`/?texture=c-${skinHash}${language}#${fragment}`);
    await expect(page.getByRole('button', { name: language ? '重置视角' : 'Reset camera', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code)).toBe(123);
    await expect(page.locator('#status')).toBeHidden();
  }
});

for (const [model, legacy] of [['c', false], ['s', false], ['s', true]] as const) {
  test(`direct browser renders ${model} ${legacy ? 'legacy' : 'modern'} texture and supports controls`, async ({ page }) => {
    await installFixtures(page, { legacy });
    await page.goto(`/?texture=${model}-${skinHash}`);
    await expectViewer(page);
    await expect(page.getByRole('heading', { name: 'Shared skin' })).toBeVisible();
    const canvas = page.locator('#viewer');
    const front = await canvas.screenshot();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    expect(await canvas.screenshot()).not.toEqual(front);
    await page.getByRole('button', { name: 'Walk', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Walk', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Outer', { exact: true }).uncheck();
    await page.getByLabel('Inner', { exact: true }).uncheck();
    await expect(page.getByLabel('Outer', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('link', { name: 'Open official skin PNG' })).toHaveAttribute('href', skinURL);
  });
}

test('Telegram URL and bridge start parameters work with empty initData, language and model overrides', async ({ page }) => {
  await installFixtures(page, { telegram: true, startParam: `t-u-${skinHash}`, language: 'zh-CN' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '预览模型' })).toBeVisible();
  await page.getByRole('combobox', { name: '预览模型' }).selectOption('slim');
  await page.getByRole('button', { name: '分享查看器' }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`view texture:u-${skinHash}`);
  await expect(page.locator('#share-status')).toHaveText('选择聊天，再选择内联结果。');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--safe-top'))).toBe('44px');
  await page.goto(`/?tgWebAppStartParam=t-s-${skinHash}`);
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await expect(page.locator('#details')).toHaveText('模型: 纤细');
  await expect(page.getByRole('combobox', { name: '预览模型' })).toBeHidden();
});

test('Inline launch with no user or initData and a URL language keeps the static viewer usable', async ({ page }) => {
  await installFixtures(page, { telegram: true });
  await page.goto(`/?texture=c-${skinHash}&lang=zh-Hans`);
  await expect(page.getByRole('button', { name: '重置视角' })).toBeEnabled();
  await page.getByRole('button', { name: '分享皮肤', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { lastInline: { query: string } }).lastInline.query)).toBe(`skin texture:c-${skinHash}`);
});

test('empty and malformed links give guidance without requesting an untrusted texture', async ({ page }) => {
  await installFixtures(page);
  const textureRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('textures.minecraft.net')) textureRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Open a skin from Telegram.');
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
  await page.goto('/?texture=https://attacker.example/skin.png');
  await expect(page.locator('#status')).toHaveText('Open a valid skin link from the bot.');
  await expect(page.locator('#sharing')).toBeDisabled();
  await page.goto('/?tgWebAppStartParam=invalid&lang=zh-Hans');
  await expect(page.locator('#status')).toHaveText('从机器人打开有效的皮肤链接。');
  expect(textureRequests).toEqual([]);
});

test('temporary texture failure can retry while sharing remains available', async ({ page }) => {
  const png = await installFixtures(page);
  await page.route(skinURL, (route) => route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto(`/?texture=c-${skinHash}`);
  await expect(page.locator('#status')).toHaveText('Skin unavailable. Check your connection and retry.');
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
  await expect(page.locator('#sharing')).toBeEnabled();
  await page.unroute(skinURL);
  await page.route(skinURL, (route) => route.fulfill({ body: png, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expectViewer(page);
});

test('invalid PNG dimensions are rejected and a cape failure does not disable the skin', async ({ page }) => {
  const png = await installFixtures(page);
  const invalid = Buffer.from(png);
  invalid.writeUInt32BE(2048, 16);
  await page.route(skinURL, (route) => route.fulfill({ body: invalid, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto(`/?texture=c-${skinHash}`);
  await expect(page.locator('#status')).toHaveText('The official texture is not a supported Minecraft PNG.');
  await page.unroute(skinURL);
  await page.route(skinURL, (route) => route.fulfill({ body: png, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto(`/?texture=c-${skinHash}-${capeHash}`);
  await expectViewer(page);
  await expect(page.locator('#viewer-notice')).toBeHidden();
  await page.route(capeURL, (route) => route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.reload();
  await expectViewer(page);
  await expect(page.locator('#viewer-notice')).toHaveText('Cape unavailable. You can still view and share the skin.');
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
});

test('lost WebGL context restores controls and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installFixtures(page);
  await page.goto(`/?texture=c-${skinHash}`);
  await expectViewer(page);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const canvas = document.getElementById('viewer') as HTMLCanvasElement;
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension unavailable');
    Object.assign(window, { restoreViewerContext: () => extension.restoreContext() });
    extension.loseContext();
  });
  await expect(page.locator('#status')).toHaveText('Restoring the 3D viewer…');
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { restoreViewerContext(): void }).restoreViewerContext());
  await expectViewer(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('plain browser shares a copyable Telegram query even when clipboard fails', async ({ page }) => {
  await installFixtures(page);
  await page.goto(`/?texture=s-${skinHash}-${capeHash}`);
  await expectViewer(page);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return Promise.reject(new Error('Permission denied')); } } }));
  await page.getByRole('button', { name: 'Share Viewer', exact: true }).click();
  await expect(page.getByLabel('Inline query', { exact: true })).toHaveValue(`@${botUsername} view texture:s-${skinHash}-${capeHash}`);
  await expect(page.getByRole('link', { name: 'Open Telegram' })).toHaveAttribute('href', `https://t.me/${botUsername}`);
  await page.getByRole('button', { name: 'Copy text' }).click();
  const input = page.getByLabel('Inline query', { exact: true });
  expect(await input.evaluate((input) => (input as HTMLTextAreaElement).selectionEnd)).toBe(`@${botUsername} view texture:s-${skinHash}-${capeHash}`.length);
});

test('flat previews and original download remain usable without WebGL and reuse one skin fetch', async ({ page }) => {
  const original = await installFixtures(page);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...options: unknown[]) {
      if (type.includes('webgl')) return null;
      return getContext.call(this, type as '2d', ...options);
    } as typeof getContext;
  });
  let skinRequests = 0;
  page.on('request', (request) => { if (request.url() === skinURL) skinRequests += 1; });
  await page.goto(`/?texture=c-${skinHash}`);
  await expect(page.locator('#status')).toHaveText('The 3D viewer is unavailable. Try again.');
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
  const output = page.locator('#preview-output');
  for (const [kind, width, height] of [['head', 384, 384], ['front', 384, 640], ['back', 384, 640], ['three-view', 1152, 672]] as const) {
    await page.getByRole('combobox', { name: 'Flat previews' }).selectOption(kind);
    await page.getByRole('button', { name: 'Generate preview' }).click();
    await expect(output).toBeVisible();
    await expect.poll(() => output.evaluate((image) => [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight])).toEqual([width, height]);
    const colors = await output.evaluate((image) => {
      const bitmap = image as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.naturalWidth;
      canvas.height = bitmap.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 4) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`);
      return colors.size;
    });
    expect(colors).toBeGreaterThan(2);
    await expect(page.getByRole('link', { name: 'Download preview' })).toHaveAttribute('download', `skin-${kind}.png`);
  }
  const previewDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download preview' }).click();
  const previewDownload = await previewDownloadPromise;
  const preview = await readFile((await previewDownload.path())!);
  expect(preview.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([preview.readUInt32BE(16), preview.readUInt32BE(20)]).toEqual([1152, 672]);
  const originalDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download original skin' }).click();
  const originalDownload = await originalDownloadPromise;
  expect(await readFile((await originalDownload.path())!)).toEqual(original);
  expect(skinRequests).toBe(1);
});

test('an unconfigured viewer still renders and offers the original skin download', async ({ page }) => {
  test.skip(process.env.VIEWER_TEST_BOT_USERNAME !== '', 'Run with VIEWER_TEST_BOT_USERNAME="".');
  await installFixtures(page);
  await page.goto(`/?texture=c-${skinHash}`);
  await expectViewer(page);
  await expect(page.getByRole('link', { name: 'Download original skin' })).toBeVisible();
  await expect(page.locator('#share-skin')).toBeHidden();
});
