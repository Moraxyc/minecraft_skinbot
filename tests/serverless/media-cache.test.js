import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { createDb, schemaDdl, sdkDb } from './fixtures/sdk-db.js';

class BotApiError extends Error {
  constructor(code, description, parameters = {}) {
    super(description);
    Object.assign(this, { code, description, parameters });
  }
}

class InputFile {
  constructor(bytes, filename, options) {
    Object.assign(this, { bytes, filename, ...options });
  }
}

let database;
let now;
let uploadHook;
let beforeWrite;
let clock;
const uploads = [];

mock.module('sdk/db', { exports: sdkDb });

async function upload(type, params) {
  const number = uploads.push({ type, params });
  const override = await uploadHook(type, params, number);
  return override ?? {
    chat: { id: params.chat_id },
    ...(type === 'document' ? {
      document: { file_id: `document-${number}`, file_unique_id: 'not-a-file-id' },
    } : {
      photo: [
        { file_id: `photo-${number}`, file_unique_id: 'not-a-file-id', width: 800, height: 800 },
        { file_id: `small-${number}`, width: 80, height: 80 },
      ],
    }),
  };
}

mock.module('sdk', {
  exports: {
    BotApiError, InputFile,
    api: {
      sendPhoto: (params) => upload('photo', params),
      sendDocument: (params) => upload('document', params),
    },
    db: createDb({
      async run(sql, params) {
        beforeWrite(sql, params);
        const statement = database.prepare(sql);
        if (/\bRETURNING\b/iu.test(sql)) {
          const rows = statement.all(params);
          return { rows, rowsAffected: rows.length, lastInsertRowid: 0 };
        }
        const result = statement.run(params);
        return { rows: [], rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
      async get(sql, params) { return database.prepare(sql).get(params) ?? null; },
    }),
  },
});

const schema = await import('../../tgcloud/schema.js');
const { mediaKey, readMedia, getMedia, invalidateMedia, withMedia, MediaCacheBusy } =
  await import('../../tgcloud/lib/telegram/media-cache.js');
const plan = { botId: 42, skinHash: 'a'.repeat(64), kind: 'front', renderModel: 'slim', rendererVersion: '1' };
const cacheChatId = -1001234567890;
const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 17]);
const options = { cacheChatId, produce: async () => bytes };

beforeEach(() => {
  database?.close();
  database = new DatabaseSync(':memory:');
  for (const statement of schemaDdl(schema)) database.exec(statement);
  now = 1000000;
  clock = mock.method(Date, 'now', () => now);
  uploads.length = 0;
  uploadHook = async () => undefined;
  beforeWrite = () => undefined;
});
afterEach(() => clock.mock.restore());
after(() => database.close());

const { encodeSnapshot } = await import('../../tgcloud/lib/minecraft/reference.js');
const { rememberSnapshot, readSnapshot, readTextureHeight, rememberTextureHeight } = await import('../../tgcloud/lib/telegram/snapshots.js');

test('persistent original hits survive a new module instance without production and preserve upload bytes', async () => {
  const original = { ...plan, kind: 'skin' };
  const source = new Uint8Array([99, ...bytes, 88]).subarray(1, bytes.length + 1);
  const first = await getMedia(original, { cacheChatId, produce: async () => source });
  assert.equal(first.type, 'document');
  assert.equal(uploads[0].params.document.bytes, source);
  assert.deepEqual(uploads[0].params.document.bytes, bytes);
  assert.equal(uploads[0].params.document.type, 'image/png');
  assert.equal(uploads[0].params.disable_notification, true);
  const restarted = await import('../../tgcloud/lib/telegram/media-cache.js?restart-original');
  const hit = await restarted.getMedia({ ...original, renderModel: 'classic', rendererVersion: 'changed' }, {
    cacheChatId: -1009999999999,
    produce: async () => { throw new Error('A persisted hit must not produce bytes'); },
  });
  assert.deepEqual(hit, first);
  assert.equal(uploads.length, 1);
});

