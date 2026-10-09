import { api, BotApiError, db, InputFile } from 'sdk';
import { and, eq, isNull, sql } from 'sdk/db';
import { cacheTarget, mediaCache } from '../../schema.js';
import { staleFileReference } from './errors.js';
import { textureURL } from '../minecraft/reference.js';

const PHOTO_KINDS = new Set(['head', 'front', 'back', 'side', 'three-view']);
const LEASE_MS = 8000;

export class MediaCacheBusy extends Error {
  constructor(retryAt) {
    super('Media cache is busy.');
    this.retryAt = retryAt;
  }
}

function botIdValid(botId) {
  return Number.isSafeInteger(botId) && botId > 0 && botId < 2 ** 52;
}

export function mediaKey(plan) {
  if (!plan || !botIdValid(plan.botId)) throw new TypeError('Invalid media bot.');
  textureURL(plan.skinHash);
  if (plan.kind === 'skin') return `${plan.botId}:${plan.skinHash}:document`;
  if (!PHOTO_KINDS.has(plan.kind)
    || typeof plan.rendererVersion !== 'string'
    || !/^[A-Za-z0-9._-]{1,32}$/u.test(plan.rendererVersion)) {
    throw new TypeError('Invalid preview recipe.');
  }
  let model = '';
  if (plan.kind !== 'head') {
    if (plan.renderModel !== 'classic' && plan.renderModel !== 'slim') {
      throw new TypeError('Expected the preview pixel model.');
    }
    model = `:${plan.renderModel}`;
  }
  return `${plan.botId}:${plan.skinHash}:photo:${plan.kind}${model}:${plan.rendererVersion}`;
}

function mediaType(plan) {
  return plan.kind === 'skin' ? 'document' : 'photo';
}

function reference(row, key, type) {
  if (!row?.fileId) return null;
  if (row.type !== type || typeof row.fileId !== 'string'
    || !Number.isSafeInteger(row.generation) || row.generation <= 0) {
    throw new Error('Invalid cached media reference.');
  }
  return { key, type, fileId: row.fileId, generation: row.generation };
}

export async function readMedia(plan) {
  const key = mediaKey(plan);
  const row = await db.select({ type: mediaCache.type, fileId: mediaCache.fileId, generation: mediaCache.generation })
    .from(mediaCache).where(eq(mediaCache.key, key)).get();
  return reference(row, key, mediaType(plan));
}

async function retryAt(targetKey) {
  const row = await db.select({ retryAt: cacheTarget.retryAt }).from(cacheTarget)
    .where(eq(cacheTarget.key, targetKey)).get();
  return row?.retryAt.getTime() ?? 0;
}

async function busy(key, targetKey) {
  const row = await db.select({ leaseUntil: mediaCache.leaseUntil }).from(mediaCache)
    .where(eq(mediaCache.key, key)).get();
  return new MediaCacheBusy(Math.max(Date.now(), row?.leaseUntil.getTime() ?? 0, await retryAt(targetKey)));
}

function uploadedFileId(message, type, cacheChatId) {
  if (message?.chat?.id !== cacheChatId) throw new Error('Unexpected cache upload target.');
  if (type === 'document') {
    if (typeof message.document?.file_id !== 'string' || !message.document.file_id) {
      throw new Error('Cache upload did not return a document.');
    }
    return message.document.file_id;
  }
  const photos = (Array.isArray(message.photo) ? message.photo : []).filter((photo) => (
    typeof photo.file_id === 'string' && photo.file_id
    && Number.isSafeInteger(photo.width) && photo.width > 0
    && Number.isSafeInteger(photo.height) && photo.height > 0
  ));
  if (!photos.length) throw new Error('Cache upload did not return a photo.');
  return photos.reduce((selected, photo) => (
    photo.width * photo.height > selected.width * selected.height ? photo : selected
  )).file_id;
}

