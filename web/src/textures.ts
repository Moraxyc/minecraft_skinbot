export class TextureError extends Error {
  constructor(readonly code: 'skinUnavailable' | 'invalidSkin') { super(code); }
}

export async function loadTexture(url: string, kind: 'skin' | 'cape', signal: AbortSignal): Promise<{ image: ImageBitmap; png: Blob }> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      credentials: 'omit',
      mode: 'cors',
    });
  } catch {
    throw new TextureError('skinUnavailable');
  }
  if (!response.ok) throw new TextureError('skinUnavailable');
  const png = await response.blob();
  if (png.size > 1_048_576) throw new TextureError('invalidSkin');
  const header = new Uint8Array(await png.slice(0, 24).arrayBuffer());
  if (header.length !== 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    || String.fromCharCode(...header.slice(12, 16)) !== 'IHDR') throw new TextureError('invalidSkin');
  const dimensions = new DataView(header.buffer);
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  if (width !== 64 || (height !== 32 && (kind === 'cape' || height !== 64))) throw new TextureError('invalidSkin');
  let image: ImageBitmap;
  try { image = await createImageBitmap(png); }
  catch { throw new TextureError('invalidSkin'); }
  if (signal.aborted) {
    image.close();
    signal.throwIfAborted();
  }
  return { image, png };
}