test('preview identity separates bot, skin, pixel model, view and renderer but excludes target, cape and head arm width', async () => {
  const first = await getMedia(plan, options);
  assert.equal(first.fileId, 'photo-1');
  const hit = await getMedia({ ...plan, capeHash: 'b'.repeat(64), name: 'AnotherPlayer' }, {
    ...options, cacheChatId: -1009999999999,
  });
  assert.deepEqual(hit, first);
  for (const variation of [
    { botId: 43 }, { skinHash: 'b'.repeat(64) }, { renderModel: 'classic' },
    { kind: 'back' }, { rendererVersion: '2' },
  ]) {
    const distinct = await getMedia({ ...plan, ...variation }, options);
    assert.notEqual(distinct.fileId, first.fileId);
  }
  const head = await getMedia({ ...plan, kind: 'head' }, options);
  assert.deepEqual(await getMedia({ ...plan, kind: 'head', renderModel: 'classic' }, options), head);
  assert.equal(uploads.length, 7);
  assert.throws(() => mediaKey({ ...plan, renderModel: 'unknown' }), /pixel model/);
  for (const rendererVersion of ['', '1\n', 'x'.repeat(33)]) {
    assert.throws(() => mediaKey({ ...plan, rendererVersion }), TypeError);
  }
});

test('an active claim rejects a concurrent producer and a completed upload is visible before consumption', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let produced = 0;
  const pending = getMedia(plan, { cacheChatId, produce: async () => {
    produced += 1;
    started.resolve();
    await release.promise;
    return bytes;
  } });
  try {
    await started.promise;
    await assert.rejects(getMedia(plan, { ...options, produce: async () => {
      produced += 1;
      return bytes;
    } }), (error) => error instanceof MediaCacheBusy && error.retryAt === now + 8000);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(produced, 1);
  assert.equal(uploads.length, 1);
  const result = await withMedia(plan, options, async (media) => {
    assert.equal((await readMedia(plan)).fileId, media.fileId);
    return 'consumed';
  });
  assert.equal(result, 'consumed');
});

test('a started upload can persist after admission expires without a successor', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const admissionUntil = now + 20;
  uploadHook = async () => {
    started.resolve();
    await release.promise;
  };
  const pending = getMedia(plan, { ...options, admissionUntil });
  let media;
  try {
    await started.promise;
    now = admissionUntil;
    assert.equal(await readMedia(plan), null);
  } finally {
    release.resolve();
    media = await pending;
  }
  assert.deepEqual(media, { key: mediaKey(plan), type: 'photo', fileId: 'photo-1', generation: 1 });
  assert.deepEqual(await readMedia(plan), media);
  assert.equal(uploads.length, 1);
});

test('an expired upload lease is reclaimed and a late previous generation cannot replace its successor', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  uploadHook = async (_type, _params, number) => {
    if (number === 1) {
      started.resolve();
      await release.promise;
    }
  };
  const pending = getMedia(plan, options);
  let successor;
  try {
    await started.promise;
    now += 8001;
    successor = await getMedia(plan, options);
    assert.equal(successor.generation, 2);
  } finally {
    release.resolve();
  }
  const late = await pending;
  assert.deepEqual(late, successor);
  assert.deepEqual(await readMedia(plan), successor);
  assert.equal(uploads.length, 2);
  const otherPlan = { ...plan, kind: 'head' };
  const olderStarted = Promise.withResolvers();
  const newerStarted = Promise.withResolvers();
  const releaseOlder = Promise.withResolvers();
  const releaseNewer = Promise.withResolvers();
  uploadHook = async (_type, _params, number) => {
    if (number === 3) {
      olderStarted.resolve();
      await releaseOlder.promise;
    } else {
      newerStarted.resolve();
      await releaseNewer.promise;
    }
  };
  const older = getMedia(otherPlan, options);
  await olderStarted.promise;
  now += 8001;
  const newer = getMedia(otherPlan, options);
  try {
    await newerStarted.promise;
    releaseOlder.resolve();
    await assert.rejects(older, MediaCacheBusy);
    assert.equal(await readMedia(otherPlan), null);
  } finally {
    releaseOlder.resolve();
    releaseNewer.resolve();
    await newer;
  }
  assert.equal((await readMedia(otherPlan)).fileId, 'photo-4');
  assert.equal((await readMedia(otherPlan)).generation, 2);
});

