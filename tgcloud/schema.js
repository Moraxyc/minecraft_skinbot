import { table, integer, text, index } from "sdk/db";

export const snapshots = table("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  skinHeight: integer('skin_height'),
});

export const mediaCache = table("media_cache", {
  key: text("key").primaryKey(),
  type: text("type").notNull(),
  fileId: text("file_id"),
  generation: integer("generation").notNull(),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }).notNull(),
});

export const cacheTarget = table("cache_target", {
  key: text("key").primaryKey(),
  retryAt: integer("retry_at", { mode: "timestamp_ms" }).notNull(),
});

export const cards = table("cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: integer("snapshot_id").notNull(),
  name: text("name"),
  uuid: text("uuid"),
  inlineUserId: integer("inline_user_id"),
}, (table) => ({
  snapshotIdx: index("idx_cards_snapshot").on(table.snapshotId),
}));

export const inlineBindings = table("inline_bindings", {
  inlineMessageId: text("inline_message_id").primaryKey(),
  cardId: integer("card_id").notNull(),
}, (table) => ({
  cardIdx: index("idx_inline_bindings_card").on(table.cardId),
}));
