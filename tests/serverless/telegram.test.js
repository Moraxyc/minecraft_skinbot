import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, mock, test } from 'node:test';
import { PNG } from 'pngjs';
import { renderPreviewPng } from '../../tgcloud/lib/skin/preview-png.js';
import { encodeSnapshot } from '../../tgcloud/lib/minecraft/reference.js';
import { createDb, schemaDdl, sdkDb } from './fixtures/sdk-db.js';

class BotApiError extends Error {
  constructor(code, description, parameters = {}) {
    super(description);
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

class InputFile {
  constructor(bytes, filename, options) { Object.assign(this, { bytes, filename, ...options }); }
}

class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.parameters = parameters;
  }
}

let database;
const calls = [];
const requests = [];
const responses = new Map();
const failures = new Map();
let databaseFailure = null;
let fetchHook;
let identity;
const apiHooks = new Map();

mock.module('sdk/db', { exports: sdkDb });

const api = Object.fromEntries(['getMe', 'sendPhoto', 'sendDocument', 'sendMessage', 'sendRichMessage', 'answerInlineQuery', 'editMessageText', 'answerCallbackQuery', 'savePreparedInlineMessage']
  .map((method) => [method, async (params) => {
    calls.push({ method, params });
    if (failures.has(method)) throw failures.get(method);
    if (apiHooks.has(method)) return apiHooks.get(method)(params);
    if (method === 'getMe') return identity;
    if (method === 'savePreparedInlineMessage') return { id: 'prepared-1', expiration_date: 2000000000 };
    if (method === 'sendPhoto') return { chat: { id: params.chat_id }, photo: [{ file_id: `photo-${calls.length}`, width: 800, height: 800 }] };
    if (method === 'sendDocument') return { chat: { id: params.chat_id }, document: { file_id: `document-${calls.length}` } };
    return { message_id: 42, date: 1, chat: { id: params.chat_id, type: 'private' }, ...params };
  }]));

mock.module('sdk', {
  exports: {
    api,
    BotApiError, InputFile, EndpointError,
    db: createDb({
      async run(query, params) {
        if (databaseFailure) throw databaseFailure;
        await Promise.resolve();
        const statement = database.prepare(query);
        if (/\bRETURNING\b/iu.test(query)) {
          const rows = statement.all(params);
          return { rows, rowsAffected: rows.length, lastInsertRowid: 0 };
        }
        const result = statement.run(params);
        return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid), rows: [] };
      },
      async get(query, params) {
        if (databaseFailure) throw databaseFailure;
        await Promise.resolve();
        return database.prepare(query).get(params) ?? null;
      },
    }),
    async fetch(url) {
      requests.push(url);
      if (fetchHook) await fetchHook(url);
      const response = responses.get(url);
      if (!response) throw new Error('Unexpected Minecraft request');
      if (response.bytes) return { ...response, body: (async function* () { yield response.bytes; })() };
      return response;
    },
  },
});

const { default: message } = await import('../../tgcloud/handlers/message.js');
const { default: channelPost } = await import('../../tgcloud/handlers/channel_post.js');
const { default: inlineQuery } = await import('../../tgcloud/handlers/inline_query.js');
const { default: callbackQuery } = await import('../../tgcloud/handlers/callback_query.js');
const { default: chosenInlineResult } = await import('../../tgcloud/handlers/chosen_inline_result.js');
const { default: lookupSkin } = await import('../../tgcloud/endpoints/lookupSkin.js');
const { default: getCard } = await import('../../tgcloud/endpoints/getCard.js');
const { default: prepareShare } = await import('../../tgcloud/endpoints/prepareShare.js');
const { settings } = await import('../../tgcloud/lib/settings.js');
const { addressedQuery } = await import('../../tgcloud/lib/telegram/input.js');
const schema = await import('../../tgcloud/schema.js');
const { snapshots } = schema;

const uuid = '069a79f444e94726a5befca90e38aaf5';
const skinHash = 'a'.repeat(64);
const capeHash = 'b'.repeat(64);
const token = `s-${skinHash}-${capeHash}`;
const viewerBase = 'https://app123456.tgcloud.ai/';
const cacheChatId = -1001234567890;
const pixels = Buffer.alloc(64 * 64 * 4);
for (let index = 0; index < pixels.length; index += 4) {
  pixels.set([index % 251, Math.floor(index / 64) % 251, 120, 255], index);
}
const originalBytes = PNG.sync.write({ width: 64, height: 64, data: pixels });

function serveTexture(hash = skinHash, bytes = originalBytes) {
  const url = `https://textures.minecraft.net/texture/${hash}`;
  responses.set(url, { url, status: 200, bytes,
    headers: { get: (name) => ({ 'content-type': 'image/png', 'content-length': String(bytes.length) })[name] ?? null } });
}

function effects() { return calls.filter((call) => call.method !== 'getMe'); }
function mediaCalls() { return calls.filter((call) => ['sendPhoto', 'sendDocument'].includes(call.method)); }
function richButtons(rich) {
  return rich.blocks.filter((block) => block.type === 'buttons').flatMap((block) => block.buttons);
}
function cardAction(original, view) {
  const rich = original.rich_message ?? original.input_message_content?.rich_message;
  return richButtons(rich).find((button) => button.callback_data?.endsWith(`:${view}`)).callback_data;
}

function serve(url, data, status = 200) {
  responses.set(url, {
    url,
    status,
    headers: { get: () => null },
    async json() { return data; },
  });
}

function servePlayer(snapshot = { model: 'slim', skinHash, capeHash }) {
  serve('https://api.mojang.com/users/profiles/minecraft/Notch', { id: uuid, name: 'Notch' });
  const textures = snapshot ? {
    SKIN: { url: `http://textures.minecraft.net/texture/${snapshot.skinHash}`, metadata: { model: snapshot.model } },
    ...(snapshot.capeHash ? { CAPE: { url: `http://textures.minecraft.net/texture/${snapshot.capeHash}` } } : {}),
  } : {};
  serve(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, {
    id: uuid,
    name: 'Notch',
    properties: [{
      name: 'textures',
      value: Buffer.from(JSON.stringify({ profileId: uuid, textures })).toString('base64'),
    }],
  });
}

