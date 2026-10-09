import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import { cards, inlineBindings, snapshots } from '../../schema.js';
import { decodeSnapshot, encodeSnapshot, isUsername, normalizeUUID } from '../minecraft/reference.js';
import { rememberSnapshot } from './snapshots.js';

function validCardId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 999999999999999;
}

function parseAction(data) {
  if (typeof data !== 'string') return null;
  const match = /^c:([1-9][0-9]{0,14}):(head|front|back|side|three-view|skin|3d)$/u.exec(data);
  return match && match[0] === data ? { id: Number(match[1]), view: match[2] } : null;
}

export function cardAction(id, view) {
  const data = `c:${id}:${view}`;
  if (!validCardId(id) || !parseAction(data)) throw new TypeError('Invalid card action.');
  return data;
}

export async function createCard(profile, { inlineUserId = null } = {}) {
  const token = encodeSnapshot(profile?.snapshot);
  const name = profile.name ?? null;
  const uuid = profile.uuid == null ? null : normalizeUUID(profile.uuid);
  if ((name !== null && !isUsername(name))
    || (inlineUserId !== null && (!Number.isSafeInteger(inlineUserId) || inlineUserId <= 0))) {
    throw new TypeError('Invalid card identity.');
  }
  const snapshotId = await rememberSnapshot(token);
  const result = await db.run(sql`INSERT INTO cards (snapshot_id, name, uuid, inline_user_id)
    SELECT id, ${name}, ${uuid}, ${inlineUserId} FROM snapshots
    WHERE ${snapshots.id} = ${snapshotId} AND ${snapshots.token} = ${token}
    RETURNING id`);
  const id = result.rows[0]?.id;
  if (!validCardId(id)) throw new Error('Card identifier unavailable.');
  const card = await readCard(id);
  if (!card) throw new Error('Card snapshot unavailable.');
  return card;
}

export async function readCard(id) {
  if (!validCardId(id)) return null;
  const row = await db.select({
    name: cards.name, uuid: cards.uuid, inlineUserId: cards.inlineUserId,
    token: sql`(SELECT ${snapshots.token} FROM snapshots WHERE ${snapshots.id} = ${cards.snapshotId})`,
  }).from(cards).where(eq(cards.id, id)).get();
  if (!row || row.token === null) return null;
  const snapshot = decodeSnapshot(row.token);
  return {
    id, token: row.token, inlineUserId: row.inlineUserId,
    profile: { name: row.name, uuid: row.uuid, model: snapshot.model, snapshot },
  };
}

// A `startapp=t-<token>` launch carries no card id, so reuse a card that already
// holds a player identity for this snapshot. Anonymous fixed-snapshot cards
// (name IS NULL) never match.
export async function readCardByToken(token) {
  decodeSnapshot(token);
  const row = await db.select({ id: cards.id }).from(cards).where(sql`
    ${cards.snapshotId} = (SELECT ${snapshots.id} FROM snapshots WHERE ${snapshots.token} = ${token})
      AND ${cards.name} IS NOT NULL
  `).get();
  return row ? readCard(row.id) : null;
}

export async function bindChosenInlineResult(chosen) {
  const action = parseAction(chosen?.result_id);
  if (!action || typeof chosen.inline_message_id !== 'string' || !chosen.inline_message_id
    || !Number.isSafeInteger(chosen.from?.id) || chosen.from.id <= 0) return false;
  const card = await readCard(action.id);
  if (!card || card.inlineUserId !== chosen.from.id) return false;
  await db.run(sql`INSERT INTO inline_bindings (inline_message_id, card_id)
    SELECT ${chosen.inline_message_id}, cards.id FROM cards JOIN snapshots ON snapshots.id = cards.snapshot_id
    WHERE ${cards.id} = ${card.id} AND ${cards.inlineUserId} = ${chosen.from.id}
    ON CONFLICT(inline_message_id) DO NOTHING`);
  const row = await db.select({ cardId: inlineBindings.cardId }).from(inlineBindings)
    .where(eq(inlineBindings.inlineMessageId, chosen.inline_message_id)).get();
  return row?.cardId === card.id;
}

export async function cardForCallback(callback) {
  const action = parseAction(callback?.data);
  if (!action) return null;
  let target;
  if (callback.inline_message_id !== undefined) {
    if (callback.message !== undefined || typeof callback.inline_message_id !== 'string'
      || !callback.inline_message_id) return null;
    const binding = await db.select({ cardId: inlineBindings.cardId }).from(inlineBindings)
      .where(and(eq(inlineBindings.inlineMessageId, callback.inline_message_id), eq(inlineBindings.cardId, action.id)))
      .get();
    if (!binding) return null;
    target = { inline_message_id: callback.inline_message_id };
  } else {
    const message = callback.message;
    if (!Number.isSafeInteger(message?.date) || message.date <= 0
      || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
      || !Number.isSafeInteger(message.chat?.id) || message.chat.id === 0
      || !Array.isArray(message.rich_message?.blocks)
      || !message.rich_message.blocks.some((block) => block?.type === 'buttons' && Array.isArray(block.buttons)
        && block.buttons.some((button) => button?.callback_data === callback.data))) return null;
    target = { chat_id: message.chat.id, message_id: message.message_id };
  }
  const card = await readCard(action.id);
  return card ? { card, view: action.view, target } : null;
}
