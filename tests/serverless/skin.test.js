import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import { deflateSync, gzipSync } from "node:zlib";
import { encode } from "fast-png";
import { PNG } from "pngjs";
import { decodeSkin, encodePreview } from "../../tgcloud/lib/skin/png.js";
import { renderPreviewPng } from "../../tgcloud/lib/skin/preview-png.js";
import { normalizeSkin } from "../../tgcloud/lib/skin/renderer.js";

const require = createRequire(import.meta.url);
const { crc32 } = require("pngjs/lib/crc.js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kinds = ["head", "front", "back", "three-view"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function pixels(height = 64, pattern = "golden") {
  const data = Buffer.alloc(64 * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      const offset = (row * 64 + column) * 4;
      const base = (row < 16 && column < 32) || (row >= 16 && row < 32)
        || (row >= 48 && column >= 16 && column < 48);
      if (pattern === "golden") {
        if (base) data.set([column * 3, row * 3, (column + row) * 2, 255], offset);
      } else {
        const alpha = pattern === "opaque" || (pattern === "coordinates" && base) ? 255
          : pattern === "alpha" ? (column * 19 + row * 23) % 256 : 0;
        data.set([(column * 11 + row * 7) % 256, (column * 5 + row * 13) % 256,
          (column * 17 + row * 3) % 256, alpha], offset);
      }
    }
  }
  return data;
}

function png(data = pixels(), height = 64) {
  return PNG.sync.write({ width: 64, height, data });
}

function rgb(image) {
  const result = Buffer.alloc(image.width * image.height * 3);
  for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex += 1) {
    assert.equal(image.data[pixelIndex * 4 + 3], 255);
    result.set(image.data.subarray(pixelIndex * 4, pixelIndex * 4 + 3), pixelIndex * 3);
  }
  return result;
}

function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function parts(input) {
  const chunks = [];
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset);
    chunks.push(input.subarray(offset, offset + length + 12));
    offset += length + 12;
  }
  return { signature: input.subarray(0, 8), header: chunks[0],
    data: Buffer.concat(chunks.filter((value) => value.toString("ascii", 4, 8) === "IDAT").map((value) => value.subarray(8, -4))),
    end: chunks.at(-1) };
}

test("PNG pipeline preserves the eight reviewed golden pixels and original document bytes", async () => {
  const input = png();
  const original = Buffer.from(input);
  for (const model of ["classic", "slim"]) {
    for (const kind of kinds) {
      const encoded = renderPreviewPng(input, model, kind);
      assert.ok(encoded instanceof Uint8Array);
      const actual = PNG.sync.read(Buffer.from(encoded));
      const expected = PNG.sync.read(await readFile(resolve(root, `tests/golden/${model}-${kind}.png`)));
      assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
      assert.deepEqual(actual.data, expected.data, `${model} ${kind}`);
    }
  }
  assert.deepEqual(input, original);
  assert.deepEqual(renderPreviewPng(input, "slim", "head"), renderPreviewPng(input, "slim", "head"));
});

test("PNG decoding and canonical normalization preserve the independent Pillow legacy and alpha matrix", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/skin-pillow.json", import.meta.url), "utf8"));
  for (const testcase of fixture.cases) {
    const data = pixels(testcase.height, testcase.pattern);
    assert.equal(sha256(data), testcase.inputSha256);
    const input = png(data, testcase.height);
    const original = Buffer.from(input);
    const decoded = decodeSkin(input);
    assert.deepEqual(Buffer.from(decoded.data), data);
    const normalized = normalizeSkin(decoded, testcase.model);
    assert.equal(normalized.model, testcase.renderModel);
    assert.equal(normalized.legacy, testcase.legacy);
    assert.equal(sha256(normalized.data), testcase.normalizedSha256);
    for (const expected of testcase.previews) {
      const actual = PNG.sync.read(Buffer.from(renderPreviewPng(input, testcase.model, expected.kind)));
      assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
      assert.equal(sha256(rgb(actual)), expected.sha256, `${testcase.name} ${expected.kind}`);
    }
    assert.deepEqual(input, original);
  }
});