function incoming(text, language = 'en', type = 'private') {
  return { message_id: 10, date: 1, chat: { id: 7, type }, from: { id: 17, language_code: language }, text };
}

function query(text, language = 'en', offset = '') {
  return { id: `inline-${language}`, query: text, from: { id: 17, language_code: language }, offset };
}

function callback(data, original, language = 'en') {
  return {
    id: 'callback-1', data, from: { id: 18, language_code: language },
    ...(original ? { message: original } : { inline_message_id: 'inline-message-1' }),
  };
}

function sentMessage() {
  const params = calls.findLast((call) => call.method === 'sendRichMessage').params;
  return { ...params, message_id: 42, date: 1, chat: { id: 7, type: 'private' } };
}

function openLink(rich) {
  const button = richButtons(rich).find((item) =>
    item.web_app?.url?.startsWith(viewerBase) || item.url?.startsWith(viewerBase));
  return button.web_app?.url ?? button.url;
}

beforeEach(() => {
  database?.close();
  database = new DatabaseSync(':memory:');
  for (const statement of schemaDdl(schema)) database.exec(statement);
  databaseFailure = null;
  calls.length = 0;
  requests.length = 0;
  responses.clear();
  failures.clear();
  fetchHook = null;
  apiHooks.clear();
  identity = { id: 42, is_bot: true, username: 'minecraft_skin_bot' };
  settings.cacheChatId = cacheChatId;
  settings.viewerBaseUrl = viewerBase;
  servePlayer();
  serveTexture();
  serveTexture('e'.repeat(64));
});

after(() => database?.close());

test('endpoints require a verified caller before lookup or media effects', async () => {
  for (const endpoint of [lookupSkin, getCard, prepareShare]) {
    await assert.rejects(endpoint({ reference: 'Notch', token, view: 'skin', userId: 17 }, {}),
      (error) => error instanceof EndpointError && error.parameters.code === 'UNAUTHORIZED');
  }
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 0);
});

test('Mini App sharing preserves the looked-up snapshot and binds to the verified user', async () => {
  const ctx = { initData: { user: { id: 17, language_code: 'en' } } };
  const state = await lookupSkin({ reference: 'Notch' }, ctx);
  assert.equal(state.botUsername, identity.username);
  assert.equal(state.card.name, 'Notch');
  assert.equal(state.card.uuid, uuid);
  assert.equal(state.card.token, token);
  servePlayer({ model: 'classic', skinHash: 'e'.repeat(64), capeHash: null });
  requests.length = 0;
  assert.deepEqual(await getCard({ cardId: state.card.id, token }, ctx), state);
  assert.equal(requests.length, 0);
  await assert.rejects(getCard({ cardId: state.card.id, token: `c-${skinHash}` }, ctx),
    (error) => error instanceof EndpointError && error.parameters.code === 'INVALID_REFERENCE');
  const result = await prepareShare({ cardId: state.card.id, view: 'skin', userId: 999 }, ctx);
  assert.deepEqual(result, { id: 'prepared-1', expirationDate: 2000000000 });
  const saved = calls.findLast((call) => call.method === 'savePreparedInlineMessage').params;
  assert.equal(saved.user_id, 17);
  assert.equal(saved.result.type, 'document');
  assert.equal(saved.result.input_message_content.rich_message.blocks[0].text, 'Notch');
  const sharedCardId = Number(saved.result.id.split(':')[1]);
  assert.equal(database.prepare('SELECT inline_user_id FROM cards WHERE id = ?').get(sharedCardId).inline_user_id, 17);
  assert.deepEqual(Buffer.from(mediaCalls().at(-1).params.document.bytes), originalBytes);
  await chosenInlineResult({ result_id: saved.result.id, inline_message_id: 'prepared-inline', from: { id: 17 } });
  assert.equal(database.prepare('SELECT card_id FROM inline_bindings WHERE inline_message_id = ?').get('prepared-inline').card_id, sharedCardId);
});

test('getCard reads an startapp reference from the verified start parameter', async () => {
  const ctx = { initData: { user: { id: 17, language_code: 'en' } } };
  const state = await lookupSkin({ reference: 'Notch' }, ctx);
  const launched = (start_param) => getCard({}, { initData: { ...ctx.initData, start_param } });
  requests.length = 0;
  assert.deepEqual(await launched(`c-${state.card.id}`), state);
  const reused = await launched(`t-${token}`);
  assert.equal(reused.botUsername, identity.username);
  assert.equal(reused.card.token, token);
  assert.equal(reused.card.name, 'Notch');
  assert.equal(requests.length, 0);
  for (const start_param of ['', 'open', 'c-0', null]) {
    assert.deepEqual(await launched(start_param), { botUsername: identity.username, card: null });
  }
  await assert.rejects(launched('t-nope'),
    (error) => error instanceof EndpointError && error.parameters.code === 'INVALID_REFERENCE');
});

test('warm cached media performs no HTTP or upload and Original preserves the unchanged PNG bytes', async () => {
  await message(incoming('Notch'));
  const original = sentMessage();
  const firstMedia = original.rich_message.blocks.find((block) => block.type === 'photo').photo.media;
  calls.length = 0; requests.length = 0;
  fetchHook = () => { throw new Error('Cached preview must not fetch'); };
  await message(incoming(`texture:${token}`));
  assert.equal(sentMessage().rich_message.blocks.find((block) => block.type === 'photo').photo.media, firstMedia);
  assert.equal(requests.length, 0);
  assert.equal(mediaCalls().length, 0);
  fetchHook = null;
  await callbackQuery(callback(cardAction(original, 'skin'), original));
  const document = mediaCalls().find((call) => call.method === 'sendDocument').params.document;
  assert.ok(document instanceof InputFile);
  assert.deepEqual(document.bytes, new Uint8Array(originalBytes));
  const edited = calls.findLast((call) => call.method === 'editMessageText').params;
  assert.equal(edited.message_id, original.message_id);
  assert.equal(edited.rich_message.blocks.find((block) => block.type === 'document').document.media,
    `document-${calls.findIndex((call) => call.method === 'sendDocument') + 1}`);
  calls.length = 0; requests.length = 0;
  await callbackQuery(callback(cardAction(original, 'skin'), original));
  assert.equal(requests.length + mediaCalls().length, 0);
});

