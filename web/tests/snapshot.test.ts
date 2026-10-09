import { describe, expect, it } from 'vitest';
import { configuredBotUsername, parseCardReference, parseLinkReference, parseSnapshot, parseSnapshotToken } from '../src/snapshot';

const skin = 'a'.repeat(64);
const cape = 'b'.repeat(64);

describe('immutable texture snapshots', () => {
  it.each([
    [`?texture=c-${skin}`, undefined, 'classic', skin, null],
    [`?texture=S-${skin.toUpperCase()}-${cape.toUpperCase()}`, undefined, 'slim', skin, cape],
    [`?tgWebAppStartParam=t-u-${skin}-${cape}`, undefined, 'unknown', skin, cape],
    ['', `t-c-${skin.slice(0, 32)}`, 'classic', skin.slice(0, 32), null],
  ])('loads the same fixed identity from public and Telegram launches: %s', (search, start, model, skinHash, capeHash) => {
    const snapshot = parseSnapshot(search, start);
    expect(snapshot).toEqual({
      token: `${model === 'slim' ? 's' : model === 'classic' ? 'c' : 'u'}-${skinHash}${capeHash ? `-${capeHash}` : ''}`,
      model,
      skinURL: `https://textures.minecraft.net/texture/${skinHash}`,
      capeURL: capeHash ? `https://textures.minecraft.net/texture/${capeHash}` : null,
    });
  });

  it.each([
    '', `c-${skin.slice(0, 31)}`, `c-${skin}a`, `x-${skin}`, `c-${skin}-${cape}b`,
    `c-${skin}-../secret`, `c-${skin}?url=https://other.example`, 'https://textures.minecraft.net/texture/example',
    `c-${skin}\n`, `c-${skin}/${cape}`, `c-${skin}-`,
  ])('rejects malformed identities before constructing texture URLs: %s', (token) => {
    expect(parseSnapshotToken(token)).toBeNull();
  });

  it('does not mask an invalid URL reference with a valid Telegram start parameter', () => {
    expect(parseSnapshot('?texture=invalid', `t-c-${skin}`)).toBeNull();
    expect(parseSnapshot(`?texture=c-${skin}&texture=s-${skin}`)).toBeNull();
    expect(parseSnapshot('?tgWebAppStartParam=invalid', `t-c-${skin}`)).toBeNull();
  });
});

it('allows bot handoff only for an explicit valid bot username', () => {
  expect(configuredBotUsername('minecraft_skin_bot')).toBe('minecraft_skin_bot');
  for (const input of [undefined, '', 'https://other.example', '@minecraft_skin_bot', 'bot', 'a'.repeat(33)]) {
    expect(configuredBotUsername(input)).toBeNull();
  }
});

it('reads card references from links and Main Mini App launches without accepting ambiguous IDs', () => {
  expect(parseCardReference('?card=42')).toBe(42);
  expect(parseCardReference('', 'c-42')).toBe(42);
  expect(parseCardReference('?tgWebAppStartParam=c-42')).toBe(42);
  for (const search of ['?card=0', '?card=42&card=43', '?card=1e3', '?card=-42', '?card=1000000000000000']) {
    expect(parseCardReference(search, 'c-42')).toBeNull();
  }
  expect(parseCardReference('', '42')).toBeNull();
  expect(parseCardReference('', `t-c-${skin}`)).toBeNull();
});

it('sends the endpoint only the reference the launch link itself carries', () => {
  expect(parseLinkReference(`?texture=c-${skin}&lang=en&view=3d`)).toEqual({ token: `c-${skin}` });
  expect(parseLinkReference(`?texture=s-${skin.toUpperCase()}-${cape.toUpperCase()}&card=42`))
    .toEqual({ token: `s-${skin}-${cape}`, cardId: 42 });
  expect(parseLinkReference('?card=42')).toEqual({ cardId: 42 });
  for (const search of ['', '?lang=en', '?tgWebAppStartParam=c-42', `?tgWebAppStartParam=t-c-${skin}`]) {
    expect(parseLinkReference(search)).toEqual({});
  }
  for (const search of ['?texture=invalid', `?texture=c-${skin}&texture=s-${skin}`, '?card=0', '?card=42&card=43']) {
    expect(parseLinkReference(search)).toEqual({});
  }
});
