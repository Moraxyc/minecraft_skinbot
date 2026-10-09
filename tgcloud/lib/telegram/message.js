import { api } from 'sdk';
import { resolveProfile } from '../minecraft/client.js';
import { MinecraftError } from '../minecraft/errors.js';
import { parseQuery as parseReference } from '../minecraft/reference.js';
import { floodLimited, lookupErrorText } from './errors.js';
import { helpText, profileRichMessage, viewerConfigured } from './formatting.js';
import { localeFromUser, translate } from './i18n.js';
import { addressedQuery, parseCommand, parseQuery } from './input.js';
import { botIdentity } from './bot-identity.js';
import { createCard } from './card-state.js';
import { MediaCacheBusy, withMedia } from './media-cache.js';
import { cacheConfigured, previewError, previewMedia } from './preview-media.js';

export default async function handleMessage(message) {
  if (typeof message.text !== 'string') return;
  const locale = localeFromUser(message.from);
  const target = { chat_id: message.chat.id };
  if (message.message_thread_id != null) target.message_thread_id = message.message_thread_id;
  const send = (content) => api.sendMessage({ ...target, link_preview_options: { is_disabled: true }, ...content });
  let bot;
  try {
    bot = await botIdentity();
  } catch (error) {
    if (!floodLimited(error)) throw error;
    return;
  }
  const text = addressedQuery(message, bot.username);
  if (text === null) return;
  const command = parseCommand(text);
  if (command?.name === 'help' || (command?.name === 'start' && !command.argument)) {
    await send({ text: helpText(locale, bot.username), parse_mode: 'HTML' });
    return;
  }
  if (text.startsWith('/') && !command) return;
  const query = parseQuery(command
    ? `${command.name === 'start' ? 'skin' : command.name} ${command.argument}` : text);
  if (!query) {
    await send({ text: translate(locale, 'invalidReference') });
    return;
  }
  if (!viewerConfigured()) {
    await send({ text: translate(locale, 'unconfigured') });
    return;
  }
  if (!cacheConfigured()) {
    await send({ text: translate(locale, 'cacheUnconfigured') });
    return;
  }
  let profile;
  try {
    parseReference(query.reference);
    profile = await resolveProfile(query.reference);
  } catch (error) {
    if (!(error instanceof MinecraftError)) throw error;
    await send({ text: lookupErrorText(error, locale) });
    return;
  }
  if (!profile.snapshot) {
    await send({ text: translate(locale, 'skinUnavailable') });
    return;
  }
  const card = await createCard(profile);
  const view = query.view === '3d' ? 'three-view' : query.view;
  let prepared;
  try {
    prepared = await previewMedia(card.profile, bot.id).prepare(view);
  } catch (error) {
    const key = previewError(error);
    if (!key && !(error instanceof MediaCacheBusy) && !(error instanceof MinecraftError) && !floodLimited(error)) throw error;
    await send({ text: key ? translate(locale, key) : translate(locale, 'busy') });
    return;
  }
  await withMedia(prepared.plan, prepared.options, (media) => api.sendRichMessage({
    ...target,
    rich_message: profileRichMessage(card, locale, media, view, { miniApp: message.chat.type === 'private' }),
  }));
}
