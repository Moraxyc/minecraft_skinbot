import { labels } from './labels.js';

const scale = 16;
const background = [239, 243, 248, 255];

export function normalizeSkin(image, model) {
  if (image.width !== 64 || (image.height !== 32 && image.height !== 64)
    || image.data.length !== image.width * image.height * 4) {
    throw new Error('Expected a 64×64 or 64×32 RGBA skin image.');
  }
  if (model !== 'classic' && model !== 'slim') throw new Error('Expected a classic or slim skin model.');

  const data = new Uint8ClampedArray(64 * 64 * 4);
  data.set(image.data);
  const legacy = image.height === 32;
  let opaque = true;
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset] !== 255) { opaque = false; break; }
  }
  if (opaque) {
    const regions = [[32, 0, 64, 16]];
    if (!legacy) regions.push([0, 32, 64, 48], [0, 48, 16, 64], [48, 48, 64, 64]);
    for (const [left, top, right, bottom] of regions) {
      for (let row = top; row < bottom; row += 1) {
        data.fill(0, (row * 64 + left) * 4, (row * 64 + right) * 4);
      }
    }
  }
  if (legacy) {
    for (const [sourceX, targetX] of [[0, 16], [40, 32]]) {
      const faces = [
        [sourceX + 4, 16, sourceX + 8, 20, targetX + 4, 48],
        [sourceX + 8, 16, sourceX + 12, 20, targetX + 8, 48],
        [sourceX + 8, 20, sourceX + 12, 32, targetX, 52],
        [sourceX + 4, 20, sourceX + 8, 32, targetX + 4, 52],
        [sourceX, 20, sourceX + 4, 32, targetX + 8, 52],
        [sourceX + 12, 20, sourceX + 16, 32, targetX + 12, 52],
      ];
      for (const [left, top, right, bottom, targetLeft, targetTop] of faces) {
        for (let row = 0; row < bottom - top; row += 1) {
          for (let column = 0; column < right - left; column += 1) {
            const source = ((top + row) * 64 + right - 1 - column) * 4;
            const target = ((targetTop + row) * 64 + targetLeft + column) * 4;
            data.set(data.subarray(source, source + 4), target);
          }
        }
      }
    }
  }
  return { data, model: legacy ? 'classic' : model, legacy };
}

function createPreview(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(background, offset);
  return { width, height, data };
}

function compositeFace(
  preview, skin, source, sourceSize,
  destination, destinationSize,
) {
  const [width, height] = destinationSize;
  for (let row = 0; row < height; row += 1) {
    const sourceRow = source[1] + Math.floor((row + 0.5) * sourceSize[1] / height);
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = source[0] + Math.floor((column + 0.5) * sourceSize[0] / width);
      const sourceOffset = (sourceRow * 64 + sourceColumn) * 4;
      const destinationOffset = ((destination[1] + row) * preview.width + destination[0] + column) * 4;
      const alpha = skin.data[sourceOffset + 3];
      for (let channel = 0; channel < 3; channel += 1) {
        preview.data[destinationOffset + channel] = Math.floor((skin.data[sourceOffset + channel] * alpha
          + preview.data[destinationOffset + channel] * (255 - alpha) + 127) / 255);
      }
    }
  }
}

function drawPart(
  preview, skin, view,
  base, outer, dimensions, position,
) {
  const [width, height, depth] = dimensions;
  const faceWidth = view === 'side' ? depth : width;
  const faceOffset = view === 'front' ? depth : view === 'back' ? width + depth * 2 : 0;
  const destination = [position[0] * scale, position[1] * scale];
  compositeFace(preview, skin, [base[0] + faceOffset, base[1] + depth], [faceWidth, height],
    destination, [faceWidth * scale, height * scale]);

  const head = base[0] === 0 && base[1] === 0;
  if (skin.legacy && !head) return;
  const inflation = head ? 1 : 0.5;
  const offset = inflation * scale / 2;
  compositeFace(preview, skin, [outer[0] + faceOffset, outer[1] + depth], [faceWidth, height],
    [destination[0] - offset, destination[1] - offset],
    [(faceWidth + inflation) * scale, (height + inflation) * scale]);
}

function renderBody(skin, view) {
  const preview = createPreview(24 * scale, 40 * scale);
  drawPart(preview, skin, view, [0, 0], [32, 0], [8, 8, 8], [8, 3]);
  const armWidth = skin.model === 'slim' ? 3 : 4;
  if (view === 'side') {
    drawPart(preview, skin, view, [16, 16], [16, 32], [8, 12, 4], [10, 11]);
    drawPart(preview, skin, view, [40, 16], [40, 32], [armWidth, 12, 4], [10, 11]);
    drawPart(preview, skin, view, [0, 16], [0, 32], [4, 12, 4], [10, 23]);
  } else {
    drawPart(preview, skin, view, [16, 16], [16, 32], [8, 12, 4], [8, 11]);
    const arms = [[[40, 16], [40, 32]], [[32, 48], [48, 48]]];
    const legs = [[[0, 16], [0, 32]], [[16, 48], [0, 48]]];
    if (view === 'back') { arms.reverse(); legs.reverse(); }
    for (let index = 0; index < 2; index += 1) {
      drawPart(preview, skin, view, arms[index][0], arms[index][1], [armWidth, 12, 4],
        [index === 0 ? 8 - armWidth : 16, 11]);
      drawPart(preview, skin, view, legs[index][0], legs[index][1], [4, 12, 4], [8 + index * 4, 23]);
    }
  }
  return preview;
}

function renderHead(skin) {
  const small = createPreview(12 * scale, 12 * scale);
  drawPart(small, skin, 'front', [0, 0], [32, 0], [8, 8, 8], [2, 2]);
  const preview = createPreview(384, 384);
  for (let row = 0; row < preview.height; row += 1) {
    for (let column = 0; column < preview.width; column += 1) {
      const source = (Math.floor(row / 2) * small.width + Math.floor(column / 2)) * 4;
      preview.data.set(small.data.subarray(source, source + 4), (row * preview.width + column) * 4);
    }
  }
  return preview;
}

export function renderSkin(skin, kind) {
  if (kind === 'head') return renderHead(skin);
  if (kind === 'front' || kind === 'back') return renderBody(skin, kind);
  if (kind !== 'three-view') throw new Error('Unsupported skin preview kind.');

  const preview = createPreview(72 * scale, 42 * scale);
  const views = ['front', 'side', 'back'];
  for (const [index, view] of views.entries()) {
    const body = renderBody(skin, view);
    for (let row = 0; row < body.height; row += 1) {
      preview.data.set(body.data.subarray(row * body.width * 4, (row + 1) * body.width * 4),
        (row * preview.width + index * body.width) * 4);
    }
    const label = labels[index];
    for (let row = 0; row < label.height; row += 1) {
      for (let column = 0; column < label.width; column += 1) {
        const alpha = label.alpha[row * label.width + column];
        const destination = ((label.top + row) * preview.width + label.left + index * body.width + column) * 4;
        for (const [channel, color] of [51, 65, 85].entries()) {
          preview.data[destination + channel] = Math.floor((color * alpha
            + preview.data[destination + channel] * (255 - alpha) + 127) / 255);
        }
      }
    }
  }
  return preview;
}