test('cold Inline and callback acknowledge before byte production and await completion', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  fetchHook = async () => { started.resolve(); await release.promise; };
  let settled = false;
  const pending = inlineQuery(query(`texture:${token}`)).finally(() => { settled = true; });
  await started.promise;
  try {
    assert.equal(calls.filter((call) => call.method === 'answerInlineQuery').length, 1,
      'Exactly one Inline answer must precede the deferred producer release');
    assert.match(calls.find((call) => call.method === 'answerInlineQuery').params.results[0].description, /Preparing/);
    assert.equal(settled, false);
  } finally {
    release.resolve(); await pending;
  }
  assert.equal(calls.filter((call) => call.method === 'answerInlineQuery').length, 1,
    'Awaited producer completion must not send a second Inline answer');
  fetchHook = null;
  await message(incoming(`texture:${token}`));
  const original = sentMessage();
  const callbackStarted = Promise.withResolvers();
  const callbackRelease = Promise.withResolvers();
  fetchHook = async () => { callbackStarted.resolve(); await callbackRelease.promise; };
  calls.length = 0;
  const edit = callbackQuery(callback(cardAction(original, 'back'), original));
  await callbackStarted.promise;
  try {
    assert.equal(calls[0].method, 'answerCallbackQuery');
    assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 0);
  } finally {
    callbackRelease.resolve(); await edit;
  }
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 1);
});

test('native chosen binding permits other group members but rejects missing, unknown and wrong-sender targets', async () => {
  await inlineQuery(query(`texture:${token}`));
  await inlineQuery(query(`texture:${token}`));
  const result = calls.findLast((call) => call.method === 'answerInlineQuery').params.results[0];
  const data = cardAction(result, 'head');
  calls.length = 0;
  await callbackQuery(callback(data));
  assert.equal(calls.length, 1);
  await chosenInlineResult({ result_id: result.id, from: { id: 18 }, inline_message_id: 'inline-message-1' });
  await callbackQuery(callback(data));
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 0);
  await chosenInlineResult({ result_id: result.id, from: { id: 17 } });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM inline_bindings').get().count, 0);
  await chosenInlineResult({ result_id: result.id, from: { id: 17 }, inline_message_id: 'inline-message-1' });
  calls.length = 0; requests.length = 0;
  await callbackQuery(callback(data));
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 1,
    'Chosen native binding must authorize one frozen Rich edit for another group member');
  const edited = calls.find((call) => call.method === 'editMessageText').params;
  assert.equal(edited.inline_message_id, 'inline-message-1');
  assert.equal(edited.chat_id, undefined);
  assert.equal(requests.length + mediaCalls().length, 0);
  await callbackQuery({ ...callback(data), inline_message_id: 'unbound-target' });
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 1);
});

test('partial Inline returns cached choices before waiting for missing producers', async () => {
  await message(incoming(`texture:${token}`));
  calls.length = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  fetchHook = async () => { started.resolve(); await release.promise; };
  const pending = inlineQuery(query(`texture:${token}`));
  await started.promise;
  try {
    const answer = calls.find((call) => call.method === 'answerInlineQuery').params;
    assert.equal(answer.results.length, 1);
    assert.equal(answer.results[0].type, 'photo');
    assert.equal(answer.results[0].photo_file_id,
      answer.results[0].input_message_content.rich_message.blocks.find((block) => block.type === 'photo').photo.media);
    assert.equal(mediaCalls().length, 0);
  } finally {
    release.resolve(); await pending;
  }
  assert.equal(mediaCalls().length, 3);
});

test('legacy skin dimensions force classic preview pixels and canonical media keys', async () => {
  const legacy = PNG.sync.write({ width: 64, height: 32, data: pixels.subarray(0, 64 * 32 * 4) });
  const geometryToken = encodeSnapshot({ model: 'unknown', skinHash, capeHash: null });
  apiHooks.set('sendPhoto', (params) => {
    assert.equal(database.prepare('SELECT skin_height FROM snapshots WHERE token = ?').get(geometryToken)?.skin_height,
      32, 'Validated source height must be durable before preview upload');
    return { chat: { id: params.chat_id }, photo: [{ file_id: `photo-${calls.length}`, width: 800, height: 800 }] };
  });
  serveTexture(skinHash, legacy);
  await message(incoming(`texture:${token}`));
  assert.deepEqual(mediaCalls()[0].params.photo.bytes, renderPreviewPng(legacy, 'classic', 'front'));
  assert.match(database.prepare('SELECT key FROM media_cache WHERE file_id IS NOT NULL').get().key, /:classic:/);
  const firstPhoto = sentMessage().rich_message.blocks.find((block) => block.type === 'photo').photo.media;
  calls.length = 0; requests.length = 0;
  await message(incoming(`texture:${token}`));
  assert.equal(sentMessage().rich_message.blocks.find((block) => block.type === 'photo').photo.media, firstPhoto);
  assert.equal(requests.length + mediaCalls().length, 0, 'A fresh legacy cache hit must not fetch or upload');
  assert.ok(sentMessage().rich_message.blocks.some((block) => block.text === 'Model: Slim'));
  await inlineQuery(query(`texture:${token}`));
  calls.length = 0; requests.length = 0;
  await inlineQuery(query(`texture:${token}`));
  const answer = calls.find((call) => call.method === 'answerInlineQuery').params;
  assert.equal(answer.results.length, 4, 'Warmed legacy Inline must include every native media choice');
  assert.deepEqual(answer.results.map((result) => result.title), ['Front', 'Three-view', 'Head', 'Original skin']);
  assert.equal(requests.length + mediaCalls().length, 0, 'Warmed legacy Inline must not fetch or upload');
});

