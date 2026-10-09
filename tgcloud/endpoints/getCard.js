import { botIdentity } from '../lib/telegram/bot-identity.js';
import { endpointCall, loadEndpointCard, viewerState } from '../lib/telegram/endpoints.js';

export default async function getCard(input, ctx) {
  return endpointCall(ctx, async () => {
    const card = await loadEndpointCard(input, ctx);
    return viewerState(card, await botIdentity());
  });
}
