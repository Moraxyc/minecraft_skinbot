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
  shareSkin: 'Share Skin',
  shareView: 'Share Three-view',
  inlineQuery: 'Inline query',
  copyQuery: 'Copy inline query',
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
  uploadedSkin: 'Uploaded skin',
  uploadAvailableUntil: 'Available until',
  renewUpload: 'Send the same PNG again to renew its links.',
  capeUnavailable: 'Cape unavailable. You can still view and share the skin.',
  restoring: 'Restoring the 3D viewer…',
  viewerUnavailable: 'The 3D viewer is unavailable. Try again.',
  copied: 'Copied. Paste into your target Telegram chat.',
  selectQuery: 'Select and copy the query, then paste it into your target Telegram chat.',
  serviceBusy: 'Skin service is busy. Try again.',
  uploadExpired: 'This upload has expired. Send the PNG to the bot again.',
  playerNotFound: 'Player not found. Check the UUID.',
  invalidData: 'Reopen the skin to load its data.',
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
  shareSkin: '分享皮肤',
  shareView: '分享三视图',
  inlineQuery: '内联查询',
  copyQuery: '复制内联查询',
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
  uploadedSkin: '上传的皮肤',
  uploadAvailableUntil: '有效期至',
  renewUpload: '重新发送相同 PNG 可续期。',
  capeUnavailable: '披风暂不可用，仍可查看和分享皮肤。',
  restoring: '正在恢复 3D 查看器…',
  viewerUnavailable: '3D 查看器暂时无法使用，请重试。',
  copied: '已复制，请粘贴到目标 Telegram 聊天。',
  selectQuery: '选中并复制查询，再粘贴到目标 Telegram 聊天。',
  serviceBusy: '皮肤服务繁忙，请重试。',
  uploadExpired: '上传已过期，请重新向机器人发送 PNG。',
  playerNotFound: '找不到玩家，请检查 UUID。',
  invalidData: '请重新打开皮肤以加载数据。',
};

function supportedLocale(language: string): Locale | undefined {
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
  // Inline-mode buttons launch the Web App with empty or user-less initData, so the bot also
  // passes the sender's language in the URL. Telegram's own language still wins whenever the
  // client reports it, and a Web App launched inside Telegram never falls back to the browser.
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
