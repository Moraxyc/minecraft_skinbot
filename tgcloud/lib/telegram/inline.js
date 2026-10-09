import { api } from 'sdk';
import { resolveProfile } from '../minecraft/client.js';
import { MinecraftError } from '../minecraft/errors.js';
import { parseQuery as parseReference } from '../minecraft/reference.js';
import { expiredQuery, floodLimited, lookupErrorText } from './errors.js';
import { profileRichMessage, viewerConfigured } from './formatting.js';
import { localeFromUser, translate } from './i18n.js';
import { parseQuery } from './input.js';
import { botIdentity } from './bot-identity.js';
import { cardAction, createCard } from './card-state.js';
import { MediaCacheBusy, withMedia } from './media-cache.js';
import { cacheConfigured, previewError, previewMedia } from './preview-media.js';

async function answer(query, results) {
  try {
    await api.answerInlineQuery({ inline_query_id: query.id, results, cache_time: 0, is_personal: true });
    return true;
  } catch (error) {
    if (!floodLimited(error) && !expiredQuery(error)) throw error;
    return false;
  }
}

function failure(locale, text) {
  return [{
    type: 'article', id: 'lookup-error', title: translate(locale, 'errorTitle'), description: text,
    input_message_content: {
      rich_message: { blocks: [{ type: 'paragraph', text }], skip_entity_detection: true },
    },
  }];
}

export default async function handleInlineQuery(query) {
  const locale = localeFromUser(query.from);
  const parsed = parseQuery(query.query);
  if (!parsed || query.offset) {
    await answer(query, []);
    return;
  }
  try {
    parseReference(parsed.reference);
  } catch (error) {
    if (!(error instanceof MinecraftError)) throw error;
    await answer(query, []);
    return;
  }
  if (!viewerConfigured() || !cacheConfigured()) {
    await answer(query, failure(locale, translate(locale, !viewerConfigured() ? 'unconfigured' : 'cacheUnconfigured')));
    return;
  }
  let profile;
  let bot;
  try {
    bot = await botIdentity();
    profile = await resolveProfile(parsed.reference);
  } catch (error) {
    if (!(error instanceof MinecraftError) && !floodLimited(error)) throw error;
    await answer(query, failure(locale, floodLimited(error) ? translate(locale, 'busy') : lookupErrorText(error, locale)));
    return;
  }
  if (!profile.snapshot) {
    await answer(query, failure(locale, translate(locale, 'skinUnavailable')));
    return;
  }
  const media = previewMedia(profile, bot.id);
  const views = ['front', 'three-view', 'head', 'skin'];
  const preferred = parsed.view === '3d' ? 'three-view' : parsed.view;
  if (views.includes(preferred)) views.sort((first, second) => (second === preferred) - (first === preferred));
  const available = [];
  const missing = [];
  for (const view of views) {
    const ref = await media.read(view);
    if (ref) available.push({ view, ref });
    else missing.push(view);
  }
  let card;
  if (available.length) card = await createCard(profile, { inlineUserId: query.from.id });
  const result = ({ view, ref }) => ({
    type: ref.type,
    id: cardAction(card.id, view),
    [ref.type === 'photo' ? 'photo_file_id' : 'document_file_id']: ref.fileId,
    title: translate(locale, view),
    description: profile.name ?? translate(locale, 'sharedSkin'),
    input_message_content: {
      rich_message: profileRichMessage(card, locale, ref, view),
    },
  });
  let answered;
  if (available.length === 1) {
    const prepared = await media.prepare(available[0].view);
    answered = await withMedia(prepared.plan, prepared.options, (ref) => answer(query, [result({ view: available[0].view, ref })]));
  } else {
    answered = await answer(query, available.length ? available.map(result) : failure(locale, translate(locale, 'preparing')));
  }
  if (!answered) return;
  for (const view of missing) {
    try {
      await media.prepare(view);
    } catch (error) {
      if (error instanceof MediaCacheBusy || error instanceof MinecraftError || previewError(error) || floodLimited(error)) return;
      throw error;
    }
  }
}
