import { IdleAnimation, RunningAnimation, SkinViewer, WalkingAnimation } from 'skinview3d';
import type { SkinSnapshot } from './snapshot';
import { loadTexture } from './textures';

export type AnimationName = 'idle' | 'walk' | 'run';
export type CameraView = 'front' | 'side' | 'back';
export type PreviewModel = 'auto' | 'classic' | 'slim';

export class Viewer {
  readonly skin: SkinViewer;
  private readonly resizeObserver: ResizeObserver;
  private readonly resize: () => void;
  private readonly onContextLost: () => void;
  private detectedModel: 'default' | 'slim' = 'default';

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

  async load(profile: SkinSnapshot, image: ImageBitmap, signal: AbortSignal): Promise<{ capeUnavailable: boolean; canOverrideModel: boolean }> {
    const canOverrideModel = image.height === 64 && profile.model === 'unknown';
    signal.throwIfAborted();
    this.skin.loadSkin(image, {
      model: image.height === 32 ? 'default' : profile.model === 'slim' ? 'slim' : profile.model === 'classic' ? 'default' : 'auto-detect',
    });
    this.detectedModel = this.skin.playerObject.skin.modelType;
    let capeUnavailable = false;
    if (profile.capeURL) {
      try {
        const { image: cape } = await loadTexture(profile.capeURL, 'cape', signal);
        try {
          signal.throwIfAborted();
          this.skin.loadCape(cape);
        } finally { cape.close(); }
      } catch (error) {
        if (signal.aborted) throw error;
        capeUnavailable = true;
      }
    }
    signal.throwIfAborted();
    this.setAnimation('idle');
    return { capeUnavailable, canOverrideModel };
  }

  setAnimation(name: AnimationName): void {
    this.skin.animation = name === 'walk' ? new WalkingAnimation() : name === 'run' ? new RunningAnimation() : new IdleAnimation();
  }

  setPaused(paused: boolean): void {
    if (this.skin.animation) this.skin.animation.paused = paused;
  }

  setPreviewModel(model: PreviewModel): void {
    this.skin.playerObject.skin.modelType = model === 'auto' ? this.detectedModel : model === 'slim' ? 'slim' : 'default';
  }

  setView(view: CameraView): void {
    const { camera, controls } = this.skin;
    const distance = camera.position.distanceTo(controls.target);
    camera.position.set(view === 'side' ? distance : 0, 0, view === 'front' ? distance : view === 'back' ? -distance : 0).add(controls.target);
    controls.update();
  }

  zoom(direction: 'in' | 'out'): void {
    const { camera, controls } = this.skin;
    const current = camera.position.distanceTo(controls.target);
    const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, current * (direction === 'in' ? 0.8 : 1.25)));
    camera.position.sub(controls.target).multiplyScalar(distance / current).add(controls.target);
    controls.update();
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