test('modern models remain separate and unknown source height never borrows classic body media', async () => {
  let uploadId = 0;
  apiHooks.set('sendPhoto', (params) => ({ chat: { id: params.chat_id },
    photo: [{ file_id: `photo-model-${++uploadId}`, width: 800, height: 800 }] }));
  const classic = encodeSnapshot({ model: 'classic', skinHash, capeHash: null });
  const slim = encodeSnapshot({ model: 'slim', skinHash, capeHash: null });
  const geometryToken = encodeSnapshot({ model: 'unknown', skinHash, capeHash: null });
  await inlineQuery(query(`texture:${classic}`));
  const classicFront = mediaCalls()[0].params.photo.bytes;
  await inlineQuery(query(`texture:${classic}`));
  const classicId = calls.findLast((call) => call.method === 'answerInlineQuery').params.results[0].photo_file_id;
  assert.equal(database.prepare('SELECT skin_height FROM snapshots WHERE token = ?').get(geometryToken).skin_height, 64);
  database.prepare('UPDATE snapshots SET skin_height = NULL WHERE token = ?').run(geometryToken);
  calls.length = 0; requests.length = 0;
  await inlineQuery(query(`texture:${slim}`));
  const partial = calls.find((call) => call.method === 'answerInlineQuery').params;
  assert.deepEqual(partial.results.map((result) => result.title), ['Head', 'Original skin'],
    'Unknown height must not guess a classic body cache hit for a slim snapshot');
  assert.equal(requests.length, 1);
  assert.equal(mediaCalls().length, 2);
  assert.deepEqual(mediaCalls()[0].params.photo.bytes, renderPreviewPng(originalBytes, 'slim', 'front'));
  assert.notDeepEqual(mediaCalls()[0].params.photo.bytes, classicFront);
  calls.length = 0; requests.length = 0;
  await inlineQuery(query(`texture:${slim}`));
  const warmed = calls.find((call) => call.method === 'answerInlineQuery').params;
  assert.equal(warmed.results.length, 4);
  assert.notEqual(warmed.results[0].photo_file_id, classicId);
  await inlineQuery(query(`texture:${classic}`));
  assert.equal(calls.findLast((call) => call.method === 'answerInlineQuery').params.results[0].photo_file_id, classicId);
  assert.equal(requests.length + mediaCalls().length, 0);
});

test('geometry persistence failures block publication and propagate without a PNG fallback', async () => {
  const failure = new Error('Synthetic geometry database failure');
  fetchHook = () => { databaseFailure = failure; };
  await assert.rejects(message(incoming(`texture:${token}`)), (error) => error === failure);
  assert.equal(mediaCalls().length, 0);
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0);
  fetchHook = null; databaseFailure = null;
  const geometryToken = encodeSnapshot({ model: 'unknown', skinHash, capeHash: null });
  database.prepare('INSERT INTO snapshots (token, skin_height) VALUES (?, 32)').run(geometryToken);
  await assert.rejects(message(incoming(`head texture:${token}`)), /Conflicting texture height/);
  assert.equal(mediaCalls().length, 0);
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0);
  database.prepare('UPDATE snapshots SET skin_height = 16 WHERE token = ?').run(geometryToken);
  requests.length = 0;
  await assert.rejects(message(incoming(`texture:${token}`)), /Invalid persisted texture height/);
  assert.equal(requests.length + mediaCalls().length, 0);
});

test('single-file invalid references repair once; mixed Inline failure never clears unrelated files', async () => {
  await message(incoming(`texture:${token}`));
  const previous = sentMessage().rich_message.blocks.find((block) => block.type === 'photo').photo.media;
  calls.length = 0;
  let attempts = 0;
  apiHooks.set('sendRichMessage', () => {
    attempts += 1;
    if (attempts === 1) throw new BotApiError(400, 'Bad Request: file reference expired');
    return true;
  });
  await message(incoming(`texture:${token}`));
  assert.equal(attempts, 2);
  assert.equal(mediaCalls().length, 1);
  assert.notEqual(sentMessage().rich_message.blocks.find((block) => block.type === 'photo').photo.media, previous);
  apiHooks.clear();
  await inlineQuery(query(`texture:${token}`));
  const before = database.prepare('SELECT key, file_id, generation FROM media_cache ORDER BY key').all();
  failures.set('answerInlineQuery', new BotApiError(400, 'Bad Request: wrong file identifier'));
  calls.length = 0;
  await assert.rejects(inlineQuery(query(`texture:${token}`)), /wrong file identifier/);
  assert.equal(calls.filter((call) => call.method === 'answerInlineQuery').length, 1);
  assert.equal(mediaCalls().length, 0);
  assert.deepEqual(database.prepare('SELECT key, file_id, generation FROM media_cache ORDER BY key').all(), before);
  failures.clear(); failures.set('sendRichMessage', new BotApiError(400, 'Bad Request: file reference expired'));
  calls.length = 0;
  await assert.rejects(message(incoming(`texture:${token}`)), /file reference expired/);
  assert.equal(calls.filter((call) => call.method === 'sendRichMessage').length, 2);
  assert.equal(mediaCalls().length, 1);
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0);
});

test('getMe returns a validated User, changes media bot scope and leaves hosting configuration untouched', async () => {
  identity = { id: 42, is_bot: true, username: 'actual_runtime_bot' };
  await message(incoming('/help'));
  assert.match(calls.at(-1).params.text, /@actual_runtime_bot Notch/);
  assert.equal(settings.viewerBaseUrl, viewerBase);
  identity = { id: 42, is_bot: true };
  await message(incoming('/help'));
  assert.doesNotMatch(calls.at(-1).params.text, /@/);
  identity = { result: { id: 42, is_bot: true } };
  await assert.rejects(message(incoming('/help')), /Invalid Bot API identity/);
  for (const id of [42, 43]) {
    identity = { id, is_bot: true };
    await message(incoming(`texture:${token}`));
    assert.ok(database.prepare('SELECT key FROM media_cache WHERE key LIKE ? AND file_id IS NOT NULL').get(`${id}:%`));
  }
  failures.set('getMe', new BotApiError(429, 'Too Many Requests'));
  calls.length = 0;
  await message(incoming('/help'));
  assert.equal(calls.length, 1);
});