test("bounded PNG decoder preserves supported color profiles, transparency and chunked byte views", () => {
  const profiles = [
    { channels: 1, pixel: [99], rgba: [99, 99, 99, 255] },
    { channels: 2, pixel: [99, 127], rgba: [99, 99, 99, 127] },
    { channels: 3, pixel: [22, 44, 66], rgba: [22, 44, 66, 255] },
    { channels: 4, pixel: [22, 44, 66, 127], rgba: [22, 44, 66, 127] },
    { name: "RGB suggested PLTE", channels: 3, pixel: [0, 0, 0], rgba: [0, 0, 0, 255], suggestedPalette: [255, 0, 0] },
    { name: "RGBA suggested PLTE", channels: 4, pixel: [0, 0, 0, 127], rgba: [0, 0, 0, 127], suggestedPalette: [255, 0, 0] },
    { channels: 1, pixel: [99], rgba: [99, 99, 99, 0], transparency: [0, 99] },
    { channels: 3, pixel: [22, 44, 66], rgba: [22, 44, 66, 0], transparency: [0, 22, 0, 44, 0, 66] },
  ];
  for (const profile of profiles) {
    const data = Uint8Array.from({ length: 64 * 32 * profile.channels }, (_, index) => profile.pixel[index % profile.channels]);
    let input = Buffer.from(encode({ width: 64, height: 32, depth: 8, channels: profile.channels, data }));
    if (profile.suggestedPalette) input = Buffer.concat([input.subarray(0, 33), chunk("PLTE", Buffer.from(profile.suggestedPalette)), input.subarray(33)]);
    if (profile.transparency) input = Buffer.concat([input.subarray(0, 33), chunk("tRNS", Buffer.from(profile.transparency)), input.subarray(33)]);
    const decoded = decodeSkin(input);
    const expected = Buffer.from(Array.from({ length: 64 * 32 * 4 }, (_, index) => profile.rgba[index % 4]));
    assert.deepEqual(Buffer.from(decoded.data), expected, profile.name);
  }
  for (const palette of [[[10, 20, 30], [40, 50, 60], [70, 80, 90]], [[10, 20, 30, 255], [40, 50, 60, 128], [70, 80, 90, 0]]]) {
    const data = Uint8Array.from({ length: 64 * 64 }, (_, index) => index % 3);
    let input = Buffer.from(encode({ width: 64, height: 64, depth: 8, channels: 1, data,
      palette: palette.map((color) => color.slice(0, 3)) }));
    if (palette[0].length === 4) {
      const paletteEnd = 33 + input.readUInt32BE(33) + 12;
      input = Buffer.concat([input.subarray(0, paletteEnd), chunk("tRNS", Buffer.from(palette.map((color) => color[3]))), input.subarray(paletteEnd)]);
    }
    const actual = decodeSkin(input);
    assert.deepEqual(Array.from(actual.data.subarray(0, 12)), palette.flatMap((color) => color.length === 4 ? color : [...color, 255]));
  }
  const input = png();
  const { signature, header, data, end } = parts(input);
  const split = Buffer.concat([signature, header, chunk("IDAT", data.subarray(0, 2)), chunk("IDAT", data.subarray(2, -2)), chunk("IDAT", data.subarray(-2)), end]);
  assert.deepEqual(Buffer.from(decodeSkin(split).data), pixels());
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), split, Buffer.from([4])]);
  assert.deepEqual(Buffer.from(decodeSkin(padded.subarray(3, -1)).data), pixels());
  const maxBytes = Buffer.concat([signature, header, chunk("vpAg", Buffer.alloc(65_536 - input.length - 12)), chunk("IDAT", data), end]);
  assert.equal(maxBytes.length, 65_536);
  assert.deepEqual(Buffer.from(decodeSkin(maxBytes).data), pixels());
  const maxChunks = Buffer.concat([signature, header, ...Array.from({ length: 125 }, () => chunk("vpAg")), chunk("IDAT", data), end]);
  assert.deepEqual(Buffer.from(decodeSkin(maxChunks).data), pixels());
});

