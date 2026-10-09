import { normalizeSkin, renderSkin } from "./renderer.js";
import { decodeSkin, encodePreview } from "./png.js";

export const rendererVersion = "rgba-v1-png-profile-v1";

export function renderPreviewPng(original, model, view) {
  if (model !== "classic" && model !== "slim") throw new Error("Expected a classic or slim skin model");
  if (!["head", "front", "back", "three-view"].includes(view)) throw new Error("Unsupported skin preview view");
  return encodePreview(renderSkin(normalizeSkin(decodeSkin(original), model), view));
}
