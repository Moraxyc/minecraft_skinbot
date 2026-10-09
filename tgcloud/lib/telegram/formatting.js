import { decodeSnapshot } from '../minecraft/reference.js';
import { settings } from '../settings.js';
import { cardAction } from './card-state.js';
import { translate } from './i18n.js';

export function viewerConfigured() {
  return /^https:\/\/app[0-9]+\.tgcloud\.ai\/?$/.test(settings.viewerBaseUrl);
}

export function viewerURL(token, view, locale, cardId) {
  decodeSnapshot(token);
  if (!viewerConfigured()) throw new Error('Telegram-hosted viewer URL is not configured');
  const base = settings.viewerBaseUrl.replace(/\/$/, '');
  return `${base}/?texture=${encodeURIComponent(token)}&lang=${encodeURIComponent(locale)}&view=${view}${cardId ? `&card=${cardId}` : ''}`;
}

export function profileRichMessage(card, locale, media, view, { miniApp = false } = {}) {
  const { id, profile, token } = card;
  const snapshot = decodeSnapshot(token);
  const blocks = [
    { type: 'heading', text: profile.name ?? translate(locale, 'sharedSkin'), size: 2 },
    { type: 'paragraph', text: `${translate(locale, 'model')}: ${translate(locale, snapshot.model)}` },
  ];
  if (profile.uuid) {
    blocks.push({ type: 'paragraph', text: ['UUID: ', { type: 'code', text: profile.uuid }] });
  }
  if (media) {
    blocks.push({
      type: media.type,
      [media.type]: { type: media.type, media: media.fileId },
      caption: { text: translate(locale, view === 'skin' ? 'original' : view) },
    });
  }
  blocks.push(...[['front', 'back'], ['head', 'three-view', 'skin']].map((row) => ({
    type: 'buttons',
    buttons: row.map((kind) => ({
      text: `${kind === view ? '✓ ' : ''}${translate(locale, kind)}`,
      callback_data: cardAction(id, kind),
      ...(kind === view ? { style: 'primary' } : {}),
    })),
  })));
  const threeDButton = { text: translate(locale, '3d') };
  if (miniApp) threeDButton.web_app = { url: viewerURL(token, '3d', locale) };
  else threeDButton.url = viewerURL(token, '3d', locale);
  blocks.push({ type: 'buttons', buttons: [threeDButton] });
  const actions = [{ text: translate(locale, 'share'), switch_inline_query: `texture:${token}` }];
  blocks.push({ type: 'buttons', buttons: actions });
  return { blocks, skip_entity_detection: true };
}

export function helpText(locale, botUsername) {
  const text = translate(locale, 'help');
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(botUsername)) return text;
  return `${text}\n${translate(locale, 'inlineHelp').replace('{botUsername}', botUsername)}`;
}