test("PNG boundary policy rejects malformed framing, unsafe profiles, CRC failures and non-exact zlib streams", () => {
  const input = png();
  const { signature, header, data, end } = parts(input);
  const assemble = (...chunks) => Buffer.concat([signature, header, ...chunks, end]);
  const changedHeader = (byte, value) => {
    const body = Buffer.from(header.subarray(8, -4));
    body[byte] = value;
    return Buffer.concat([signature, chunk("IHDR", body), chunk("IDAT", data), end]);
  };
  const invalidCrc = chunk("IDAT", data);
  invalidCrc[invalidCrc.length - 1] ^= 1;
  const invalidEnd = Buffer.from(end);
  invalidEnd[invalidEnd.length - 1] ^= 1;
  const invalidHeader = Buffer.from(header);
  invalidHeader[invalidHeader.length - 1] ^= 1;
  const invalidAncillary = chunk("vpAg");
  invalidAncillary[invalidAncillary.length - 1] ^= 1;
  const rawScanlines = Buffer.alloc((64 * 4 + 1) * 64);
  const invalidFilter = Buffer.from(rawScanlines);
  invalidFilter[0] = 5;
  const oversizedChunk = Buffer.from(input);
  oversizedChunk.writeUInt32BE(0xffff_ffff, 8);
  const invalidPaletteIndex = encode({ width: 64, height: 32, depth: 8, channels: 1,
    data: new Uint8Array(64 * 32).fill(1), palette: [[10, 20, 30]] });
  const cases = [
    ["wrong byte primitive", new ArrayBuffer(input.length)],
    ["compressed input cap", new Uint8Array(65_537)],
    ["invalid signature", input.subarray(1)],
    ["truncated chunk", input.subarray(0, 56)],
    ["oversized chunk length", oversizedChunk],
    ["palette index overflow", invalidPaletteIndex],
    ["duplicate header", assemble(header, chunk("IDAT", data))],
    ["missing end", input.subarray(0, -12)],
    ["missing data", Buffer.concat([signature, header, end])],
    ["trailing container", Buffer.concat([input, Buffer.from([0])])],
    ["chunk count cap", assemble(...Array.from({ length: 126 }, () => chunk("vpAg")), chunk("IDAT", data))],
    ["wrong dimensions", changedHeader(3, 65)],
    ["oversized dimensions", changedHeader(0, 255)],
    ["wrong height", changedHeader(7, 33)],
    ["16-bit", changedHeader(8, 16)],
    ["Adam7", changedHeader(12, 1)],
    ["unknown color", changedHeader(9, 7)],
    ["unknown compression", changedHeader(10, 1)],
    ["unknown filter method", changedHeader(11, 1)],
    ["empty palette", assemble(chunk("PLTE"), chunk("IDAT", data))],
    ["RGBA transparency", assemble(chunk("tRNS", Buffer.from([0])), chunk("IDAT", data))],
    ["unknown critical", assemble(chunk("ABCD"), chunk("IDAT", data))],
    ["invalid chunk name", assemble(chunk("vp1g"), chunk("IDAT", data))],
    ["reserved chunk bit", assemble(chunk("vpag"), chunk("IDAT", data))],
    ["nonconsecutive data", assemble(chunk("IDAT", data.subarray(0, 2)), chunk("vpAg"), chunk("IDAT", data.subarray(2)))],
    ["IDAT CRC", assemble(invalidCrc)],
    ["IHDR CRC", Buffer.concat([signature, invalidHeader, chunk("IDAT", data), end])],
    ["IEND CRC", Buffer.concat([signature, header, chunk("IDAT", data), invalidEnd])],
    ["ancillary CRC", assemble(invalidAncillary, chunk("IDAT", data))],
    ["invalid scanline filter", assemble(chunk("IDAT", deflateSync(invalidFilter)))],
    ["short inflation", assemble(chunk("IDAT", deflateSync(rawScanlines.subarray(0, -1))))],
    ["long inflation", assemble(chunk("IDAT", deflateSync(Buffer.alloc(1_048_576)))), (error) => /exceeds budget/.test(error.cause?.message ?? error.message)],
    ["incomplete zlib", assemble(chunk("IDAT", data.subarray(0, -2)))],
    ["gzip instead of zlib", assemble(chunk("IDAT", gzipSync(rawScanlines)))],
    ["trailing zlib zero", assemble(chunk("IDAT", Buffer.concat([data, Buffer.from([0])])))],
    ["trailing zlib bytes", assemble(chunk("IDAT", Buffer.concat([data, Buffer.from([1, 2, 3])])))],
    ["second zlib stream", assemble(chunk("IDAT", Buffer.concat([data, deflateSync(Buffer.from([1]))])))],
    ["second empty zlib stream", assemble(chunk("IDAT", Buffer.concat([data, deflateSync(Buffer.alloc(0))])))],
  ];
  for (const type of ["acTL", "fcTL", "fdAT", "iCCP", "zTXt", "iTXt", "tEXt"]) {
    cases.push([type, assemble(chunk(type, Buffer.alloc(26)), chunk("IDAT", data))]);
  }
  for (const [name, bytes, expected = Error] of cases) assert.throws(() => decodeSkin(bytes), expected, name);
});

