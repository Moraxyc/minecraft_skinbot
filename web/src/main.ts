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
let botUsername = '';
let viewer: Viewer | undefined;

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
  if (!reference) {
    if (window.location.search) status.textContent = t('invalidLink');
    return;
  }
  status.textContent = t('loading');
  try {
    const profile = await loadProfile(reference, import.meta.env.VITE_API_BASE_URL || window.location.origin);
    botUsername = profile.bot_username;
    element('name').textContent = reference.kind === 'upload' ? t('uploadedSkin') : profile.name;
    element('details').textContent = `${t('model')}: ${t(profile.model)}${profile.cape_url ? ` · ${t('cape')}` : ''}`;
    viewer = new Viewer(element<HTMLCanvasElement>('viewer'), element('stage'), () => {
      status.hidden = false;
      status.textContent = t('restoring');
    });
    element('viewer').addEventListener('webglcontextrestored', () => { status.hidden = true; });
    await viewer.load(profile);
    status.hidden = true;
    controls.disabled = false;
  } catch (error) {
    viewer?.dispose();
    viewer = undefined;
    status.textContent = t(error instanceof ViewerError ? error.code : 'viewerUnavailable');
  }
}

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
window.addEventListener('pagehide', () => { viewer?.dispose(); cleanupTelegram(); }, { once: true });
void start();