test('unsupported transport, invalid PNG, permissions, configuration and 429 do not upload false previews', async () => {
  const url = `https://textures.minecraft.net/texture/${skinHash}`;
  responses.set(url, { url, status: 200, headers: { get: (name) => name === 'content-type' ? 'image/png' : null },
    body: (async function* () { yield 'PNG as text'; })() });
  await message(incoming(`head texture:${token}`));
  assert.match(calls.at(-1).params.text, /cannot read PNG bytes/);
  assert.equal(mediaCalls().length, 0);
  serveTexture(skinHash, new Uint8Array([137, 80, 78, 71]));
  await message(incoming(`texture:${token}`));
  assert.match(calls.at(-1).params.text, /not a supported/);
  assert.equal(mediaCalls().length, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE skin_height IS NOT NULL').get().count, 0);
  serveTexture();
  failures.set('sendPhoto', new BotApiError(403, 'Forbidden'));
  await message(incoming(`head texture:${token}`));
  assert.match(calls.at(-1).params.text, /permissions/);
  failures.set('sendPhoto', new BotApiError(429, 'Too Many Requests', { retry_after: 60 }));
  await message(incoming(`head texture:${token}`));
  assert.match(calls.at(-1).params.text, /busy/);
  failures.clear(); calls.length = 0; requests.length = 0;
  await message(incoming(`head texture:${token}`));
  assert.equal(mediaCalls().length + requests.length, 0);
  database.prepare('DELETE FROM cache_target').run();
  database.prepare('UPDATE media_cache SET lease_until = ? WHERE file_id IS NULL').run(Date.now() + 60000);
  calls.length = 0; requests.length = 0;
  await message(incoming(`head texture:${token}`));
  assert.equal(mediaCalls().length + requests.length, 0);
  assert.match(calls.at(-1).params.text, /busy/);
  settings.cacheChatId = null;
  await message(incoming('Notch'));
  assert.match(calls.at(-1).params.text, /cache group or channel/);
});

test('declared schema rejects invalid snapshots and deleted callback IDs never point at another skin', async () => {
  await message(incoming(`texture:${token}`));
  const original = sentMessage();
  const firstId = database.prepare('SELECT id FROM snapshots WHERE token = ?').get(token).id;
  assert.throws(() => database.prepare('INSERT INTO snapshots (token) VALUES (?)').run(null), /NOT NULL/);
  assert.throws(() => database.prepare('INSERT INTO snapshots (token) VALUES (?)').run(token), /UNIQUE/);
  database.prepare('DELETE FROM snapshots WHERE id = ?').run(firstId);
  const otherToken = encodeSnapshot({ model: 'classic', skinHash: 'e'.repeat(64), capeHash: null });
  await message(incoming(`texture:${otherToken}`));
  const secondId = database.prepare('SELECT id FROM snapshots WHERE token = ?').get(otherToken).id;
  assert.ok(secondId > firstId);
  calls.length = 0;
  await callbackQuery(callback(cardAction(original, 'head'), original));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.equal(calls[0].params.show_alert, true);
});

test('private commands resolve official snapshots, localize each update and keep topic replies', async () => {
  await message(incoming('/help', 'zh-CN'), { update: { update_id: 1 } });
  assert.match(effects()[0].params.text, /发送 <code>Notch<\/code>/);
  assert.match(effects()[0].params.text, /@minecraft_skin_bot Notch/);
  const request = { ...incoming('/head Notch', 'zh-Hans'), message_thread_id: 23 };
  await message(request);
  assert.equal(calls.at(-1).method, 'sendRichMessage');
  const response = calls.at(-1).params;
  assert.equal(response.message_thread_id, 23);
  assert.equal(response.text, undefined);
  assert.equal(response.parse_mode, undefined);
  assert.equal(response.reply_markup, undefined);
  const rich = response.rich_message;
  assert.equal(rich.html, undefined);
  assert.equal(rich.markdown, undefined);
  assert.equal(rich.skip_entity_detection, true);
  assert.equal(rich.blocks.find((block) => block.type === 'heading').text, 'Notch');
  assert.ok(rich.blocks.some((block) => block.type === 'paragraph' && block.text === '模型: 纤细'));
  assert.ok(rich.blocks.some((block) => block.type === 'paragraph'
    && block.text[0] === 'UUID: ' && block.text[1].type === 'code' && block.text[1].text === uuid));
  assert.ok(richButtons(rich).every((button) => !button.copy_text));
  assert.deepEqual(richButtons(rich).find((button) => button.web_app), {
    text: '打开 3D', web_app: { url: openLink(rich) },
  });
  const photo = rich.blocks.find((block) => block.type === 'photo');
  assert.ok(photo, 'ordinary Rich cards must include a generated cached preview');
  assert.equal(photo.photo.media, `photo-${calls.findIndex((call) => call.method === 'sendPhoto') + 1}`);
  assert.deepEqual(mediaCalls()[0].params.photo.bytes, renderPreviewPng(originalBytes, 'slim', 'head'));
  assert.equal(photo.caption.text, '头像');
  const url = new URL(openLink(rich));
  assert.equal(url.searchParams.get('texture'), token);
  assert.equal(url.searchParams.get('lang'), 'zh-Hans');
  assert.equal(url.searchParams.get('view'), '3d');
  assert.ok(richButtons(rich).every((button) => !button.url));
  assert.equal(database.prepare('SELECT token FROM snapshots').get().token, token);
  for (const button of richButtons(rich)) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  await message(incoming('/start', 'zh-Hant'));
  assert.match(calls.at(-1).params.text, /Send <code>Notch<\/code>/);
});

test('groups and channels require explicit addressing and preserve UTF-16 mention offsets', async () => {
  for (const type of ['group', 'supergroup', 'channel']) {
    await message(incoming('Notch', 'en', type));
    await message(incoming('/skin@another_bot Notch', 'en', type));
  }
  await message(incoming('/skin@another_bot Notch'));
  assert.equal(effects().length, 0);
  assert.equal(requests.length, 0);
  const text = '😀 @minecraft_skin_bot Notch';
  assert.equal(addressedQuery({ ...incoming(text, 'en', 'group'), entities: [
    { type: 'mention', offset: 3, length: 19 },
  ] }, identity.username), '😀   Notch');
  const mention = {
    type: 'text_mention', offset: 6, length: 2,
    user: { id: 123, is_bot: true, username: 'minecraft_skin_bot' },
  };
  const mentioned = { ...incoming('Notch 😀', 'en', 'group'), entities: [mention] };
  assert.equal(addressedQuery(mentioned, identity.username), 'Notch');
  assert.equal(addressedQuery({ ...mentioned, entities: [
    { ...mention, user: { ...mention.user, is_bot: false } },
  ] }, identity.username), null);
  await channelPost(incoming('/skin@MINECRAFT_SKIN_BOT Notch', 'en', 'channel'));
  assert.equal(calls.at(-1).method, 'sendRichMessage');
  assert.equal(calls.at(-1).params.rich_message.blocks.find((block) => block.type === 'heading').text, 'Notch');
  await message({ ...incoming('@minecraft_skin_bot Notch', 'en', 'supergroup'), entities: [
    { type: 'mention', offset: 0, length: 19 },
  ] });
  assert.equal(calls.filter((call) => call.method === 'sendRichMessage').length, 2);
});

test('invalid references and missing or rate-limited profiles return useful errors without saving snapshots', async () => {
  await message(incoming('upload:' + skinHash));
  assert.match(calls.at(-1).params.text, /Minecraft username/);
  assert.equal(requests.length, 0);
  serve('https://api.mojang.com/users/profiles/minecraft/Missing', {}, 404);
  await message(incoming('Missing'));
  assert.match(calls.at(-1).params.text, /No Minecraft profile/);
  await inlineQuery(query('Missing', 'zh-CN'));
  const failure = calls.at(-1).params;
  assert.equal(failure.is_personal, true);
  assert.equal(failure.cache_time, 0);
  assert.equal(failure.results.length, 1);
  assert.equal(failure.results[0].type, 'article');
  const content = failure.results[0].input_message_content;
  assert.deepEqual(Object.keys(content), ['rich_message']);
  assert.ok(content.rich_message.blocks.some((block) => block.type === 'paragraph' && /找不到对应/.test(block.text)));
  serve('https://api.mojang.com/users/profiles/minecraft/Busy', {}, 429);
  await message(incoming('Busy', 'zh'));
  assert.match(calls.at(-1).params.text, /服务繁忙/);
  assert.equal(requests.filter((url) => url.endsWith('/Busy')).length, 1);
  servePlayer(null);
  await message(incoming('Notch'));
  assert.match(calls.at(-1).params.text, /no usable skin/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 0);
});

test('concurrent inline languages return localized cached Rich media and persist sender-scoped cards', async () => {
  await inlineQuery(query(`texture:${token}`));
  calls.length = 0;
  requests.length = 0;
  await Promise.all([inlineQuery(query('view Notch')), inlineQuery(query('view Notch', 'zh-SG'))]);
  const answers = calls.filter((call) => call.method === 'answerInlineQuery').map((call) => call.params);
  assert.equal(answers.length, 2);
  assert.equal(answers.find((answer) => answer.inline_query_id === 'inline-en').results[0].title, 'Three-view');
  assert.equal(answers.find((answer) => answer.inline_query_id === 'inline-zh-SG').results[0].title, '三视图');
  for (const answer of answers) {
    assert.equal(answer.is_personal, true);
    assert.equal(answer.cache_time, 0);
    assert.equal(answer.results.length, 4);
    assert.deepEqual(answer.results.map((result) => result.type), ['photo', 'photo', 'photo', 'document']);
    assert.equal(new Set(answer.results.map((result) => result.id)).size, answer.results.length);
    assert.ok(answer.results.every((result) => Buffer.byteLength(result.id) <= 64));
    const locale = answer.inline_query_id === 'inline-en' ? 'en' : 'zh-Hans';
    for (const [index, result] of answer.results.entries()) {
      const rich = result.input_message_content.rich_message;
      const link = new URL(openLink(rich));
      assert.equal(link.searchParams.get('texture'), token);
      assert.equal(link.searchParams.get('view'), '3d');
      assert.equal(link.searchParams.get('lang'), locale);
      assert.deepEqual(Object.keys(result.input_message_content), ['rich_message']);
      assert.equal(result.reply_markup, undefined);
      assert.equal(rich.html, undefined);
      assert.equal(rich.markdown, undefined);
      assert.equal(rich.media, undefined);
      assert.equal(rich.skip_entity_detection, true);
      const allowedBlocks = new Set(['heading', 'paragraph', 'buttons', 'divider', 'footer', 'photo', 'document']);
      assert.ok(rich.blocks.every((block) => allowedBlocks.has(block.type)));
      const media = rich.blocks.find((block) => ['photo', 'document'].includes(block.type));
      assert.equal(media[media.type].media, result.photo_file_id ?? result.document_file_id);
      assert.equal(rich.blocks.find((block) => block.type === 'heading').text, 'Notch');
      assert.ok(rich.blocks.some((block) => block.type === 'paragraph'
        && block.text === (locale === 'en' ? 'Model: Slim' : '模型: 纤细')));
      const buttons = richButtons(rich);
      assert.ok(buttons.every((button) => !button.copy_text));
      for (const block of rich.blocks.filter((block) => block.type === 'buttons')) {
        assert.ok(block.buttons.length >= 1 && block.buttons.length <= 8);
      }
      for (const button of buttons) {
        assert.equal(typeof button.text, 'string');
        assert.equal(Object.keys(button).filter((key) => !['text', 'style'].includes(key)).length, 1);
        if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      }
      assert.deepEqual(buttons.filter((button) => button.url).map((button) => button.url), [
        `${viewerBase.replace(/\/$/, '')}/?texture=${encodeURIComponent(token)}&lang=${locale}&view=3d`,
      ]);
      assert.deepEqual(buttons.filter((button) => button.callback_data).map((button) => button.callback_data),
        ['front', 'back', 'head', 'three-view', 'skin'].map((view) => result.id.replace(/:[^:]+$/u, `:${view}`)));
      assert.deepEqual(buttons.filter((button) => button.text.startsWith('✓ ')).map((button) => button.text), [`✓ ${result.title}`]);
      assert.deepEqual(buttons.filter((button) => button.switch_inline_query).map((button) => button.switch_inline_query), [`texture:${token}`]);
    }
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE token = ?').get(token).count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM cards WHERE inline_user_id = 17').get().count, 2);
  assert.equal(requests.filter((url) => url.startsWith('https://textures.minecraft.net')).length, 0);
});