export async function getMedia(plan, { cacheChatId, produce, admissionUntil = Date.now() + LEASE_MS } = {}) {
  const key = mediaKey(plan);
  if (!Number.isSafeInteger(cacheChatId) || cacheChatId === 0 || Math.abs(cacheChatId) >= 2 ** 52
    || !Number.isSafeInteger(admissionUntil)) throw new TypeError('Invalid cache upload options.');
  const cached = await readMedia(plan);
  if (cached) return cached;
  if (typeof produce !== 'function') throw new TypeError('A byte producer is required on a cache miss.');
  const now = Date.now();
  if (admissionUntil <= now) throw new MediaCacheBusy(now);
  const leaseUntil = Math.min(admissionUntil, now + LEASE_MS);
  const type = mediaType(plan);
  const targetKey = `${plan.botId}:${cacheChatId}`;
  const claim = await db.run(sql`
    INSERT INTO media_cache (key, type, generation, lease_until)
    SELECT ${key}, ${type}, 1, ${leaseUntil}
    WHERE NOT EXISTS (SELECT 1 FROM cache_target WHERE ${cacheTarget.key} = ${targetKey} AND ${cacheTarget.retryAt} > ${now})
    ON CONFLICT(key) DO UPDATE SET generation = generation + 1, lease_until = ${leaseUntil}
    WHERE file_id IS NULL AND lease_until <= ${now}
    RETURNING generation`);
  if (!claim.rowsAffected) {
    const available = await readMedia(plan);
    if (available) return available;
    throw await busy(key, targetKey);
  }
  const generation = claim.rows[0]?.generation;
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error('Invalid cache claim.');
  let uploadStarted = false;
  try {
    if (Date.now() >= leaseUntil) throw new MediaCacheBusy(Date.now());
    const bytes = await produce({ admissionUntil: leaseUntil });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0
      || bytes.byteLength > (type === 'document' ? 1048576 : 10 * 1024 * 1024)) {
      throw new TypeError('Expected bounded PNG bytes.');
    }
    const cooldown = await retryAt(targetKey);
    if (Date.now() >= leaseUntil || cooldown > Date.now()) {
      throw new MediaCacheBusy(Math.max(Date.now(), cooldown));
    }
    const file = new InputFile(bytes, `skin-${plan.skinHash.slice(0, 12)}-${plan.kind}.png`, { type: 'image/png' });
    let message;
    uploadStarted = true;
    try {
      const params = { chat_id: cacheChatId, disable_notification: true };
      message = type === 'document'
        ? await api.sendDocument({ ...params, document: file })
        : await api.sendPhoto({ ...params, photo: file });
    } catch (error) {
      const seconds = error.parameters?.retry_after;
      const retryTime = new Date(Date.now() + seconds * 1000);
      if (error instanceof BotApiError && error.code === 429
        && Number.isSafeInteger(seconds) && seconds >= 0
        && Number.isFinite(retryTime.getTime())) {
        await db.insert(cacheTarget).values({ key: targetKey, retryAt: retryTime })
          .onConflictDoUpdate({ target: cacheTarget.key, set: {
            retryAt: sql`max(${cacheTarget.retryAt}, ${retryTime.getTime()})`,
          } });
      }
      throw error;
    }
    const fileId = uploadedFileId(message, type, cacheChatId);
    const saved = await db.update(mediaCache).set({ fileId, leaseUntil: new Date(0) })
      .where(and(eq(mediaCache.key, key), eq(mediaCache.generation, generation), isNull(mediaCache.fileId)));
    if (!saved.rowsAffected) {
      const available = await readMedia(plan);
      if (available) return available;
      throw await busy(key, targetKey);
    }
    return { key, type, fileId, generation };
  } catch (error) {
    if (!uploadStarted || error instanceof BotApiError) {
      await db.update(mediaCache).set({ leaseUntil: new Date(0) })
        .where(and(eq(mediaCache.key, key), eq(mediaCache.generation, generation), isNull(mediaCache.fileId)));
    }
    throw error;
  }
}

export async function invalidateMedia(media) {
  const result = await db.update(mediaCache).set({ fileId: null, leaseUntil: new Date(0) })
    .where(and(eq(mediaCache.key, media.key), eq(mediaCache.type, media.type),
      eq(mediaCache.fileId, media.fileId), eq(mediaCache.generation, media.generation)));
  return result.rowsAffected === 1;
}

export async function withMedia(plan, options, consume) {
  if (typeof consume !== 'function') throw new TypeError('A media consumer is required.');
  const media = await getMedia(plan, options);
  try {
    return await consume(media);
  } catch (error) {
    if (!staleFileReference(error)) throw error;
    await invalidateMedia(media);
    return consume(await getMedia(plan, options));
  }
}
