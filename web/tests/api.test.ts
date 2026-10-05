import { afterEach, describe, expect, it, vi } from 'vitest';
import { inlineReference, loadProfile, parseReference } from '../src/api';

const uuid = '069a79f444e94726a5befca90e38aaf5';
const hash = 'a'.repeat(64);
const reference = { kind: 'profile' as const, id: uuid };
const profile = { uuid, reference: uuid, name: 'Notch', model: 'classic', skin_url: `https://skin.example/api/skin/${hash}.png`, cape_url: null };

afterEach(() => vi.unstubAllGlobals());

describe('public content selectors', () => {
  it.each([
    [`?uuid=069a79f4-44e9-4726-a5be-fca90e38aaf5`, undefined, reference],
    [`?tgWebAppStartParam=${uuid.toUpperCase()}`, undefined, reference],
    ['', uuid, reference],
    [`?upload=${hash}`, undefined, { kind: 'upload', id: hash }],
    ['', `upload_${hash}`, { kind: 'upload', id: hash }],
    [`?tgWebAppStartParam=u${btoa('\xaa'.repeat(32)).replace(/=+$/, '')}`, undefined, { kind: 'upload', id: hash }],
    ['', `u${'q'.repeat(43)}`, null],
    ['?uuid=../../cache', uuid, null],
    ['?upload=https://example.org/skin.png', undefined, null],
    ['', 'upload_123', null],
  ])('resolves URL and Main Mini App inputs safely: %s', (search, start, expected) => {
    expect(parseReference(search, start)).toEqual(expected);
  });
  it('keeps uploads shareable using content identity', () => {
    expect(inlineReference({ kind: 'upload', id: hash })).toBe(`upload:${hash}`);
  });
});

describe('profile API boundary', () => {
  it('retains the provider model and public cape while omitting credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...profile, model: 'slim', cape_url: `https://skin.example/api/cape/${hash}.png` })));
    vi.stubGlobal('fetch', fetcher);
    const result = await loadProfile(reference, 'https://skin.example');
    expect(result.model).toBe('slim');
    expect(result.cape_url).toBe(`https://skin.example/api/cape/${hash}.png`);
    expect(fetcher.mock.calls[0][0].href).toBe(`https://skin.example/api/profile/${uuid}`);
    expect(fetcher.mock.calls[0][1].credentials).toBe('omit');
  });
  it.each([
    { ...profile, skin_url: `https://attacker.example/api/skin/${hash}.png` },
    { ...profile, skin_url: 'https://skin.example/api/skin/../../private' },
    { ...profile, skin_url: `https://skin.example/api/skin/${hash}.png?url=https://attacker.example` },
    { ...profile, reference: 'other-player' },
    { ...profile, uuid: 'b'.repeat(32) },
    { ...profile, model: 'unexpected' },
  ])('rejects invalid identities and asset locations', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    await expect(loadProfile(reference, 'https://skin.example')).rejects.toThrow('Skin data is unavailable');
  });
  it('explains expired uploads with a recoverable action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 410 })));
    await expect(loadProfile({ kind: 'upload', id: hash }, 'https://skin.example')).rejects.toThrow('Send the PNG to the bot again');
  });
  it.each([null, { uuid }, 'invalid'])('handles malformed provider data as a clean error', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    await expect(loadProfile(reference, 'https://skin.example')).rejects.toThrow('Skin data is unavailable');
  });
  it('turns transport failure into concise retry guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('raw network details')));
    await expect(loadProfile(reference, 'https://skin.example')).rejects.toThrow('Skin service is busy. Try again.');
  });
});