test('concurrent ordinary messages share one snapshot but use distinct card callback IDs', async () => {
  await Promise.all([message(incoming(`head texture:${token}`)), message(incoming(`view texture:${token}`, 'zh-SG'))]);
  const responses = calls.filter((call) => call.method === 'sendRichMessage').map((call) => call.params);
  assert.equal(responses.length, 2);
  const rows = database.prepare('SELECT id, token FROM snapshots WHERE token = ?').all(token);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, token);
  for (const response of responses) {
    assert.equal(new URL(openLink(response.rich_message)).searchParams.get('texture'), token);
    const buttons = richButtons(response.rich_message).filter((button) => button.callback_data);
    assert.ok(buttons.length > 0);
    assert.ok(buttons.every((button) => button.callback_data.startsWith('c:')));
  }
  assert.equal(new Set(responses.map((response) => cardAction(response, 'front'))).size, 2);
  assert.ok(requests.every((url) => url.startsWith('https://textures.minecraft.net')));
});

test('fixed Rich cards preserve classic and unknown models without inventing player identity or a cape', async () => {
  for (const [model, label] of [['classic', 'Classic'], ['unknown', 'Unknown']]) {
    const skinHash = 'e'.repeat(64);
    const fixed = encodeSnapshot({ model, skinHash, capeHash: null });
    await message(incoming(`texture:${fixed}`));
    assert.equal(calls.at(-1).method, 'sendRichMessage');
    const response = calls.at(-1).params;
    const rich = response.rich_message;
    assert.equal(rich.blocks.find((block) => block.type === 'heading').text, 'Shared Minecraft skin');
    assert.ok(rich.blocks.some((block) => block.type === 'paragraph' && block.text === `Model: ${label}`));
    assert.ok(rich.blocks.every((block) => !String(block.text).startsWith('UUID:')));
    assert.ok(richButtons(rich).every((button) => !button.copy_text));
    assert.match(rich.blocks.find((block) => block.type === 'photo').photo.media, /^photo-/);
    assert.equal(rich.blocks.find((block) => block.type === 'photo').caption.text, 'Front');
    assert.ok(richButtons(rich).some((button) => button.web_app?.url === openLink(rich)));
    assert.ok(richButtons(rich).every((button) => !button.url));
    assert.equal(new URL(openLink(rich)).searchParams.get('texture'), fixed);
  }
  assert.equal(requests.length, 1);
});

