import type { TelegramWebApp } from './telegram';

export type Locale = 'en' | 'zh-Hans';

const en = {
  title: 'Minecraft Skin Viewer',
  heading: '3D skin viewer',
  openTelegramSkin: 'Open a skin from Telegram.',
  stage: 'Interactive 3D skin',
  canvas: 'Drag to rotate. Pinch or scroll to zoom.',
  openBotSkin: 'Open a skin from the bot.',
  gestures: 'Drag to rotate · Pinch to zoom',
  reset: 'Reset camera',
  cameraView: 'View',
  front: 'Front',
  side: 'Side',
  back: 'Back',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  layers: 'Skin layers',
  inner: 'Inner',
  outer: 'Outer',
  animation: 'Animation',
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  pause: 'Pause',
  resume: 'Resume',
  previewModel: 'Preview model',
  automatic: 'Automatic',
  previewModelOnly: 'Changes the 3D preview only.',
  share: 'Share',
  inlineQuery: 'Inline query',
  copyQuery: 'Copy text',
  openTelegram: 'Open Telegram',
  manualShare: 'Copy this query and paste it into your target Telegram chat.',
  chooseChat: 'Choose a chat, then select the inline result.',
  invalidLink: 'Open a valid skin link from the bot.',
  loading: 'Loading skin…',
  retry: 'Retry',
  model: 'Model',
  classic: 'Classic',
  slim: 'Slim',
  unknown: 'Unknown',
  cape: 'Cape',
  sharedSkin: 'Shared skin',
  capeUnavailable: 'Cape unavailable. You can still view and share the skin.',
  restoring: 'Restoring the 3D viewer…',
  viewerUnavailable: 'The 3D viewer is unavailable. Try again.',
  copied: 'Copied. Paste into your target Telegram chat.',
  selectQuery: 'Select and copy the query, then paste it into your target Telegram chat.',
  skinUnavailable: 'Skin unavailable. Check your connection and retry.',
  invalidSkin: 'The official texture is not a supported Minecraft PNG.',
  lookupLabel: 'Minecraft username or UUID',
  editName: 'Change player',
  lookupButton: 'Look up',
  cancel: 'Cancel',
  lookingUp: 'Looking up skin…',
  preparingShare: 'Preparing your message…',
  choosePreparedChat: 'Choose a chat to share this skin.',
  shared: 'Skin shared.',
  shareCancelled: 'Sharing cancelled.',
  telegramRequired: 'Open this Mini App in Telegram to look up and share skins.',
  serviceUnavailable: 'The skin service is unavailable. Try again.',
};

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  title: 'Minecraft 皮肤查看器',
  heading: '3D 皮肤查看器',
  openTelegramSkin: '从 Telegram 打开皮肤。',
  stage: '交互式 3D 皮肤',
  canvas: '拖动旋转，双指或滚动缩放。',
  openBotSkin: '从机器人打开皮肤。',
  gestures: '拖动旋转 · 双指缩放',
  reset: '重置视角',
  cameraView: '视角',
  front: '正面',
  side: '侧面',
  back: '背面',
  zoomIn: '放大',
  zoomOut: '缩小',
  layers: '皮肤图层',
  inner: '内层',
  outer: '外层',
  animation: '动画',
  idle: '待机',
  walk: '行走',
  run: '跑步',
  pause: '暂停',
  resume: '继续',
  previewModel: '预览模型',
  automatic: '自动识别',
  previewModelOnly: '仅改变本页 3D 预览。',
  share: '分享',
  inlineQuery: '内联查询',
  copyQuery: '复制文本',
  openTelegram: '打开 Telegram',
  manualShare: '复制查询并粘贴到目标 Telegram 聊天。',
  chooseChat: '选择聊天，再选择内联结果。',
  invalidLink: '从机器人打开有效的皮肤链接。',
  loading: '正在加载皮肤…',
  retry: '重试',
  model: '模型',
  classic: '经典',
  slim: '纤细',
  unknown: '未知',
  cape: '披风',
  sharedSkin: '分享的皮肤',
  capeUnavailable: '披风暂不可用，仍可查看和分享皮肤。',
  restoring: '正在恢复 3D 查看器…',
  viewerUnavailable: '3D 查看器暂时无法使用，请重试。',
  copied: '已复制，请粘贴到目标 Telegram 聊天。',
  selectQuery: '选中并复制查询，再粘贴到目标 Telegram 聊天。',
  skinUnavailable: '皮肤暂不可用，请检查网络连接后重试。',
  invalidSkin: '官方纹理不是支持的 Minecraft PNG。',
  lookupLabel: 'Minecraft 用户名或 UUID',
  editName: '更换玩家',
  lookupButton: '查询',
  cancel: '取消',
  lookingUp: '正在查询皮肤…',
  preparingShare: '正在准备分享消息…',
  choosePreparedChat: '选择聊天以分享皮肤。',
  shared: '已分享皮肤。',
  shareCancelled: '已取消分享。',
  telegramRequired: '请在 Telegram 中打开 Mini App，以查询和分享皮肤。',
  serviceUnavailable: '皮肤服务暂不可用，请重试。',
};

function supportedLocale(language: unknown): Locale | undefined {
  if (typeof language !== 'string') return undefined;
  const tag = language.replaceAll('_', '-').toLowerCase();
  const parts = tag.split('-');
  if (parts[0] === 'zh' && !parts.includes('hant')
    && (parts.includes('hans') || tag === 'zh' || (parts.length === 2 && ['cn', 'sg'].includes(parts[1])))) return 'zh-Hans';
  return parts[0] === 'en' ? 'en' : undefined;
}

export function viewerLocale(
  app: Pick<TelegramWebApp, 'initDataUnsafe'> | undefined,
  languages: readonly string[],
  requested?: string | null,
): Locale {
  // Inline launches can omit the user language; the bot supplies it in the URL.
  const signals = app
    ? [app.initDataUnsafe?.user?.language_code ?? '', requested ?? '']
    : [requested ?? '', ...languages];
  for (const signal of signals) {
    const locale = supportedLocale(signal);
    if (locale) return locale;
  }
  return 'en';
}

export function translator(locale: Locale): (key: MessageKey) => string {
  const messages = locale === 'zh-Hans' ? zh : en;
  return (key) => messages[key];
}

export function localizeDocument(locale: Locale): void {
  const t = translator(locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n as MessageKey);
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAria as MessageKey));
  }
}
