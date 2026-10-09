import { api, EndpointError } from 'sdk';
import { botIdentity } from '../lib/telegram/bot-identity.js';
import { cardAction, createCard } from '../lib/telegram/card-state.js';
import { endpointCall, invalidReference, loadEndpointCard } from '../lib/telegram/endpoints.js';
import { profileRichMessage, viewerConfigured } from '../lib/telegram/formatting.js';
import { translate } from '../lib/telegram/i18n.js';
import { withMedia } from '../lib/telegram/media-cache.js';
import { cacheConfigured, previewMedia } from '../lib/telegram/preview-media.js';

export default async function prepareShare(input, ctx) {
  return endpointCall(ctx, async (user, locale) => {
    if (!['skin', 'three-view'].includes(input.view)) throw invalidReference();
    if (!viewerConfigured() || !cacheConfigured()) {
      const code = !viewerConfigured() ? 'unconfigured' : 'cacheUnconfigured';
      throw new EndpointError(translate(locale, code), { code });
    }
    const source = await loadEndpointCard(input);
    const card = await createCard(source.profile, { inlineUserId: user.id });
    const bot = await botIdentity();
    const prepared = await previewMedia(card.profile, bot.id).prepare(input.view);
    return withMedia(prepared.plan, prepared.options, async (media) => {
      const result = await api.savePreparedInlineMessage({
        user_id: user.id,
        allow_user_chats: true,
        allow_bot_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
        result: {
          type: media.type,
          id: cardAction(card.id, input.view),
          [media.type === 'photo' ? 'photo_file_id' : 'document_file_id']: media.fileId,
          title: translate(locale, input.view),
          description: card.profile.name ?? translate(locale, 'sharedSkin'),
          input_message_content: {
            rich_message: profileRichMessage(card, locale, media, input.view),
          },
        },
      });
      return { id: result.id, expirationDate: result.expiration_date };
    });
  });
}