test('shared cached snapshots work without Minecraft requests and empty or paginated queries do not resolve', async () => {
  await inlineQuery(query(`texture:${token}`));
  calls.length = 0;
  requests.length = 0;
  await inlineQuery(query(`head texture:${token}`));
  assert.equal(requests.length, 0);
  const answer = calls.at(-1).params;
  assert.equal(answer.cache_time, 0);
  assert.equal(answer.results[0].title, 'Head');
  const rich = answer.results[0].input_message_content.rich_message;
  assert.equal(rich.blocks.find((block) => block.type === 'heading').text, 'Shared Minecraft skin');
  assert.ok(richButtons(rich).every((button) => !button.copy_text));
  assert.match(rich.blocks.find((block) => block.type === 'photo').photo.media, /^photo-/);
  assert.equal(new URL(openLink(rich)).searchParams.get('view'), '3d');
  const buttons = richButtons(rich);
  assert.deepEqual(buttons.filter((button) => button.url).map((button) => button.url), [
    `${viewerBase.replace(/\/$/, '')}/?texture=${encodeURIComponent(token)}&lang=en&view=3d`,
  ]);
  for (const invalid of ['', 'Notch another', 'upload:' + skinHash]) {
    await inlineQuery(query(invalid));
    assert.deepEqual(calls.at(-1).params.results, []);
  }
  await inlineQuery(query('Notch', 'en', 'next'));
  assert.deepEqual(calls.at(-1).params.results, []);
  assert.equal(requests.length, 0);
});

test('callbacks keep the saved skin and cape after a profile changes in ordinary messages', async () => {
  await message(incoming('Notch'));
  const original = sentMessage();
  const data = cardAction(original, 'head');
  servePlayer({ model: 'classic', skinHash: 'd'.repeat(64), capeHash: null });
  const previousRequests = requests.length;
  await callbackQuery(callback(data, original, 'zh-CN'));
  const edited = calls.findLast((call) => call.method === 'editMessageText').params;
  assert.equal(edited.chat_id, 7);
  assert.equal(edited.message_id, 42);
  assert.equal(edited.inline_message_id, undefined);
  assert.equal(edited.reply_markup, undefined);
  const url = new URL(openLink(edited.rich_message));
  assert.equal(url.searchParams.get('texture'), token);
  assert.equal(url.searchParams.get('lang'), 'zh-Hans');
  assert.equal(url.searchParams.get('view'), '3d');
  assert.ok(richButtons(edited.rich_message).some((button) => button.text === '✓ 头像'));
  assert.ok(richButtons(edited.rich_message).every((button) => !button.copy_text));
  assert.ok(richButtons(edited.rich_message).some((button) => button.web_app?.url === openLink(edited.rich_message)));
  assert.equal(richButtons(edited.rich_message).find((button) => button.switch_inline_query).switch_inline_query, `texture:${token}`);
  assert.equal(requests.length, previousRequests + 1);
  assert.ok(requests.slice(previousRequests).every((url) => url.endsWith(skinHash)));
  assert.ok(edited.rich_message.blocks.some((block) => block.text === 'Notch'));
  assert.ok(edited.rich_message.blocks.some((block) => block.text === '模型: 纤细'));
  assert.equal(calls.find((call) => call.method === 'answerCallbackQuery').params.text, undefined);
});

test('inline callbacks cannot redirect an article to another saved snapshot', async () => {
  await message(incoming(`texture:${token}`));
  const otherToken = encodeSnapshot({ model: 'classic', skinHash: 'e'.repeat(64), capeHash: null });
  await message(incoming(`texture:${otherToken}`));
  const otherMessage = sentMessage();
  const forgedData = cardAction(otherMessage, 'head');
  await inlineQuery(query(`texture:${token}`));
  const article = calls.findLast((call) => call.method === 'answerInlineQuery').params.results[0];
  assert.equal(new URL(openLink(article.input_message_content.rich_message)).searchParams.get('texture'), token);
  const changesBefore = database.prepare('SELECT total_changes() AS count').get().count;
  calls.length = 0;
  await callbackQuery(callback(forgedData));
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 0);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.equal(calls[0].params.show_alert, true);
  assert.match(calls[0].params.text, /unavailable/);
});

