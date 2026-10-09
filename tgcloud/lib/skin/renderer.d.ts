export type SkinModel = 'classic' | 'slim';
export type PreviewKind = 'head' | 'front' | 'back' | 'three-view';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export interface NormalizedSkin {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly model: SkinModel;
  readonly legacy: boolean;
}

export interface SkinPreview {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

export function normalizeSkin(image: RgbaImage, model: SkinModel): NormalizedSkin;
export function renderSkin(skin: NormalizedSkin, kind: PreviewKind): SkinPreview;
