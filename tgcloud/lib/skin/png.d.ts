import type { RgbaImage } from "./renderer.js";

export const MAX_SKIN_PNG_BYTES: 65536;
export const MAX_PREVIEW_PNG_BYTES: 4194304;

/** Decodes static, non-interlaced 8-bit 64x32/64x64 PNGs up to 64 KiB. Rejects invalid framing, CRC, zlib, APNG, text and ICC metadata; never mutates the input. */
export function decodeSkin(bytes: Uint8Array): RgbaImage;

/** Encodes canonical RGBA preview shapes, with a 4 MiB encoded-output limit. */
export function encodePreview(image: RgbaImage): Uint8Array;