test('deferred preparation after admission and invalid byte producers do not upload and release their claims', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const admissionUntil = now + 20;
  let receivedAdmissionUntil;
  const rejected = assert.rejects(getMedia(plan, { ...options, admissionUntil, produce: async context => {
    receivedAdmissionUntil = context.admissionUntil;
    started.resolve();
    return release.promise;
  } }), MediaCacheBusy);
  try {
    await started.promise;
    assert.equal(receivedAdmissionUntil, admissionUntil);
    now = admissionUntil;
    assert.equal(uploads.length, 0);
  } finally {
    release.resolve(bytes);
    await rejected;
  }
  assert.equal(uploads.length, 0);
  const claim = database.prepare('SELECT file_id, generation, lease_until FROM media_cache WHERE key = ?').get(mediaKey(plan));
  assert.deepEqual({ ...claim }, { file_id: null, generation: 1, lease_until: 0 });
  for (const output of [new Uint8Array(), new Uint8Array(1048577), 'not-bytes']) {
    await assert.rejects(getMedia({ ...plan, kind: 'skin' }, {
      cacheChatId, produce: async () => output,
    }), TypeError);
  }
  await assert.rejects(getMedia(plan, {
    cacheChatId, produce: async () => new Uint8Array(10 * 1024 * 1024 + 1),
  }), TypeError);
  assert.equal(uploads.length, 0);
  assert.equal((await getMedia(plan, options)).type, 'photo');
});

test('429 cooldown persists across invocations without blocking hits or unrelated bot and cache targets', async () => {
  const warmPlan = { ...plan, kind: 'head' };
  const warm = await getMedia(warmPlan, options);
  const flood = new BotApiError(429, 'Too Many Requests', { retry_after: 30 });
  uploadHook = async () => { throw flood; };
  await assert.rejects(getMedia(plan, options), (error) => error === flood);
  uploadHook = async () => undefined;
  const restarted = await import('../../tgcloud/lib/telegram/media-cache.js?restart-cooldown');
  assert.deepEqual(await restarted.getMedia(warmPlan, options), warm);
  await assert.rejects(restarted.getMedia({ ...plan, skinHash: 'c'.repeat(64) }, {
    cacheChatId, produce: async () => { assert.fail('Cooldown must precede production'); },
  }), (error) => error instanceof restarted.MediaCacheBusy && error.retryAt === now + 30000);
  await restarted.getMedia(plan, { ...options, cacheChatId: -1009999999999 });
  await restarted.getMedia({ ...plan, botId: 43 }, options);
  now += 30000;
  await restarted.getMedia({ ...plan, skinHash: 'c'.repeat(64) }, options);
  assert.equal(uploads.length, 5);
});

test('concurrent flood responses retain the longest target cooldown', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  uploadHook = async (_type, _params, number) => {
    if (number === 1) {
      started.resolve();
      await release.promise;
    }
    throw new BotApiError(429, 'Too Many Requests', { retry_after: number === 1 ? 10 : 30 });
  };
  const pending = getMedia(plan, options);
  const rejected = assert.rejects(pending, BotApiError);
  try {
    await started.promise;
    await assert.rejects(getMedia({ ...plan, kind: 'head' }, options), BotApiError);
  } finally {
    release.resolve();
    await rejected;
  }
  await assert.rejects(getMedia({ ...plan, kind: 'back' }, options), (error) => (
    error instanceof MediaCacheBusy && error.retryAt === now + 30000
  ));
});

