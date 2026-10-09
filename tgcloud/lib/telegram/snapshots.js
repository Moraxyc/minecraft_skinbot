import { db } from 'sdk';
import { eq, sql } from 'sdk/db';
import { snapshots } from '../../schema.js';
import { encodeSnapshot } from '../minecraft/reference.js';

export async function rememberSnapshot(token) {
  const [row] = await db.insert(snapshots).values({ token })
    .onConflictDoUpdate({ target: snapshots.token, set: { token } })
    .returning({ id: snapshots.id });
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 999999999999999) {
    throw new Error('Snapshot identifier unavailable');
  }
  return row.id;
}

export async function readSnapshot(id) {
  const row = await db.select({ token: snapshots.token }).from(snapshots)
    .where(eq(snapshots.id, id)).get();
  return row?.token ?? null;
}


function textureHeight(row) {
  if (!row || row.skinHeight === null) return null;
  if (row.skinHeight !== 32 && row.skinHeight !== 64) throw new Error('Invalid persisted texture height.');
  return row.skinHeight;
}

export async function readTextureHeight(skinHash) {
  const token = encodeSnapshot({ model: 'unknown', skinHash, capeHash: null });
  const row = await db.select({ skinHeight: snapshots.skinHeight }).from(snapshots)
    .where(eq(snapshots.token, token)).get();
  return textureHeight(row);
}

export async function rememberTextureHeight(skinHash, geometry) {
  const token = encodeSnapshot({ model: 'unknown', skinHash, capeHash: null });
  if (geometry?.width !== 64 || (geometry.height !== 32 && geometry.height !== 64)) {
    throw new TypeError('Expected verified 64x32 or 64x64 source geometry.');
  }
  const [row] = await db.insert(snapshots).values({ token, skinHeight: geometry.height })
    .onConflictDoUpdate({ target: snapshots.token, set: {
      skinHeight: sql`coalesce(${snapshots.skinHeight}, ${geometry.height})`,
    } })
    .returning({ skinHeight: snapshots.skinHeight });
  const height = textureHeight(row);
  if (height !== geometry.height) throw new Error('Conflicting texture height.');
  return height;
}
