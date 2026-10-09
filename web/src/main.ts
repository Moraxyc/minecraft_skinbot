import { configuredBotUsername, parseCardReference, parseLinkReference, parseSnapshot, parseSnapshotToken } from './snapshot';
import { loadTexture, TextureError } from './textures';
import { localizeDocument, translator, viewerLocale } from './i18n';
import { callEndpoint, copyInlineQuery, endpointsAvailable, getTelegram, initializeTelegram, shareInline, type EndpointCallError } from './telegram';
import { Viewer, type AnimationName, type CameraView, type PreviewModel } from './viewer';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

const app = getTelegram();
const launchParams = new URLSearchParams(window.location.search);
const locale = viewerLocale(
  app,
  navigator.languages.length ? navigator.languages : [navigator.language],
  launchParams.get('lang'),
);
const t = translator(locale);
localizeDocument(locale);
const cleanupTelegram = initializeTelegram(app);
let snapshot = parseSnapshot(window.location.search, app?.initDataUnsafe?.start_param);
let cardId = parseCardReference(window.location.search, app?.initDataUnsafe?.start_param);
const linkReference = parseLinkReference(window.location.search);
let botUsername = configuredBotUsername(import.meta.env.VITE_BOT_USERNAME);
let playerName: string | null = null;
let playerUUID: string | null = null;
const lookupForm = element<HTMLFormElement>('lookup');
const lookupInput = element<HTMLInputElement>('lookup-reference');
const lookupButton = element<HTMLButtonElement>('lookup-button');
const lookupStatus = element('lookup-status');
const nameHeading = element('name-heading');
const editName = element<HTMLButtonElement>('edit-name');
const cancelLookup = element<HTMLButtonElement>('cancel-lookup');
if (!snapshot) element('details').textContent = t('openTelegramSkin');
const status = element('status');
const controls = element<HTMLFieldSetElement>('controls');
const sharing = element<HTMLFieldSetElement>('sharing');
const retry = element<HTMLButtonElement>('retry');
const notice = element('viewer-notice');
const modelControls = element('model-controls');
const previewModel = element<HTMLSelectElement>('preview-model');
const pause = element<HTMLButtonElement>('pause');
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let animationPaused = motionPreference.matches;
let canvas = element<HTMLCanvasElement>('viewer');
let viewer: Viewer | undefined;
let viewerReady = false;
let contextLost = false;
let loading = false;
let closed = false;
let request: AbortController | undefined;
let preparingShare = false;

interface ViewerState {
  botUsername: string;
  card: { id: number; token: string; name: string | null; uuid: string | null } | null;
}

function updateSharing(): void {
  const available = Boolean(botUsername || endpointsAvailable(app) && app.shareMessage && app.isVersionAtLeast?.('8.0'));
  element('share-view').hidden = !available;
}

function updateLookupControls(): void {
  const disabled = !endpointsAvailable(app) || loading;
  editName.disabled = disabled;
  lookupInput.disabled = disabled;
  lookupButton.disabled = disabled;
  cancelLookup.disabled = disabled;
}

function closeLookup(): void {
  lookupForm.hidden = true;
  nameHeading.hidden = false;
  lookupStatus.textContent = '';
  editName.focus();
}

function applyViewerState(state: ViewerState): void {
  botUsername = configuredBotUsername(state.botUsername);
  if (state.card) {
    const resolved = parseSnapshotToken(state.card.token);
    if (!resolved) throw new Error('Invalid skin snapshot.');
    snapshot = resolved;
    cardId = state.card.id;
    playerName = state.card.name;
    playerUUID = state.card.uuid;
  }
  updateSharing();
}

function endpointErrorText(error: unknown): string {
  const failure = error as EndpointCallError | undefined;
  if (failure?.type === 'ENDPOINT_ERROR') return failure.message;
  return t(failure?.type === 'UNAUTHORIZED' ? 'telegramRequired' : 'serviceUnavailable');
}