test('precise invalidation repairs once, does not erase a successor or unrelated media, and preserves unrelated failures', async () => {
  const first = await getMedia(plan, options);
  const otherPlan = { ...plan, kind: 'head' };
  const other = await getMedia(otherPlan, options);
  const expired = new BotApiError(400, 'Bad Request: file reference expired');
  let attempts = 0;
  const repaired = await withMedia(plan, options, async (media) => {
    attempts += 1;
    if (attempts === 1) throw expired;
    assert.equal((await readMedia(plan)).fileId, media.fileId);
    return media;
  });
  assert.equal(attempts, 2);
  assert.notEqual(repaired.fileId, first.fileId);
  assert.equal(await invalidateMedia(first), false);
  assert.deepEqual(await readMedia(plan), repaired);
  assert.deepEqual(await readMedia(otherPlan), other);
  const uploadsBefore = uploads.length;
  attempts = 0;
  await assert.rejects(withMedia(plan, options, async () => {
    attempts += 1;
    throw expired;
  }), (error) => error === expired);
  assert.equal(attempts, 2);
  assert.equal(uploads.length, uploadsBefore + 1);
  const ready = await readMedia(plan);
  for (const error of [new BotApiError(400, 'Invalid rich layout'), new BotApiError(403, 'Forbidden'), new Error('file reference expired')]) {
    await assert.rejects(withMedia(plan, options, async () => { throw error; }), (failure) => failure === error);
    assert.deepEqual(await readMedia(plan), ready);
  }
  assert.equal(uploads.length, uploadsBefore + 1);
});

test('an uncommitted or uncertain upload is not returned or immediately repeated and recovers after its lease', async () => {
  const storageFailure = new Error('Synthetic storage failure');
  beforeWrite = (sql) => {
    if (/^UPDATE "media_cache" SET "file_id" = /u.test(sql)) throw storageFailure;
  };
  await assert.rejects(getMedia(plan, options), (error) => error === storageFailure);
  assert.equal(await readMedia(plan), null);
  beforeWrite = () => undefined;
  await assert.rejects(getMedia(plan, options), MediaCacheBusy);
  assert.equal(uploads.length, 1);
  now += 8001;
  await getMedia(plan, options);
  const uncertainPlan = { ...plan, kind: 'head' };
  const uncertain = new Error('Unknown delivery status');
  uploadHook = async () => { throw uncertain; };
  await assert.rejects(getMedia(uncertainPlan, options), (error) => error === uncertain);
  uploadHook = async () => undefined;
  await assert.rejects(getMedia(uncertainPlan, options), MediaCacheBusy);
  assert.equal(uploads.length, 3);
  now += 8001;
  assert.equal((await getMedia(uncertainPlan, options)).type, 'photo');
});

test('document and photo responses cannot substitute unique IDs, thumbnails or media from a different target', async () => {
  for (const [kind, response] of [
    ['skin', { document: { file_unique_id: 'unique-only', thumbnail: { file_id: 'thumb' } } }],
    ['front', { document: { file_id: 'document-not-photo', thumbnail: { file_id: 'thumb' } } }],
    ['head', { chat: { id: 7 }, photo: [{ file_id: 'wrong-target', width: 800, height: 800 }] }],
  ]) {
    const recipe = { ...plan, kind };
    uploadHook = async () => ({ chat: { id: cacheChatId }, ...response });
    await assert.rejects(getMedia(recipe, options), /Cache upload|Unexpected cache upload/);
    assert.equal(await readMedia(recipe), null);
  }
});


