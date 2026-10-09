import { EndpointError } from 'sdk';
import { MinecraftError } from '../minecraft/errors.js';
import { decodeSnapshot } from '../minecraft/reference.js';
import { createCard, readCard, readCardByToken } from './card-state.js';
import { floodLimited, lookupErrorText } from './errors.js';
import { localeFromUser, translate } from './i18n.js';
import { MediaCacheBusy } from './media-cache.js';
import { previewError } from './preview-media.js';

export function invalidReference() {
  return new MinecraftError('INVALID_REFERENCE', 400, 'Invalid skin reference.');
}

// A launch carries its reference in the platform-verified initData.start_param, so an
// empty input resolves to the card or token this Mini App was opened with.
export function launchReference(ctx) {
  const start = ctx?.initData?.start_param;
  if (typeof start !== 'string') return null;
  const card = /^c-([1-9][0-9]{0,14})$/u.exec(start);
  if (card) return { cardId: Number(card[1]) };
  return start.startsWith('t-') ? { token: start.slice(2) } : null;
}

export async function loadEndpointCard(input, ctx) {
  const reference = input.cardId !== undefined || input.token !== undefined ? input : launchReference(ctx);
  if (reference === null) return null;
  if (reference.cardId !== undefined) {
    if (!Number.isSafeInteger(reference.cardId) || reference.cardId <= 0) throw invalidReference();
    const card = await readCard(reference.cardId);
    if (!card) throw new MinecraftError('NOT_FOUND', 404, 'Skin card not found.');
    if (reference.token !== undefined && reference.token !== card.token) throw invalidReference();
    return card;
  }
  if (typeof reference.token !== 'string') throw invalidReference();
  const snapshot = decodeSnapshot(reference.token);
  return await readCardByToken(reference.token) ?? createCard({ snapshot });
}

export function viewerState(card, bot) {
  return {
    botUsername: bot.username,
    card: card ? { id: card.id, token: card.token, name: card.profile.name, uuid: card.profile.uuid } : null,
  };
}

export async function endpointCall(ctx, operation) {
  const user = ctx?.initData?.user;
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) {
    throw new EndpointError('Open this Mini App in Telegram.', { code: 'UNAUTHORIZED' });
  }
  const locale = localeFromUser(user);
  try {
    return await operation(user, locale);
  } catch (error) {
    if (error instanceof MinecraftError) {
      throw new EndpointError(lookupErrorText(error, locale), { code: error.code });
    }
    const preview = previewError(error);
    if (preview) throw new EndpointError(translate(locale, preview), { code: preview });
    if (error instanceof MediaCacheBusy || floodLimited(error)) {
      throw new EndpointError(translate(locale, 'busy'), { code: 'BUSY' });
    }
    throw error;
  }
}
