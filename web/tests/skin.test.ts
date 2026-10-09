import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { normalizeSkin, renderSkin } from '../src/skin';
import type { PreviewKind, RgbaImage, SkinModel, SkinPreview } from '../src/skin';

function coordinateImage(height = 64): RgbaImage {
  const data = new Uint8ClampedArray(64 * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      if ((row < 16 && column < 32) || (row >= 16 && row < 32)
        || (row >= 48 && column >= 16 && column < 48)) {
        data.set(color(column, row), (row * 64 + column) * 4);
      }
    }
  }
  return { width: 64, height, data };
}

function color(column: number, row: number): number[] {
  return [column * 3, row * 3, (column + row) * 2, 255];
}

function pixel(data: Uint8Array | Uint8ClampedArray, width: number, column: number, row: number): number[] {
  const offset = (row * width + column) * 4;
  return Array.from(data.subarray(offset, offset + 4));
}

function rgb(preview: SkinPreview): Uint8Array {
  const data = new Uint8Array(preview.width * preview.height * 3);
  for (let index = 0; index < preview.width * preview.height; index += 1) {
    if (preview.data[index * 4 + 3] !== 255) throw new Error(`Preview pixel ${index} is not opaque.`);
    data.set(preview.data.subarray(index * 4, index * 4 + 3), index * 3);
  }
  return data;
}

function golden(model: SkinModel, kind: PreviewKind): { width: number; height: number; data: Uint8Array } {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/golden');
  const png = readFileSync(resolve(directory, `${model}-${kind}.png`));
  return PNG.sync.read(png);
}

describe.each<SkinModel>(['classic', 'slim'])('%s flat skin previews', (model) => {
  it.each<PreviewKind>(['head', 'front', 'back', 'three-view'])('matches the reviewed %s golden pixels', (kind) => {
    const actual = renderSkin(normalizeSkin(coordinateImage(), model), kind);
    const expected = golden(model, kind);
    expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
    expect(actual.data.length).toBe(expected.data.length);
    const mismatch = actual.data.findIndex((channel, index) => channel !== expected.data[index]);
    expect(mismatch, `First differing RGBA byte: ${mismatch}`).toBe(-1);
  });
});

it('reflects both legacy left limbs and uses classic geometry despite slim metadata', () => {
  const skin = normalizeSkin(coordinateImage(32), 'slim');
  expect(skin.model).toBe('classic');
  expect(pixel(skin.data, 64, 20, 52)).toEqual(color(7, 20));
  expect(pixel(skin.data, 64, 23, 52)).toEqual(color(4, 20));
  expect(pixel(skin.data, 64, 36, 52)).toEqual(color(47, 20));
  expect(pixel(skin.data, 64, 44, 52)).toEqual(color(55, 20));
  const front = renderSkin(skin, 'front');
  expect(pixel(front.data, front.width, 4 * 16 + 8, 11 * 16 + 8)).toEqual(color(44, 20));
  expect(pixel(front.data, front.width, 12 * 16 + 8, 23 * 16 + 8)).toEqual(color(7, 20));
});

it('composites a half-transparent hat over its base and retains background through transparent texels', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let row = 8; row < 16; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      data.set([240, 0, 0, 255], (row * 64 + column + 8) * 4);
      data.set([0, 0, 240, 128], (row * 64 + column + 40) * 4);
    }
  }
  const head = renderSkin(normalizeSkin({ width: 64, height: 64, data }, 'classic'), 'head');
  expect(pixel(head.data, head.width, 192, 192)).toEqual([120, 0, 120, 255]);
  expect(pixel(head.data, head.width, 0, 0)).toEqual([239, 243, 248, 255]);
  data.fill(0);
  const transparent = renderSkin(normalizeSkin({ width: 64, height: 64, data }, 'classic'), 'head');
  expect(pixel(transparent.data, transparent.width, 192, 192)).toEqual([239, 243, 248, 255]);
});

it('clears opaque atlas outer layers without mutating pixels shared with the 3D viewer', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([255, 0, 0, 255], offset);
  const skin = normalizeSkin({ width: 64, height: 64, data }, 'classic');
  for (const [column, row] of [[40, 8], [20, 36], [52, 52]]) {
    expect(pixel(skin.data, 64, column, row)[3]).toBe(0);
    expect(pixel(data, 64, column, row)).toEqual([255, 0, 0, 255]);
  }
  expect(pixel(skin.data, 64, 8, 8)).toEqual([255, 0, 0, 255]);
});

it('matches the independent Pillow pixels for fractional slim overlays with varying alpha', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let row = 0; row < 64; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      data.set([(column * 11 + row * 7) % 256, (column * 5 + row * 13) % 256,
        (column * 17 + row * 3) % 256, (column * 19 + row * 23) % 256], (row * 64 + column) * 4);
    }
  }
  const front = renderSkin(normalizeSkin({ width: 64, height: 64, data }, 'slim'), 'front');
  expect(createHash('sha256').update(rgb(front)).digest('hex'))
    .toBe('3dff449055994801d5c8a1c0370f7dd3dba563d99d48f904557f733b8b0c2f49');
});

it.each([[32, 32, 32 * 32 * 4], [64, 48, 64 * 48 * 4], [64, 64, 64 * 64 * 4 - 1]])(
  'rejects unsupported dimensions or incomplete RGBA data (%s×%s, %s bytes)', (width, height, bytes) => {
    expect(() => normalizeSkin({ width, height, data: new Uint8ClampedArray(bytes) }, 'classic')).toThrow('RGBA skin image');
  },
);
