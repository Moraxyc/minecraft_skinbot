import { fetch } from "sdk";
import { MinecraftError } from "./errors.js";
import { parseTextureURL, textureURL } from "./reference.js";

const MAX_TEXTURE_BYTES = 65536;
const MAX_TEXTURE_CHUNKS = 65536;

function unavailable() {
  return new MinecraftError("UPSTREAM_UNAVAILABLE", 502, "Minecraft texture is unavailable.");
}

function tooLarge() {
  return new MinecraftError("TEXTURE_TOO_LARGE", 502, "Minecraft texture exceeds 64 KiB.");
}

function unsupported() {
  return new MinecraftError("UNSUPPORTED_BYTE_TRANSPORT", 502,
    "Minecraft texture requires raw byte chunks; text transport is unsupported.");
}

function byteChunk(chunk) {
  try {
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk) && chunk.buffer instanceof ArrayBuffer
      && (chunk instanceof Uint8Array || chunk instanceof Int8Array
        || chunk instanceof Uint8ClampedArray || chunk instanceof DataView)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
  } catch {
    throw unsupported();
  }
  throw unsupported();
}

function contentLength(headers) {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/u.test(value)) {
    throw unavailable();
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 1) throw unavailable();
  if (length > MAX_TEXTURE_BYTES) throw tooLarge();
  return length;
}

async function collectBytes(body, expectedLength) {
  if (body == null || typeof body[Symbol.asyncIterator] !== "function") throw unsupported();
  const result = new Uint8Array(expectedLength ?? MAX_TEXTURE_BYTES);
  let length = 0;
  let chunks = 0;
  try {
    for await (const chunk of body) {
      chunks += 1;
      if (chunks > MAX_TEXTURE_CHUNKS) throw unavailable();
      const bytes = byteChunk(chunk);
      if (length + bytes.byteLength > MAX_TEXTURE_BYTES) throw tooLarge();
      if (expectedLength !== null && length + bytes.byteLength > expectedLength) {
        throw unavailable();
      }
      result.set(bytes, length);
      length += bytes.byteLength;
    }
  } catch (error) {
    if (error instanceof MinecraftError) throw error;
    throw unavailable();
  }
  if (length === 0 || (expectedLength !== null && length !== expectedLength)) throw unavailable();
  return result.slice(0, length);
}

/**
 * Fetches an exact Mojang texture URL and returns an owned `Uint8Array`.
 * The URL is canonicalized to HTTPS. Redirects, non-PNG responses, and
 * non-identity encodings are rejected. Throws `MinecraftError` with
 * INVALID_REFERENCE (400), UPSTREAM_UNAVAILABLE (502), TEXTURE_TOO_LARGE (502),
 * or UNSUPPORTED_BYTE_TRANSPORT (502). The caller validates PNG framing and
 * 64x32/64x64 skin dimensions.
 */
export async function fetchTextureBytes(reference) {
  const url = textureURL(parseTextureURL(reference));
  let response;
  try {
    response = await fetch(url, { method: "GET", headers: { Accept: "image/png" } });
  } catch {
    throw unavailable();
  }
  if (!response || response.status !== 200 || response.url !== url
    || typeof response.headers?.get !== "function") throw unavailable();
  const type = response.headers.get("content-type");
  if (typeof type !== "string" || type.split(";", 1)[0].trim().toLowerCase() !== "image/png") {
    throw unavailable();
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && (typeof encoding !== "string"
    || encoding.trim().toLowerCase() !== "identity")) throw unavailable();
  // The SDK promises neither byte chunks nor a request timeout, so the collector below
  // validates the body instead of trusting it.
  return collectBytes(response.body, contentLength(response.headers));
}
