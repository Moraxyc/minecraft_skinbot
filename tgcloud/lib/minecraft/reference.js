import { MinecraftError } from "./errors.js";

const MODEL_CODES = { classic: "c", slim: "s", unknown: "u" };
const CODE_MODELS = { c: "classic", s: "slim", u: "unknown" };

function invalidReference() {
  return new MinecraftError("INVALID_REFERENCE", 400, "Invalid Minecraft reference.");
}

function validHash(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 64
    && !/[^0-9a-f]/u.test(value);
}

export function isUsername(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 16
    && !/[^A-Za-z0-9_]/u.test(value);
}

export function normalizeUUID(value) {
  if (typeof value !== "string") throw invalidReference();
  if (value.length === 32 && !/[^0-9a-fA-F]/u.test(value)) return value.toLowerCase();
  if (value.length === 36 && /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/u.test(value)) {
    return value.replaceAll("-", "").toLowerCase();
  }
  throw invalidReference();
}

export function textureURL(hash) {
  if (!validHash(hash)) throw invalidReference();
  return "https://textures.minecraft.net/texture/" + hash;
}

export function parseTextureURL(value) {
  if (typeof value !== "string") throw invalidReference();
  const match = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{32,64})$/u.exec(value);
  if (!match || match[0] !== value) throw invalidReference();
  return match[1];
}

export function encodeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || typeof snapshot.model !== "string" || !Object.hasOwn(MODEL_CODES, snapshot.model)
    || !validHash(snapshot.skinHash)
    || (snapshot.capeHash != null && !validHash(snapshot.capeHash))) {
    throw invalidReference();
  }
  return MODEL_CODES[snapshot.model] + "-" + snapshot.skinHash
    + (snapshot.capeHash == null ? "" : "-" + snapshot.capeHash);
}

export function decodeSnapshot(token) {
  if (typeof token !== "string" || token.length > 131) throw invalidReference();
  const match = /^([csu])-([0-9a-f]{32,64})(?:-([0-9a-f]{32,64}))?$/u.exec(token);
  if (!match || match[0] !== token) throw invalidReference();
  return { model: CODE_MODELS[match[1]], skinHash: match[2], capeHash: match[3] ?? null };
}

export function parseQuery(value) {
  if (typeof value !== "string" || value.length > 256) throw invalidReference();
  const reference = value.trim();
  if (reference.startsWith("texture:")) {
    return { kind: "snapshot", snapshot: decodeSnapshot(reference.slice(8)) };
  }
  if (isUsername(reference)) return { kind: "username", username: reference };
  return { kind: "uuid", uuid: normalizeUUID(reference) };
}
