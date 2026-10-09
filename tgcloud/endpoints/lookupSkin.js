import { resolveProfile } from '../lib/minecraft/client.js';
import { MinecraftError } from '../lib/minecraft/errors.js';
import { botIdentity } from '../lib/telegram/bot-identity.js';
import { createCard } from '../lib/telegram/card-state.js';
import { endpointCall, invalidReference, viewerState } from '../lib/telegram/endpoints.js';

export default async function lookupSkin(input, ctx) {
  return endpointCall(ctx, async () => {
    if (typeof input.reference !== 'string' || input.reference.length > 256) throw invalidReference();
    const profile = await resolveProfile(input.reference.trim());
    if (!profile.snapshot) throw new MinecraftError('NOT_FOUND', 404, 'Skin unavailable.');
    const card = await createCard(profile);
    return viewerState(card, await botIdentity());
  });
}
