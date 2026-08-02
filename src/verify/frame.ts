import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';

export interface Frame {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Read the rendered frame back from the GPU.
 *
 * `canvas.toDataURL()` / `drawImage(canvas)` do NOT work on a WebGPU canvas —
 * there is no preserved drawing buffer, so both silently return a blank white
 * image, which reads as "the render is broken" rather than "the capture is
 * broken". engine.readPixels goes to the backbuffer and flushes first.
 *
 * readPixels also hands back the swapchain's native byte order, which is BGRA
 * on Windows and macOS. Normalised to RGBA here so no caller has to know.
 */
export async function readFrame(engine: WebGPUEngine): Promise<Frame> {
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const raw = await engine.readPixels(0, 0, width, height, true, true);
  const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  if (navigator.gpu?.getPreferredCanvasFormat() === 'bgra8unorm') {
    for (let i = 0; i < data.length; i += 4) {
      const b = data[i];
      data[i] = data[i + 2];
      data[i + 2] = b;
    }
  }
  return { data, width, height };
}

/** readPixels returns bottom-up; flip into top-down image space. */
export function frameToCanvas(frame: Frame): HTMLCanvasElement {
  const { data, width, height } = frame;
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    img.data.set(data.subarray(src, src + width * 4), y * width * 4);
  }
  ctx.putImageData(img, 0, 0);
  return off;
}

/**
 * POST a PNG of the current frame to the dev server's screenshot sink.
 *
 * The agent browser pane cannot composite frames, so `computer{screenshot}`
 * times out and this is the only way to actually see a render. Also the
 * mechanism the golden-image regression tests will use.
 */
export async function captureFrame(
  engine: WebGPUEngine,
  name: string,
  render?: () => void
): Promise<string> {
  // The render MUST happen in the same task as the readback. Relying on the
  // running render loop instead produces an all-zero read (alpha included),
  // which becomes a fully transparent PNG — and a transparent PNG looks
  // exactly like a white one, so it reads as "the renderer is broken".
  render?.();
  const frame = await readFrame(engine);

  // Fail loudly rather than writing a blank artifact. A silently empty
  // screenshot is worse than no screenshot: it sends you debugging the
  // renderer when the capture is at fault.
  let opaque = 0;
  for (let i = 3; i < frame.data.length; i += 4 * 37) {
    if (frame.data[i] !== 0) opaque++;
  }
  if (opaque === 0) {
    throw new Error(
      `captureFrame('${name}'): frame is fully transparent — the readback ` +
        `happened outside a render. Pass a render callback.`
    );
  }

  const dataUrl = frameToCanvas(frame).toDataURL('image/png');
  const res = await fetch('/__shot', {
    method: 'POST',
    headers: { 'x-shot-name': name, 'content-type': 'text/plain' },
    body: dataUrl,
  });
  const j = (await res.json()) as { path: string };
  return j.path;
}
