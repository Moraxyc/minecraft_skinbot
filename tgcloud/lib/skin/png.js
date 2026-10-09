import { decode, encode, convertIndexedToRgb, hasPngSignature } from "./vendor/png-codec.js";

export const MAX_SKIN_PNG_BYTES = 65_536;
export const MAX_PREVIEW_PNG_BYTES = 4_194_304;

function inspectSkinPng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SKIN_PNG_BYTES
    || bytes.length < 57 || !hasPngSignature(bytes)) throw new Error("Invalid skin PNG input");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunks = 0;
  let seenHeader = false;
  let seenData = false;
  let endedData = false;
  let expectedBytes = 0;
  let colorType = -1;
  let paletteSize = 0;
  let transparency = false;
  while (offset < bytes.length) {
    if (++chunks > 128 || offset + 12 > bytes.length) throw new Error("Invalid PNG chunk bounds");
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new Error("Invalid PNG chunk length");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (typeBytes.some((value) => !((value >= 65 && value <= 90) || (value >= 97 && value <= 122)))
      || (typeBytes[2] & 32)) throw new Error("Invalid PNG chunk type");
    const type = String.fromCharCode(...typeBytes);
    if (!seenHeader && type !== "IHDR") throw new Error("Missing initial PNG header");
    if (type === "IHDR") {
      if (seenHeader || length !== 13) throw new Error("Invalid PNG header");
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      colorType = bytes[offset + 17];
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
      if (width !== 64 || (height !== 32 && height !== 64)) throw new Error("Invalid skin dimensions");
      if (bytes[offset + 16] !== 8 || !channels || bytes[offset + 18] !== 0
        || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error("Unsupported skin PNG layout");
      expectedBytes = (width * channels + 1) * height;
      seenHeader = true;
    } else if (type === "IDAT") {
      if (endedData || (colorType === 3 && !paletteSize)) throw new Error("Invalid PNG data order");
      seenData = true;
    } else if (type === "PLTE") {
      if (seenData || paletteSize || transparency || [0, 4].includes(colorType)
        || !length || length > 768 || length % 3) throw new Error("Invalid PNG palette");
      paletteSize = length / 3;
    } else if (type === "tRNS") {
      if (seenData || transparency || !length || (colorType === 0 && length !== 2)
        || (colorType === 2 && length !== 6) || (colorType === 3 && (!paletteSize || length > paletteSize))
        || [4, 6].includes(colorType)) throw new Error("Invalid PNG transparency");
      transparency = true;
    } else {
      if (seenData) endedData = true;
      if (["acTL", "fcTL", "fdAT", "iCCP", "zTXt", "iTXt", "tEXt"].includes(type)) {
        throw new Error("Unsupported skin PNG metadata");
      }
      if (type === "IEND") {
        if (!seenData || length !== 0 || offset + 12 !== bytes.length) throw new Error("Invalid PNG end");
        return { expectedInflatedBytes: expectedBytes, colorType };
      }
      if (!(typeBytes[0] & 32)) throw new Error("Unknown critical PNG chunk");
    }
    offset += length + 12;
  }
  throw new Error("Missing PNG end");
}

export function decodeSkin(bytes) {
  const { expectedInflatedBytes, colorType } = inspectSkinPng(bytes);
  const image = decode(bytes, { checkCrc: true, expectedInflatedBytes });
  let source = image.data;
  let channels = image.channels;
  if (colorType === 3) {
    source = convertIndexedToRgb(image);
    channels = image.palette[0].length;
  }
  const data = new Uint8Array(image.width * image.height * 4);
  for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex += 1) {
    const input = pixelIndex * channels;
    const output = pixelIndex * 4;
    if (channels >= 3) {
      data[output] = source[input];
      data[output + 1] = source[input + 1];
      data[output + 2] = source[input + 2];
      data[output + 3] = channels === 4 ? source[input + 3]
        : image.transparency?.every((value, index) => source[input + index] === value) ? 0 : 255;
    } else {
      data.fill(source[input], output, output + 3);
      data[output + 3] = channels === 2 ? source[input + 1]
        : image.transparency?.[0] === source[input] ? 0 : 255;
    }
  }
  return { width: image.width, height: image.height, data };
}

export function encodePreview(image) {
  if (!image || ![[384, 384], [384, 640], [1152, 672]]
    .some(([width, height]) => image.width === width && image.height === height)
    || !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) throw new Error("Invalid preview RGBA image");
  const png = encode({ width: image.width, height: image.height, data: image.data, depth: 8, channels: 4 },
    { zlib: { level: 3 } });
  if (png.length > MAX_PREVIEW_PNG_BYTES) throw new Error("Preview PNG exceeds budget");
  return png;
}
