import { fetch } from "sdk";
import { MinecraftError } from "./errors.js";
import { isUsername, normalizeUUID, parseQuery, parseTextureURL, textureURL } from "./reference.js";

const MAX_TEXTURE_PROPERTY_LENGTH = 16384;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function unavailable() {
  return new MinecraftError("UPSTREAM_UNAVAILABLE", 502, "Minecraft is unavailable.");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryAfterSeconds(value) {
  let seconds = 30;
  if (typeof value === "string" && value.length > 0) {
    if (!/[^0-9]/u.test(value)) {
      seconds = Number(value);
    } else {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) seconds = (timestamp - Date.now()) / 1000;
    }
  }
  return Math.max(1, Math.min(300, Math.ceil(seconds)));
}

async function requestJSON(url) {
  try {
    const response = await fetch(url);
    if (response.url !== url) throw unavailable();
    if (response.status === 204 || response.status === 404) {
      throw new MinecraftError("NOT_FOUND", 404, "Minecraft player not found.");
    }
    if (response.status === 429) {
      throw new MinecraftError("RATE_LIMITED", 429, "Minecraft rate limited.",
        retryAfterSeconds(response.headers.get("retry-after")));
    }
    if (response.status !== 200) throw unavailable();
    const data = await response.json();
    if (!isObject(data)) throw unavailable();
    return data;
  } catch (error) {
    if (error instanceof MinecraftError) throw error;
    throw unavailable();
  }
}

function decodeTextures(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0
    || encoded.length > MAX_TEXTURE_PROPERTY_LENGTH || /[^A-Za-z0-9+/=]/u.test(encoded)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw unavailable();
  }
  let escaped = "";
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const first = BASE64_ALPHABET.indexOf(encoded[offset]);
    const second = BASE64_ALPHABET.indexOf(encoded[offset + 1]);
    const third = BASE64_ALPHABET.indexOf(encoded[offset + 2]);
    const fourth = BASE64_ALPHABET.indexOf(encoded[offset + 3]);
    escaped += "%" + ((first << 2) | (second >> 4)).toString(16).padStart(2, "0");
    if (third >= 0) {
      escaped += "%" + (((second & 15) << 4) | (third >> 2)).toString(16).padStart(2, "0");
    }
    if (fourth >= 0) {
      escaped += "%" + (((third & 3) << 6) | fourth).toString(16).padStart(2, "0");
    }
  }
  const data = JSON.parse(decodeURIComponent(escaped));
  if (!isObject(data)) throw unavailable();
  return data;
}

function profileFromSnapshot(snapshot, uuid = null, name = null) {
  return {
    uuid,
    name,
    model: snapshot.model,
    skinUrl: textureURL(snapshot.skinHash),
    capeUrl: snapshot.capeHash === null ? null : textureURL(snapshot.capeHash),
    snapshot,
  };
}

function parseProfile(data, uuid) {
  try {
    if (normalizeUUID(data.id) !== uuid || !isUsername(data.name)) throw unavailable();
    const properties = data.properties === undefined ? [] : data.properties;
    if (!Array.isArray(properties) || properties.length > 16
      || properties.some((property) => !isObject(property) || typeof property.name !== "string")) {
      throw unavailable();
    }
    const textureProperties = properties.filter((property) => property.name === "textures");
    if (textureProperties.length > 1) throw unavailable();
    let textures = {};
    if (textureProperties.length === 1) {
      const textureData = decodeTextures(textureProperties[0].value);
      if (normalizeUUID(textureData.profileId) !== uuid || !isObject(textureData.textures)) {
        throw unavailable();
      }
      textures = textureData.textures;
    }
    const skin = textures.SKIN ?? null;
    const cape = textures.CAPE ?? null;
    const capeHash = cape === null ? null : parseTextureURL(cape.url);
    if (skin === null) {
      return {
        uuid, name: data.name, model: "unknown", skinUrl: null,
        capeUrl: capeHash === null ? null : textureURL(capeHash), snapshot: null,
      };
    }
    if (!isObject(skin) || (cape !== null && !isObject(cape))) throw unavailable();
    const metadata = skin.metadata === undefined ? {} : skin.metadata;
    if (!isObject(metadata)) throw unavailable();
    const declared = metadata.model === undefined ? "classic" : metadata.model;
    if (typeof declared !== "string") throw unavailable();
    const model = declared === "classic" || declared === "slim" ? declared : "unknown";
    return profileFromSnapshot({ model, skinHash: parseTextureURL(skin.url), capeHash }, uuid, data.name);
  } catch {
    throw unavailable();
  }
}

export async function resolveProfile(reference) {
  const query = parseQuery(reference);
  if (query.kind === "snapshot") return profileFromSnapshot(query.snapshot);
  let uuid = query.uuid;
  if (query.kind === "username") {
    const identity = await requestJSON("https://api.mojang.com/users/profiles/minecraft/" + query.username);
    try {
      uuid = normalizeUUID(identity.id);
      if (!isUsername(identity.name) || identity.name.toLowerCase() !== query.username.toLowerCase()) {
        throw unavailable();
      }
    } catch {
      throw unavailable();
    }
  }
  const profile = await requestJSON("https://sessionserver.mojang.com/session/minecraft/profile/" + uuid);
  return parseProfile(profile, uuid);
}
