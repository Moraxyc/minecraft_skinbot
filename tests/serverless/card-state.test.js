import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, mock, test } from 'node:test';
import { encodeSnapshot } from '../../tgcloud/lib/minecraft/reference.js';
import { createDb, schemaDdl, sdkDb } from './fixtures/sdk-db.js';

let database;
let beforeWrite;

mock.module('sdk/db', { exports: sdkDb });
mock.module('sdk', {
  exports: {
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
const { createCard, readCard, cardAction, cardForCallback } =
  await import('../../tgcloud/lib/telegram/card-state.js');
const snapshot = { model: 'slim', skinHash: 'a'.repeat(64), capeHash: 'b'.repeat(64) };
const uuid = '069a79f444e94726a5befca90e38aaf5';

function profile(name = 'Notch') {
  return { name, uuid, snapshot: { ...snapshot } };
}

function ordinary(data, blocks = [{ type: 'buttons', buttons: [{ text: 'Head', callback_data: data }] }]) {
  return {
    data, from: { id: 18 },
    message: { message_id: 42, date: 1, chat: { id: -1001234567890 }, rich_message: { blocks } },
  };
}

function inline(card, target = 'inline-message-1', userId = 17, view = 'head') {
  return { data: cardAction(card.id, view), inline_message_id: target, from: { id: userId } };
}

beforeEach(() => {
  database?.close();
  database = new DatabaseSync(':memory:');
  for (const statement of schemaDdl(schema)) database.exec(statement);
  beforeWrite = () => undefined;
});
after(() => database.close());

test('cards retain fixed player identity and texture independently when players share a snapshot', async () => {
  const input = profile();
  const first = await createCard(input);
  const second = await createCard({ ...profile('OtherPlayer'), uuid: 'c'.repeat(32) });
  input.name = 'Changed';
  input.uuid = 'd'.repeat(32);
  input.snapshot.skinHash = 'e'.repeat(64);
  const restarted = await import('../../tgcloud/lib/telegram/card-state.js?restart-cards');
  assert.deepEqual(await restarted.readCard(first.id), first);
  assert.equal(first.profile.name, 'Notch');
  assert.equal(first.profile.uuid, uuid);
  assert.equal(first.token, encodeSnapshot(snapshot));
  assert.equal(second.profile.name, 'OtherPlayer');
  assert.equal(second.profile.uuid, 'c'.repeat(32));
  assert.equal(second.token, first.token);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 1);
  const shared = await createCard({ snapshot: { ...snapshot, model: 'unknown' } });
  assert.equal(shared.profile.model, 'unknown');
  assert.equal(shared.profile.name, null);
  assert.equal(shared.profile.uuid, null);
});

test('ordinary callbacks require the exact accessible Rich button and keep the saved snapshot for another clicker', async () => {
  const card = await createCard(profile());
  const other = await createCard({ ...profile('OtherPlayer'), snapshot: { ...snapshot, skinHash: 'c'.repeat(64) } });
  const data = cardAction(card.id, 'head');
  const callback = ordinary(data);
  const resolved = await cardForCallback(callback);
  assert.deepEqual(resolved, {
    card, view: 'head', target: { chat_id: -1001234567890, message_id: 42 },
  });
  for (const invalid of [
    '', 's:1:head', 'c:0:head', 'c:01:head', 'c:1:unknown', 'c:1:head\n', 'c:9999999999999999:head',
    cardAction(other.id, 'head'), cardAction(999, 'head'),
  ]) {
    assert.equal(await cardForCallback({ ...callback, data: invalid }), null);
  }
  assert.equal(await cardForCallback({ ...callback, message: { ...callback.message, date: 0 } }), null);
  assert.equal(await cardForCallback(ordinary(data, [])), null);
  assert.equal(await cardForCallback(ordinary(data, [
    null, { type: 'buttons', buttons: null }, { type: 'paragraph', buttons: [{ callback_data: data }] },
  ])), null);
  for (const view of ['skin', 'side', 'three-view', '3d']) {
    assert.equal((await cardForCallback(ordinary(cardAction(card.id, view)))).view, view);
  }
  assert.throws(() => cardAction(card.id, 'head\n'), TypeError);
});

test('only the card creator binds an Inline message, which then pins one card for every member', async () => {
  const card = await createCard(profile(), { inlineUserId: 17 });
  const other = await createCard({ ...profile('OtherPlayer'), snapshot: { ...snapshot, skinHash: 'c'.repeat(64) } }, { inlineUserId: 17 });
  const anonymousCard = await createCard(profile());
  const changes = database.prepare('SELECT total_changes() AS count').get().count;
  assert.equal(await cardForCallback(inline(card, 'inline-message-1', 18)), null);
  assert.equal(await cardForCallback(inline(anonymousCard, 'inline-message-1', 17)), null);
  assert.equal(await cardForCallback(inline(card, 'inline-message-1', 0)), null);
  assert.equal(await cardForCallback({ data: cardAction(999, 'head'), inline_message_id: 'inline-message-1', from: { id: 17 } }), null);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.deepEqual(await cardForCallback(inline(card)), {
    card, view: 'head', target: { inline_message_id: 'inline-message-1' },
  });
  assert.equal((await cardForCallback(inline(card))).card.id, card.id);
  assert.deepEqual(await cardForCallback(inline(card, 'inline-message-2', 17, 'skin')), {
    card, view: 'skin', target: { inline_message_id: 'inline-message-2' },
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM inline_bindings').get().count, 2);
  const restarted = await import('../../tgcloud/lib/telegram/card-state.js?restart-inline');
  assert.equal((await restarted.cardForCallback(inline(other, 'inline-message-1', 17))), null);
  assert.equal((await restarted.cardForCallback(inline(card, 'inline-message-1', 48))).card.id, card.id);
  assert.equal(await restarted.cardForCallback(inline(card, 'unknown-target', 18)), null);
  assert.equal(await restarted.cardForCallback({ ...inline(card), message: ordinary(cardAction(card.id, 'head')).message }), null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM inline_bindings').get().count, 2);
});

test('concurrent conflicting first callbacks cannot bind one Inline message to two cards', async () => {
  const first = await createCard(profile(), { inlineUserId: 17 });
  const second = await createCard({ ...profile('OtherPlayer'), snapshot: { ...snapshot, skinHash: 'c'.repeat(64) } }, { inlineUserId: 17 });
  const results = await Promise.all([cardForCallback(inline(first)), cardForCallback(inline(second))]);
  assert.equal(results.filter(Boolean).length, 1);
  const bound = results[0] ? first : second;
  const rejected = results[0] ? second : first;
  assert.equal((await cardForCallback(inline(bound, 'inline-message-1', 17, 'back'))).card.token, bound.token);
  assert.equal(await cardForCallback(inline(rejected, 'inline-message-1', 17, 'back')), null);
  assert.equal((await cardForCallback(inline(bound, 'inline-message-1', 17, 'back'))).card.id, bound.id);
});

test('storage failures and missing parents cannot publish orphan cards or inline bindings without foreign keys', async () => {
  const failure = new Error('Synthetic card persistence failure');
  beforeWrite = (sql) => {
    if (sql.startsWith('INSERT INTO cards')) throw failure;
  };
  await assert.rejects(createCard(profile()), (error) => error === failure);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 0);
  beforeWrite = (sql) => {
    if (sql.startsWith('INSERT INTO cards')) database.exec('DELETE FROM snapshots');
  };
  await assert.rejects(createCard(profile()));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 0);
  beforeWrite = () => undefined;
  const card = await createCard(profile(), { inlineUserId: 17 });
  beforeWrite = (sql) => {
    if (sql.startsWith('INSERT INTO inline_bindings')) database.exec('DELETE FROM cards');
  };
  assert.equal(await cardForCallback(inline(card)), null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM inline_bindings').get().count, 0);
  assert.equal(await readCard(card.id), null);
});
