import { api } from 'sdk';
import { MinecraftError } from '../minecraft/errors.js';
import { expiredQuery, floodLimited, unchangedEdit, unavailableEdit } from './errors.js';
import { profileRichMessage, viewerConfigured } from './formatting.js';
import { localeFromUser, translate } from './i18n.js';
import { botIdentity } from './bot-identity.js';
import { cardForCallback } from './card-state.js';
import { MediaCacheBusy, withMedia } from './media-cache.js';
import { cacheConfigured, previewError, previewMedia } from './preview-media.js';

async function acknowledge(callback, text) {
  try {
    await api.answerCallbackQuery({
      callback_query_id: callback.id,
      ...(text ? { text, show_alert: true } : {}),
    });
    return true;
  } catch (error) {
    if (!floodLimited(error) && !expiredQuery(error)) throw error;
    return false;
  }
}

export default async function handleCallback(callback) {
  const locale = localeFromUser(callback.from);
  let action;
  try {
    action = await cardForCallback(callback);
  } catch (error) {
    await acknowledge(callback, translate(locale, 'busy'));
    throw error;
  }
  if (!action || !['front', 'back', 'head', 'three-view', 'skin'].includes(action.view)) {
    await acknowledge(callback, translate(locale, 'actionUnavailable'));
    return;
  }
  if (!viewerConfigured() || !cacheConfigured()) {
    await acknowledge(callback, translate(locale, !viewerConfigured() ? 'unconfigured' : 'cacheUnconfigured'));
    return;
  }
  if (!await acknowledge(callback)) return;
  try {
    const bot = await botIdentity();
    const prepared = await previewMedia(action.card.profile, bot.id).prepare(action.view);
    await withMedia(prepared.plan, prepared.options, (media) => api.editMessageText({
      ...action.target,
      rich_message: profileRichMessage(action.card, locale, media, action.view, {
        miniApp: callback.message?.chat?.type === 'private',
      }),
    }));
  } catch (error) {
    if (unchangedEdit(error) || floodLimited(error) || unavailableEdit(error)
      || error instanceof MediaCacheBusy || error instanceof MinecraftError || previewError(error)) return;
    throw error;
  }
}
