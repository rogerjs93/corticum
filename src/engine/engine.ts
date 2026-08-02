import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';

export interface EngineCaps {
  supportComputeShaders: boolean;
  /** Whether a fragment shader may write depth — gate S5 depends on this. */
  fragmentDepthSupported: boolean;
  maxTextureSize: number;
  adapterInfo: string;
}

export class WebGPUUnavailableError extends Error {}

/**
 * Create the WebGPU engine, or fail with a message worth showing a visitor.
 *
 * There is deliberately no WebGL2 fallback: the entire architecture rests on
 * compute shaders writing 3D storage textures, which WebGL2 cannot do. A
 * visitor without WebGPU gets a clear explanation (and, from Phase 4, the
 * teaching layer still works) rather than a blank canvas.
 */
export async function createEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    throw new WebGPUUnavailableError(
      'navigator.gpu is undefined — this browser has no WebGPU support.'
    );
  }

  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    stencil: false,
    // Lets us read GPU timings per pass once we start tuning the march.
    enableGPUDebugMarkers: false,
  });

  await engine.initAsync();

  if (!engine.getCaps().supportComputeShaders) {
    throw new WebGPUUnavailableError(
      'WebGPU initialised but reports no compute shader support.'
    );
  }

  return engine;
}

export function readCaps(engine: WebGPUEngine): EngineCaps {
  const caps = engine.getCaps();
  return {
    supportComputeShaders: !!caps.supportComputeShaders,
    fragmentDepthSupported: !!caps.fragmentDepthSupported,
    maxTextureSize: caps.maxTextureSize,
    adapterInfo: engine.description ?? 'unknown',
  };
}
