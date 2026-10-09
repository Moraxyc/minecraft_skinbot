import { fetchTextureBytes } from '../minecraft/texture-bytes.js';
import { BotApiError } from 'sdk';
import { textureURL } from '../minecraft/reference.js';
import { MinecraftError } from '../minecraft/errors.js';
import { decodeSkin, encodePreview } from '../skin/png.js';
import { normalizeSkin, renderSkin } from '../skin/renderer.js';
import { rendererVersion } from '../skin/preview-png.js';
import { settings } from '../settings.js';
import { getMedia, readMedia } from './media-cache.js';
import { readTextureHeight, rememberTextureHeight } from './snapshots.js';

export class PreviewUnavailable extends Error {}

export function cacheConfigured() {
  return Number.isSafeInteger(settings.cacheChatId) && settings.cacheChatId !== 0
    && Math.abs(settings.cacheChatId) < 2 ** 52;
}

export function previewMedia(profile, botId) {
  const snapshot = profile.snapshot;
  const declaredModel = snapshot.model === 'slim' ? 'slim' : 'classic';
  const admissionUntil = Date.now() + 8000;
  let original;
  let image;
  let normalized;
  let height;

  async function pixels() {
    if (!normalized) {
      if (!original) original = await fetchTextureBytes(textureURL(snapshot.skinHash));
      let skin;
      try {
        image = decodeSkin(original);
        skin = normalizeSkin(image, declaredModel);
      } catch {
        throw new PreviewUnavailable('The texture is not a supported skin PNG.');
      }
      height = await rememberTextureHeight(snapshot.skinHash, image);
      normalized = skin;
    }
  }

  async function plan(view) {
    let renderModel = declaredModel;
    if (!['skin', 'head'].includes(view)) {
      if (height === undefined) height = await readTextureHeight(snapshot.skinHash);
      if (height === 32) renderModel = 'classic';
    }
    return { botId, skinHash: snapshot.skinHash, kind: view, renderModel, rendererVersion };
  }

  async function read(view) {
    return readMedia(await plan(view));
  }

  async function prepare(view) {
    let recipe = await plan(view);
    if (!await readMedia(recipe) && height === null && declaredModel === 'slim' && !['skin', 'head'].includes(view)) {
      await pixels();
      recipe = await plan(view);
    }
    const options = {
      cacheChatId: settings.cacheChatId,
      admissionUntil,
      async produce() {
        await pixels();
        if (view === 'skin') return original;
        try {
          return encodePreview(renderSkin(normalized, view));
        } catch {
          throw new PreviewUnavailable('The skin preview could not be rendered.');
        }
      },
    };
    const ref = await getMedia(recipe, options);
    return { plan: recipe, options, ref };
  }

  return { read, prepare };
}

export function previewError(error) {
  if (error instanceof BotApiError && error.code === 403) return 'cachePermission';
  if (error instanceof PreviewUnavailable) return 'unsupportedPreview';
  if (error instanceof MinecraftError && error.code === 'UNSUPPORTED_BYTE_TRANSPORT') return 'unsupportedBytes';
  return null;
}
