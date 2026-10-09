export type SkinModel = 'classic' | 'slim' | 'unknown';

export interface SkinSnapshot {
  token: string;
  model: SkinModel;
  skinURL: string;
  capeURL: string | null;
}

export interface LinkReference {
  token?: string;
  cardId?: number;
}

const snapshotPattern = /^([csu])-([a-f0-9]{32,64})(?:-([a-f0-9]{32,64}))?$/i;
const cardIdPattern = /^[1-9][0-9]{0,14}$/;

export function parseSnapshotToken(value: string): SkinSnapshot | null {
  const match = snapshotPattern.exec(value);
  if (!match) return null;
  const [, model, skin, cape] = match.map((part) => part?.toLowerCase());
  return {
    token: value.toLowerCase(),
    model: model === 's' ? 'slim' : model === 'c' ? 'classic' : 'unknown',
    skinURL: `https://textures.minecraft.net/texture/${skin}`,
    capeURL: cape ? `https://textures.minecraft.net/texture/${cape}` : null,
  };
}

function cardId(value: string | null): number | null {
  return value !== null && cardIdPattern.test(value) ? Number(value) : null;
}

export function parseSnapshot(search: string, startParam?: string): SkinSnapshot | null {
  const params = new URLSearchParams(search);
  if (params.has('texture')) {
    return params.getAll('texture').length === 1 ? parseSnapshotToken(params.get('texture') ?? '') : null;
  }
  const start = params.get('tgWebAppStartParam') ?? startParam ?? '';
  return start.startsWith('t-') ? parseSnapshotToken(start.slice(2)) : null;
}

export function configuredBotUsername(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{5,32}$/i.test(value) ? value : null;
}

export function parseCardReference(search: string, startParam?: string): number | null {
  const params = new URLSearchParams(search);
  const cards = params.getAll('card');
  if (cards.length) return cards.length === 1 ? cardId(cards[0]) : null;
  const start = params.get('tgWebAppStartParam') ?? startParam ?? '';
  return start.startsWith('c-') ? cardId(start.slice(2)) : null;
}

/**
 * The reference carried in the launch URL's own query. A `startapp` launch has none; the
 * endpoint resolves that from the platform-verified `start_param`.
 */
export function parseLinkReference(search: string): LinkReference {
  const params = new URLSearchParams(search);
  const reference: LinkReference = {};
  const textures = params.getAll('texture');
  if (textures.length === 1) {
    const snapshot = parseSnapshotToken(textures[0]);
    if (snapshot) reference.token = snapshot.token;
  }
  const cards = params.getAll('card');
  if (cards.length === 1) {
    const id = cardId(cards[0]);
    if (id !== null) reference.cardId = id;
  }
  return reference;
}