test('verified texture heights survive reload and expose legacy keys without merging modern models', async () => {
  const modernHash = 'b'.repeat(64);
  const unknownHash = 'c'.repeat(64);
  const legacyPlan = { ...plan, renderModel: 'classic' };
  const modernClassic = { ...plan, skinHash: modernHash, renderModel: 'classic' };
  const modernSlim = { ...plan, skinHash: modernHash, renderModel: 'slim' };
  await rememberTextureHeight(plan.skinHash, { width: 64, height: 32 });
  await rememberTextureHeight(modernHash, { width: 64, height: 64 });
  const legacy = await getMedia(legacyPlan, options);
  const classic = await getMedia(modernClassic, options);
  const slim = await getMedia(modernSlim, options);
  await getMedia({ ...plan, skinHash: unknownHash, renderModel: 'classic' }, options);
  const { readTextureHeight: readFreshHeight } = await import('../../tgcloud/lib/telegram/snapshots.js?height-restart');
  const uploadsBefore = uploads.length;
  const warmOptions = { cacheChatId, produce: () => { throw new Error('Warm geometry must not produce bytes.'); } };
  const legacyHeight = await readFreshHeight(plan.skinHash);
  assert.equal(legacyHeight, 32);
  assert.deepEqual(await getMedia({ ...plan, renderModel: legacyHeight === 32 ? 'classic' : plan.renderModel }, warmOptions), legacy);
  assert.equal(await readFreshHeight(modernHash), 64);
  assert.notEqual(classic.key, slim.key);
  assert.deepEqual(await getMedia(modernClassic, warmOptions), classic);
  assert.deepEqual(await getMedia(modernSlim, warmOptions), slim);
  assert.equal(await readFreshHeight(unknownHash), null);
  assert.equal(uploads.length, uploadsBefore);
});

test('texture height fills an existing snapshot once and conflicting concurrent facts cannot overwrite the winner', async () => {
  const token = encodeSnapshot({ model: 'unknown', skinHash: plan.skinHash, capeHash: null });
  const identifier = await rememberSnapshot(token);
  assert.equal(await readTextureHeight(plan.skinHash), null);
  assert.deepEqual(await Promise.all(Array.from({ length: 3 }, () => rememberTextureHeight(plan.skinHash, { width: 64, height: 32 }))), [32, 32, 32]);
  assert.equal(await readSnapshot(identifier), token);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 1);
  const racedHash = 'd'.repeat(64);
  const results = await Promise.allSettled([32, 64].map(height => rememberTextureHeight(racedHash, { width: 64, height })));
  const successful = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Conflicting texture height/);
  assert.equal(await readTextureHeight(racedHash), successful[0].value);
});

test('invalid or corrupt texture geometry fails closed and database failures propagate', async () => {
  await rememberTextureHeight(plan.skinHash, { width: 64, height: 32 });
  await assert.rejects(rememberTextureHeight(plan.skinHash, { width: 64, height: 64 }), /Conflicting texture height/);
  assert.equal(await readTextureHeight(plan.skinHash), 32);
  for (const geometry of [null, { width: 32, height: 32 }, { width: 64, height: 48 }, { width: 64, height: '32' }]) {
    await assert.rejects(rememberTextureHeight(plan.skinHash, geometry), TypeError);
  }
  await assert.rejects(rememberTextureHeight('A'.repeat(64), { width: 64, height: 32 }));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 1);
  const token = encodeSnapshot({ model: 'unknown', skinHash: plan.skinHash, capeHash: null });
  database.prepare('UPDATE snapshots SET skin_height = ? WHERE token = ?').run('broken', token);
  await assert.rejects(readTextureHeight(plan.skinHash), /Invalid persisted texture height/);
  await assert.rejects(rememberTextureHeight(plan.skinHash, { width: 64, height: 32 }), /Invalid persisted texture height/);
  assert.equal(database.prepare('SELECT skin_height FROM snapshots WHERE token = ?').get(token).skin_height, 'broken');
  const failure = new Error('Geometry database unavailable.');
  beforeWrite = () => { throw failure; };
  await assert.rejects(rememberTextureHeight('e'.repeat(64), { width: 64, height: 32 }), error => error === failure);
});