test("PNG output is bounded to canonical shapes and the public wrapper rejects unsupported policies", () => {
  for (const image of [null, { width: 1, height: 1, data: new Uint8Array(4) },
    { width: 384, height: 384, data: new Uint8Array(384 * 384 * 4 - 1) },
    { width: 1152, height: 673, data: new Uint8Array(0) },
    { width: 384, height: 384, data: Array(384 * 384 * 4).fill(0) }]) {
    assert.throws(() => encodePreview(image), /Invalid preview/);
  }
  for (const model of [undefined, "unknown", "wide"]) assert.throws(() => renderPreviewPng(png(), model, "head"), /classic or slim/);
  for (const view of [undefined, "side", "3d", "HEAD"]) assert.throws(() => renderPreviewPng(png(), "classic", view), /Unsupported/);
  const data = new Uint8Array(1152 * 672 * 4);
  let state = 0x12345678;
  for (let index = 0; index < data.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 255;
  }
  const output = encodePreview({ width: 1152, height: 672, data });
  assert.ok(output.length < 4_194_304);
  assert.deepEqual(PNG.sync.read(Buffer.from(output)).data, Buffer.from(data));
});

test("PNG wrapper runs from deployable ESM without Node, DOM, SDK or host text globals", async () => {
  const context = vm.createContext({});
  const modules = new Map();
  async function load(filename) {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(await readFile(filename, "utf8"), { context, identifier: filename }));
    return modules.get(filename);
  }
  const entry = await load(resolve(root, "tgcloud/lib/skin/preview-png.js"));
  await entry.link((specifier, parent) => {
    assert.ok(specifier.startsWith("./") && specifier.endsWith(".js"));
    return load(resolve(dirname(parent.identifier), specifier));
  });
  await entry.evaluate({ timeout: 5000 });
  assert.equal(vm.runInContext("[typeof Buffer, typeof process, typeof require, typeof window, typeof document, typeof sdk, typeof fetch, typeof TextEncoder, typeof TextDecoder].every(value => value === 'undefined')", context), true);
  context.input = Array.from(png());
  const bytes = vm.runInContext("Uint8Array.from(input)", context);
  const output = entry.namespace.renderPreviewPng(bytes, "slim", "three-view");
  const expected = PNG.sync.read(await readFile(resolve(root, "tests/golden/slim-three-view.png")));
  assert.deepEqual(PNG.sync.read(Buffer.from(output)).data, expected.data);
});
