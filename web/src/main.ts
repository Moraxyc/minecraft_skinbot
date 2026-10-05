import { inlineReference, loadProfile, parseReference, ViewerError } from './api';
import { getTelegram, initializeTelegram, shareInline, telegramShareURL } from './telegram';
import { Viewer, type AnimationName } from './viewer';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

const app = getTelegram();
const cleanupTelegram = initializeTelegram(app);
const reference = parseReference(window.location.search, app?.initDataUnsafe?.start_param);
const status = element('status');
const controls = element<HTMLFieldSetElement>('controls');
const botUsername = import.meta.env.VITE_BOT_USERNAME || '';
let viewer: Viewer | undefined;

function share(kind: 'skin' | 'view'): void {
  if (!reference) return;
  const query = `${kind} ${inlineReference(reference)}`;
  const outcome = shareInline(app, query, botUsername);
  const fallback = element<HTMLAnchorElement>('share-fallback');
  const url = telegramShareURL(botUsername, query);
  if (url) {
    fallback.href = url;
    fallback.hidden = false;
  }
  element('share-status').textContent = outcome === 'manual'
    ? `Use this inline query in Telegram: ${query}`
    : 'Choose a chat, then select the inline result.';
}

async function start(): Promise<void> {
  if (!reference) {
    if (window.location.search) status.textContent = 'Open a valid skin link from the bot.';
    return;
  }
  status.textContent = 'Loading skin…';
  try {
    const profile = await loadProfile(reference, import.meta.env.VITE_API_BASE_URL || window.location.origin);
    element('name').textContent = profile.name;
    const model = profile.model.charAt(0).toUpperCase() + profile.model.slice(1);
    element('details').textContent = `Model: ${model}${profile.cape_url ? ' · Cape' : ''}`;
    viewer = new Viewer(element<HTMLCanvasElement>('viewer'), element('stage'), () => {
      status.hidden = false;
      status.textContent = 'Restoring the 3D viewer…';
    });
    element('viewer').addEventListener('webglcontextrestored', () => { status.hidden = true; });
    await viewer.load(profile);
    status.hidden = true;
    controls.disabled = false;
  } catch (error) {
    viewer?.dispose();
    viewer = undefined;
    status.textContent = error instanceof ViewerError ? error.message : 'The 3D viewer is unavailable. Try reopening the skin.';
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
document.addEventListener('visibilitychange', () => { if (viewer) viewer.skin.renderPaused = document.hidden; });
window.addEventListener('pagehide', () => { viewer?.dispose(); cleanupTelegram(); }, { once: true });
void start();