test('malformed, missing and message-mismatched callback references are rejected without editing', async () => {
  await message(incoming('Notch'));
  const original = sentMessage();
  const secondToken = encodeSnapshot({ model: 'classic', skinHash: 'e'.repeat(64), capeHash: null });
  database.prepare('INSERT INTO snapshots (token) VALUES (?)').run(secondToken);
  calls.length = 0;
  for (const data of ['c:0:head', 'c:1e2:head', 'c:1:side', 'c:1:front\n', 'c:9999999999999999:head', 'c:999:head']) {
    await callbackQuery(callback(data, original));
    assert.equal(calls.at(-1).params.show_alert, true);
  }
  await callbackQuery(callback('c:2:head', original));
  assert.equal(calls.at(-1).params.show_alert, true);
  await callbackQuery(callback(cardAction(original, 'head'), { ...original, date: 0 }));
  assert.equal(calls.at(-1).params.show_alert, true);
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 0);
});

test('unchanged, flood and missing callback edits preserve the existing message without retries', async () => {
  await message(incoming('Notch'));
  const original = sentMessage();
  for (const error of [
    new BotApiError(400, 'Bad Request: message is not modified: specified markup is unchanged'),
    new BotApiError(429, 'Too Many Requests', { retry_after: 60 }),
    new BotApiError(400, 'Bad Request: message to edit not found'),
  ]) {
    calls.length = 0;
    failures.set('editMessageText', error);
    await callbackQuery(callback(cardAction(original, 'head'), original));
    assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 1);
    assert.equal(calls.filter((call) => call.method === 'answerCallbackQuery').length, 1);
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0);
  }
});

test('query expiration and flood answers are bounded, while unrelated Bot API errors propagate', async () => {
  await message(incoming(`texture:${token}`));
  const original = sentMessage();
  for (const error of [new BotApiError(429, 'Too Many Requests', { retry_after: 30 }),
    new BotApiError(400, 'Bad Request: query is too old and response timeout expired')]) {
    failures.set('answerInlineQuery', error);
    calls.length = 0;
    await inlineQuery(query(`texture:${token}`));
    assert.equal(calls.filter((call) => call.method === 'answerInlineQuery').length, 1);
    failures.set('answerCallbackQuery', error);
    calls.length = 0;
    await callbackQuery(callback('invalid'));
    assert.equal(calls.length, 1);
  }
  const unexpected = new BotApiError(400, "Bad Request: can't parse entities");
  failures.set('answerInlineQuery', unexpected);
  await assert.rejects(inlineQuery(query(`texture:${token}`)), (error) => error === unexpected);
  calls.length = 0;
  failures.set('answerCallbackQuery', unexpected);
  await assert.rejects(callbackQuery(callback('c:999:head')), (error) => error === unexpected);
  assert.equal(calls.length, 1);
  failures.delete('answerCallbackQuery');
  failures.set('editMessageText', unexpected);
  await assert.rejects(callbackQuery(callback(cardAction(original, 'head'), original)), (error) => error === unexpected);
  assert.equal(calls.findLast((call) => call.method === 'answerCallbackQuery').params.text, undefined);
});

test('snapshot persistence precedes sending and interrupted responses reuse the same row on retry', async () => {
  for (const failure of [
    new BotApiError(429, 'Too Many Requests', { retry_after: 10 }),
    new BotApiError(400, 'Bad Request: failed to get HTTP URL content'),
    new BotApiError(403, 'Forbidden: bot cannot send photos in the chat'),
    new BotApiError(500, 'Internal Server Error'),
    new Error('Synthetic network failure with unknown delivery status'),
  ]) {
    failures.set('sendRichMessage', failure);
    calls.length = 0;
    await assert.rejects(message(incoming('Notch')), (error) => error === failure);
    assert.equal(calls.filter((call) => call.method === 'sendRichMessage').length, 1, 'uncertain sends must not retry');
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0, 'uncertain sends must not fall back');
    assert.equal(database.prepare('SELECT id FROM snapshots WHERE token = ?').get(token).id, 1);
  }
  failures.delete('sendRichMessage');
  await message(incoming('Notch'));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE token = ?').get(token).count, 1);
  const original = sentMessage();
  assert.match(cardAction(original, 'front'), /^c:[1-9][0-9]*:front$/);
  calls.length = 0;
  databaseFailure = new Error('Synthetic database failure');
  await assert.rejects(message(incoming('Notch')), (error) => error === databaseFailure);
  assert.equal(effects().length, 0);
  await assert.rejects(callbackQuery(callback(cardAction(original, 'head'), original)), (error) => error === databaseFailure);
  assert.equal(calls.at(-1).method, 'answerCallbackQuery');
  assert.equal(calls.at(-1).params.show_alert, true);
});

test('UUID commands and start queries resolve without a username request and retain fixed snapshots', async () => {
  await message(incoming('/skin ' + uuid));
  assert.deepEqual(requests, [`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, `https://textures.minecraft.net/texture/${skinHash}`]);
  requests.length = 0;
  await message(incoming('/start ' + uuid));
  assert.deepEqual(requests, [`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`]);
  assert.equal(new URL(openLink(sentMessage().rich_message)).searchParams.get('texture'), token);
});

test('unconfigured hosting fails clearly without upstream or database effects', async () => {
  await message(incoming(`texture:${token}`));
  const original = sentMessage();
  const changesBefore = database.prepare('SELECT total_changes() AS count').get().count;
  calls.length = 0;
  settings.viewerBaseUrl = '';
  await message(incoming('Notch', 'zh'));
  assert.match(calls.at(-1).params.text, /尚未配置/);
  await inlineQuery(query('Notch'));
  assert.match(calls.at(-1).params.results[0].description, /has not been configured/);
  await callbackQuery(callback(cardAction(original, 'head'), original));
  assert.match(calls.at(-1).params.text, /has not been configured/);
  assert.equal(calls.at(-1).params.show_alert, true);
  assert.equal(requests.length, 1);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changesBefore);
});
