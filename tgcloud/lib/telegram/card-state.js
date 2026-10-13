import { db } from 'sdk';
import { eq, sql } from 'sdk/db';
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

// An Inline message exposes no chat reference and its callback data is caller
// controlled, so the target is accepted lazily: only the card's own creator may
// create the binding, the first accepted callback pins the message to that card,
// and chat members may afterwards operate the pinned card.
async function acceptInlineTarget(inlineMessageId, card, clicker) {
  const bound = await db.select({ cardId: inlineBindings.cardId }).from(inlineBindings)
    .where(eq(inlineBindings.inlineMessageId, inlineMessageId)).get();
  if (bound) return bound.cardId === card.id;
  if (!Number.isSafeInteger(clicker?.id) || clicker.id <= 0 || card.inlineUserId !== clicker.id) return false;
  await db.run(sql`INSERT INTO inline_bindings (inline_message_id, card_id)
    SELECT ${inlineMessageId}, cards.id FROM cards JOIN snapshots ON snapshots.id = cards.snapshot_id
    WHERE ${cards.id} = ${card.id} AND ${cards.inlineUserId} = ${clicker.id}
    ON CONFLICT(inline_message_id) DO NOTHING`);
  const created = await db.select({ cardId: inlineBindings.cardId }).from(inlineBindings)
    .where(eq(inlineBindings.inlineMessageId, inlineMessageId)).get();
  return created?.cardId === card.id;
}

export async function cardForCallback(callback) {
  const action = parseAction(callback?.data);
  if (!action) return null;
  if (callback.inline_message_id !== undefined) {
    if (callback.message !== undefined || typeof callback.inline_message_id !== 'string'
      || !callback.inline_message_id) return null;
    const card = await readCard(action.id);
    if (!card || !await acceptInlineTarget(callback.inline_message_id, card, callback.from)) return null;
    return { card, view: action.view, target: { inline_message_id: callback.inline_message_id } };
  }
  const message = callback.message;
  if (!Number.isSafeInteger(message?.date) || message.date <= 0
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
    || !Number.isSafeInteger(message.chat?.id) || message.chat.id === 0
    || !Array.isArray(message.rich_message?.blocks)
    || !message.rich_message.blocks.some((block) => block?.type === 'buttons' && Array.isArray(block.buttons)
      && block.buttons.some((button) => button?.callback_data === callback.data))) return null;
  const card = await readCard(action.id);
  return card ? { card, view: action.view, target: { chat_id: message.chat.id, message_id: message.message_id } } : null;
}
