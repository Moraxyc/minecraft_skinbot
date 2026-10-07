import { inlineReference, loadProfile, parseReference, ViewerError } from './api';
import { localizeDocument, translator, viewerLocale } from './i18n';
import { copyInlineQuery, getTelegram, initializeTelegram, shareInline } from './telegram';
import { Viewer, type AnimationName } from './viewer';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

const app = getTelegram();
const locale = viewerLocale(
  app,
  navigator.languages.length ? navigator.languages : [navigator.language],
  new URLSearchParams(window.location.search).get('lang'),
);
const t = translator(locale);
localizeDocument(locale);
const cleanupTelegram = initializeTelegram(app);
const reference = parseReference(window.location.search, app?.initDataUnsafe?.start_param);
const status = element('status');
const controls = element<HTMLFieldSetElement>('controls');
const sharing = element<HTMLFieldSetElement>('sharing');
const retry = element<HTMLButtonElement>('retry');
const notice = element('viewer-notice');
const expiry = element('upload-expiry');
let canvas = element<HTMLCanvasElement>('viewer');
let botUsername = '';
let viewer: Viewer | undefined;
let viewerReady = false;
let contextLost = false;
let loading = false;
let closed = false;
let request: AbortController | undefined;

function share(kind: 'skin' | 'view'): void {
  if (!reference || !botUsername) return;
  const query = `${kind} ${inlineReference(reference)}`;
  const outcome = shareInline(app, query);
  const fallback = element<HTMLAnchorElement>('share-fallback');
  fallback.hidden = outcome !== 'manual';
  fallback.href = `https://t.me/${botUsername}`;
  const input = element<HTMLTextAreaElement>('inline-query');
  input.value = `@${botUsername} ${query}`;
  input.hidden = outcome !== 'manual';
  element('copy-query').hidden = outcome !== 'manual';
  element('share-status').textContent = outcome === 'manual'
    ? t('manualShare')
    : t('chooseChat');
}

async function start(): Promise<void> {
  if (loading || closed) return;
  if (!reference) {
    if (window.location.search) status.textContent = t('invalidLink');
    return;
  }
  loading = true;
  request = new AbortController();
  viewer?.dispose();
  viewer = undefined;
  viewerReady = false;
  contextLost = false;
  controls.disabled = true;
  sharing.disabled = true;
  botUsername = '';
  retry.hidden = true;
  retry.disabled = true;
  notice.hidden = true;
  expiry.hidden = true;
  status.hidden = false;
  status.textContent = t('loading');
  try {
    const profile = await loadProfile(reference, import.meta.env.VITE_API_BASE_URL || window.location.origin, request.signal);
    if (closed) return;
    botUsername = profile.bot_username;
    sharing.disabled = false;
    element('name').textContent = reference.kind === 'upload' ? t('uploadedSkin') : profile.name;
    element('details').textContent = `${t('model')}: ${t(profile.model)}${profile.cape_url ? ` · ${t('cape')}` : ''}`;
    if (profile.upload_expires_at !== null) {
      const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' })
        .format(new Date(profile.upload_expires_at * 1000));
      expiry.textContent = `${t('uploadAvailableUntil')} ${date} · ${t('renewUpload')}`;
      expiry.hidden = false;
    }
    // skinview3d attaches anonymous canvas listeners that dispose does not remove.
    const nextCanvas = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(nextCanvas);
    canvas = nextCanvas;
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    viewer = new Viewer(canvas, element('stage'), () => {
      if (canvas !== nextCanvas) return;
      contextLost = true;
      controls.disabled = true;
      status.hidden = false;
      status.textContent = t('restoring');
      retry.hidden = false;
    });
    const result = await viewer.load(profile, request.signal);
    if (closed) return;
    viewerReady = true;
    viewer.skin.renderPaused = document.hidden;
    for (const layer of ['inner', 'outer']) element<HTMLInputElement>(layer).checked = true;
    for (const button of animationButtons) button.setAttribute('aria-pressed', String(button.dataset.animation === 'idle'));
    if (profile.cape_unavailable || result.capeUnavailable) {
      notice.textContent = t('capeUnavailable');
      notice.hidden = false;
    }
    status.hidden = !contextLost;
    controls.disabled = contextLost;
    retry.hidden = !contextLost;
  } catch (error) {
    if (closed) return;
    viewer?.dispose();
    viewer = undefined;
    status.textContent = t(error instanceof ViewerError ? error.code : 'viewerUnavailable');
    retry.hidden = error instanceof ViewerError && ['uploadExpired', 'playerNotFound'].includes(error.code);
  } finally {
    loading = false;
    request = undefined;
    retry.disabled = false;
  }
}

function onContextRestored(event: Event): void {
  if (event.target !== canvas) return;
  contextLost = false;
  if (viewer && viewerReady) {
    status.hidden = true;
    controls.disabled = false;
    retry.hidden = true;
  }
}

retry.addEventListener('click', () => { void start(); });
element('reset').addEventListener('click', () => viewer?.reset());
for (const layer of ['inner', 'outer'] as const) {
  const checkbox = element<HTMLInputElement>(layer);
  checkbox.addEventListener('change', () => viewer?.setLayer(layer, checkbox.checked));
}
const animationButtons = document.querySelectorAll<HTMLButtonElement>('[data-animation]');
for (const button of animationButtons) {
  button.addEventListener('click', () => {
    viewer?.setAnimation(button.dataset.animation as AnimationName);
    for (const item of animationButtons) item.setAttribute('aria-pressed', String(item === button));
  });
}
element('share-skin').addEventListener('click', () => share('skin'));
element('share-view').addEventListener('click', () => share('view'));
element('copy-query').addEventListener('click', () => {
  void copyInlineQuery(element<HTMLTextAreaElement>('inline-query')).then((copied) => {
    element('share-status').textContent = copied
      ? t('copied')
      : t('selectQuery');
  });
});
element<HTMLAnchorElement>('share-fallback').addEventListener('click', (event) => {
  if (app?.openTelegramLink) {
    try { app.openTelegramLink((event.currentTarget as HTMLAnchorElement).href); event.preventDefault(); }
    catch { /* The regular bot link also works as browser navigation. */ }
  }
});
document.addEventListener('visibilitychange', () => { if (viewer) viewer.skin.renderPaused = document.hidden; });
window.addEventListener('pagehide', () => {
  closed = true;
  request?.abort();
  viewer?.dispose();
  viewer = undefined;
  cleanupTelegram();
}, { once: true });
void start();
