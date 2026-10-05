import { IdleAnimation, RunningAnimation, SkinViewer, WalkingAnimation } from 'skinview3d';
import type { SkinProfile } from './api';

export type AnimationName = 'idle' | 'walk' | 'run';

async function textureImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), credentials: 'omit' });
  if (!response.ok) throw new Error('Texture unavailable');
  const blob = await response.blob();
  if (blob.size > 1_048_576 || blob.type !== 'image/png') throw new Error('Invalid texture');
  return createImageBitmap(blob);
}

export class Viewer {
  readonly skin: SkinViewer;
  private readonly resizeObserver: ResizeObserver;
  private readonly resize: () => void;
  private readonly onContextLost: () => void;

  constructor(canvas: HTMLCanvasElement, stage: HTMLElement, onContextLost: () => void) {
    this.onContextLost = onContextLost;
    this.skin = new SkinViewer({ canvas, width: Math.max(1, stage.clientWidth), height: Math.max(1, stage.clientHeight), pixelRatio: Math.min(window.devicePixelRatio || 1, 2), zoom: 0.78 });
    this.skin.controls.enablePan = false;
    this.skin.controls.minDistance = 24;
    this.skin.controls.maxDistance = 110;
    this.resize = () => {
      if (stage.clientWidth && stage.clientHeight) this.skin.setSize(stage.clientWidth, stage.clientHeight);
    };
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(stage);
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    window.Telegram?.WebApp?.onEvent('viewportChanged', this.resize);
    canvas.addEventListener('webglcontextlost', onContextLost);
  }

  async load(profile: SkinProfile): Promise<void> {
    const image = await textureImage(profile.skin_url);
    try {
      if (image.width !== 64 || (image.height !== 64 && image.height !== 32)) throw new Error('Invalid skin');
      this.skin.loadSkin(image, {
        model: image.height === 32 ? 'default' : profile.model === 'slim' ? 'slim' : profile.model === 'classic' ? 'default' : 'auto-detect',
      });
    } finally { image.close(); }
    if (profile.cape_url) {
      const cape = await textureImage(profile.cape_url);
      try { this.skin.loadCape(cape); } finally { cape.close(); }
    }
    this.setAnimation('idle');
  }

  setAnimation(name: AnimationName): void {
    this.skin.animation = name === 'walk' ? new WalkingAnimation() : name === 'run' ? new RunningAnimation() : new IdleAnimation();
  }

  setLayer(layer: 'inner' | 'outer', visible: boolean): void {
    if (layer === 'inner') this.skin.playerObject.skin.setInnerLayerVisible(visible);
    else this.skin.playerObject.skin.setOuterLayerVisible(visible);
  }

  reset(): void {
    this.skin.zoom = 0.78;
    this.skin.resetCameraPose();
    this.skin.controls.target.set(0, 0, 0);
    this.skin.controls.update();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    window.Telegram?.WebApp?.offEvent('viewportChanged', this.resize);
    this.skin.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.skin.dispose();
  }
}
