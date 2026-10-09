import type { SkinModel, PreviewKind } from "./renderer.js";

/** Cache version for canonical pixel normalization and the bounded PNG profile. */
export const rendererVersion: "rgba-v1-png-profile-v1";

/**
 * Renders a canonical PNG preview. Legacy 64x32 textures use classic geometry.
 * Pass `classic` for unknown model metadata. `original` is not mutated.
 */
export function renderPreviewPng(original: Uint8Array, model: SkinModel, view: PreviewKind): Uint8Array;
