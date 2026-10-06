import { translator } from './i18n';

export type SkinReference = { kind: 'profile' | 'upload'; id: string };
export type SkinModel = 'classic' | 'slim' | 'unknown';

export interface SkinProfile {
  uuid: string | null;
  name: string;
  model: SkinModel;
  skin_url: string;
  cape_url: string | null;
  reference: string;
  bot_username: string;
}

const uuidPattern = /^[a-f0-9]{32}$/i;
const hashPattern = /^[a-f0-9]{64}$/i;

export function parseReference(search: string, startParam?: string): SkinReference | null {
  const params = new URLSearchParams(search);
  if (params.has('uuid')) {
    const id = (params.get('uuid') ?? '').replaceAll('-', '');
    return uuidPattern.test(id) ? { kind: 'profile', id: id.toLowerCase() } : null;
  }
  if (params.has('upload')) {
    const id = params.get('upload') ?? '';
    return hashPattern.test(id) ? { kind: 'upload', id: id.toLowerCase() } : null;
  }
  const value = params.get('tgWebAppStartParam') ?? startParam ?? '';
  if (uuidPattern.test(value)) return { kind: 'profile', id: value.toLowerCase() };
  if (/^u[A-Za-z0-9_-]{43}$/.test(value)) {
    const encoded = value.slice(1).replaceAll('-', '+').replaceAll('_', '/');
    const bytes = atob(encoded + '=');
    const canonical = btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    if (bytes.length === 32 && canonical === value.slice(1)) {
      return { kind: 'upload', id: Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('') };
    }
    return null;
  }
  if (value.startsWith('upload_') && hashPattern.test(value.slice(7))) {
    return { kind: 'upload', id: value.slice(7).toLowerCase() };
  }
  return null;
}

export function inlineReference(reference: SkinReference): string {
  return reference.kind === 'upload' ? `upload:${reference.id}` : reference.id;
}

type ViewerErrorCode = 'serviceBusy' | 'uploadExpired' | 'playerNotFound' | 'invalidData';

export class ViewerError extends Error {
  constructor(readonly code: ViewerErrorCode) { super(translator('en')(code)); }
}

function assetURL(value: unknown, kind: 'skin' | 'cape', base: URL): string {
  if (typeof value !== 'string') throw new ViewerError('invalidData');
  const url = new URL(value, base);
  const prefix = base.pathname.replace(/\/$/, '');
  const path = url.pathname.slice(prefix.length);
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix + '/') || !new RegExp(`^/api/${kind}/[a-f0-9]{64}\\.png$`).test(path)
    || url.search || url.hash || url.username || url.password) {
    throw new ViewerError('invalidData');
  }
  return url.href;
}

export async function loadProfile(reference: SkinReference, apiBase: string): Promise<SkinProfile> {
  const base = new URL(apiBase.replace(/\/$/, '') + '/', window.location.origin);
  const path = reference.kind === 'upload' ? 'upload' : 'profile';
  let response: Response;
  try {
    response = await fetch(new URL(`api/${path}/${reference.id}`, base), {
      signal: AbortSignal.timeout(15_000),
      credentials: 'omit',
    });
  } catch {
    throw new ViewerError('serviceBusy');
  }
  if (response.status === 410 || (response.status === 404 && reference.kind === 'upload')) {
    throw new ViewerError('uploadExpired');
  }
  if (response.status === 404) throw new ViewerError('playerNotFound');
  if (!response.ok) throw new ViewerError('serviceBusy');
  const value: unknown = await response.json().catch(() => null);
  if (typeof value !== 'object' || value === null) throw new ViewerError('invalidData');
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string' || !['classic', 'slim', 'unknown'].includes(String(data.model))
    || typeof data.bot_username !== 'string' || !/^[a-z0-9_]{5,32}$/i.test(data.bot_username)
    || data.reference !== inlineReference(reference)
    || (reference.kind === 'profile' ? data.uuid !== reference.id : data.uuid !== null)) {
    throw new ViewerError('invalidData');
  }
  return {
    uuid: data.uuid as string | null,
    name: data.name,
    model: data.model as SkinModel,
    skin_url: assetURL(data.skin_url, 'skin', base),
    cape_url: data.cape_url === null ? null : assetURL(data.cape_url, 'cape', base),
    reference: data.reference,
    bot_username: data.bot_username,
  };
}