function updatePause(): void {
  viewer?.setPaused(animationPaused);
  pause.textContent = t(animationPaused ? 'resume' : 'pause');
  pause.setAttribute('aria-pressed', String(animationPaused));
}

function updateMotionPreference(): void {
  animationPaused = motionPreference.matches;
  updatePause();
}

motionPreference.addEventListener('change', updateMotionPreference);
updatePause();

function shareFallback(): void {
  if (!snapshot || !botUsername) return;
  const query = `view texture:${snapshot.token}`;
  const outcome = shareInline(app, query);
  const fallback = element<HTMLAnchorElement>('share-fallback');
  fallback.hidden = outcome !== 'manual';
  fallback.href = `https://t.me/${botUsername}`;
  const input = element<HTMLTextAreaElement>('inline-query');
  input.value = `@${botUsername} ${query}`;
  input.setAttribute('aria-label', t('inlineQuery'));
  input.hidden = outcome !== 'manual';
  element('copy-query').hidden = outcome !== 'manual';
  element('share-status').textContent = outcome === 'manual'
    ? t('manualShare')
    : t('chooseChat');
}

async function share(): Promise<void> {
  if (!snapshot || preparingShare || closed) return;
  if (!endpointsAvailable(app) || !app.shareMessage || !app.isVersionAtLeast?.('8.0')) {
    shareFallback();
    return;
  }
  preparingShare = true;
  sharing.disabled = true;
  element('share-status').textContent = t('preparingShare');
  try {
    const prepared = await callEndpoint<{ id: string }>(app, 'prepareShare', {
      ...(cardId ? { cardId } : { token: snapshot.token }),
      view: 'three-view',
    });
    if (closed) return;
    element('share-status').textContent = t('choosePreparedChat');
    app.shareMessage(prepared.id, (sent) => {
      if (!closed) element('share-status').textContent = t(sent ? 'shared' : 'shareCancelled');
    });
  } catch (error) {
    if (!closed) element('share-status').textContent = endpointErrorText(error);
  } finally {
    preparingShare = false;
    sharing.disabled = !snapshot;
  }
}

async function start(): Promise<void> {
  if (loading || closed) return;
  if (!snapshot) {
    const hasLaunchReference = [...launchParams.keys()].some((key) => key !== 'lang')
      || Boolean(app?.initDataUnsafe?.start_param);
    status.textContent = t(hasLaunchReference ? 'invalidLink' : 'openTelegramSkin');
    if (botUsername) {
      const fallback = element<HTMLAnchorElement>('share-fallback');
      fallback.href = `https://t.me/${botUsername}`;
      fallback.hidden = false;
    }
    return;
  }
  loading = true;
  updateLookupControls();
  request = new AbortController();
  viewer?.dispose();
  viewer = undefined;
  viewerReady = false;
  contextLost = false;
  controls.disabled = true;
  sharing.disabled = preparingShare;
  retry.hidden = true;
  retry.disabled = true;
  notice.hidden = true;
  modelControls.hidden = true;
  status.hidden = false;
  status.textContent = t('loading');
  try {
    element('name').textContent = playerName ?? t('sharedSkin');
    element('details').textContent = `${t('model')}: ${t(snapshot.model)}${snapshot.capeURL ? ` · ${t('cape')}` : ''}${playerUUID ? ` · UUID: ${playerUUID}` : ''}`;
    const { image } = await loadTexture(snapshot.skinURL, 'skin', request.signal);
    try {
      if (closed) return;
      // skinview3d leaves anonymous mouse and touch listeners on disposed canvases.
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
      const result = await viewer.load(snapshot, image, request.signal);
      if (closed) return;
      viewerReady = true;
      updatePause();
      viewer.skin.renderPaused = document.hidden;
      for (const layer of ['inner', 'outer']) element<HTMLInputElement>(layer).checked = true;
      for (const button of animationButtons) button.setAttribute('aria-pressed', String(button.dataset.animation === 'idle'));
      previewModel.value = 'auto';
      modelControls.hidden = !result.canOverrideModel;
      if (result.capeUnavailable) {
        notice.textContent = t('capeUnavailable');
        notice.hidden = false;
      }
      status.hidden = !contextLost;
      controls.disabled = contextLost;
      retry.hidden = !contextLost;
    } finally { image.close(); }
  } catch (error) {
    if (closed) return;
    viewer?.dispose();
    viewer = undefined;
    status.textContent = t(error instanceof TextureError ? error.code : 'viewerUnavailable');
    retry.hidden = false;
  } finally {
    loading = false;
    request = undefined;
    retry.disabled = false;
    updateLookupControls();
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
element('zoom-in').addEventListener('click', () => viewer?.zoom('in'));
element('zoom-out').addEventListener('click', () => viewer?.zoom('out'));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera-view]')) {
  button.addEventListener('click', () => viewer?.setView(button.dataset.cameraView as CameraView));
}
pause.addEventListener('click', () => {
  animationPaused = !animationPaused;
  updatePause();
});
previewModel.addEventListener('change', () => viewer?.setPreviewModel(previewModel.value as PreviewModel));
for (const layer of ['inner', 'outer'] as const) {
  const checkbox = element<HTMLInputElement>(layer);
  checkbox.addEventListener('change', () => viewer?.setLayer(layer, checkbox.checked));
}
const animationButtons = document.querySelectorAll<HTMLButtonElement>('[data-animation]');
for (const button of animationButtons) {
  button.addEventListener('click', () => {
    viewer?.setAnimation(button.dataset.animation as AnimationName);
    updatePause();
    for (const item of animationButtons) item.setAttribute('aria-pressed', String(item === button));
  });
}
element('share-view').addEventListener('click', () => { void share(); });
editName.addEventListener('click', () => {
  if (!endpointsAvailable(app) || loading || closed) return;
  lookupInput.value = playerName ?? playerUUID ?? '';
  lookupStatus.textContent = '';
  nameHeading.hidden = true;
  lookupForm.hidden = false;
  lookupInput.focus();
  lookupInput.select();
});
cancelLookup.addEventListener('click', closeLookup);
lookupForm.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || loading) return;
  event.preventDefault();
  closeLookup();
});
lookupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!endpointsAvailable(app) || loading || closed) return;
  const reference = lookupInput.value.trim();
  if (!reference) {
    lookupInput.value = '';
    lookupInput.reportValidity();
    return;
  }
  loading = true;
  updateLookupControls();
  retry.disabled = true;
  lookupStatus.textContent = t('lookingUp');
  void callEndpoint<ViewerState>(app, 'lookupSkin', { reference })
    .then(async (state) => {
      if (closed) return;
      applyViewerState(state);
      loading = false;
      updateLookupControls();
      closeLookup();
      await start();
    })
    .catch((error: unknown) => { if (!closed) lookupStatus.textContent = endpointErrorText(error); })
    .finally(() => {
      loading = false;
      updateLookupControls();
      retry.disabled = false;
      if (!closed && !lookupForm.hidden) lookupInput.focus();
    });
});
element('copy-query').addEventListener('click', () => {
  void copyInlineQuery(element<HTMLTextAreaElement>('inline-query')).then((copied) => {
    element('share-status').textContent = t(copied ? 'copied' : 'selectQuery');
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
  motionPreference.removeEventListener('change', updateMotionPreference);
}, { once: true });
async function bootstrap(): Promise<void> {
  loading = true;
  updateLookupControls();
  updateSharing();
  if (endpointsAvailable(app)) {
    try {
      const state = await callEndpoint<ViewerState>(app, 'getCard', linkReference);
      if (closed) return;
      applyViewerState(state);
    } catch (error) {
      if (closed) return;
      cardId = null;
      lookupStatus.textContent = endpointErrorText(error);
    }
  }
  loading = false;
  updateLookupControls();
  await start();
}

void bootstrap();
