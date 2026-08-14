import { Constants } from '@babylonjs/core/Engines/constants';
import { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';

export interface FieldManifest {
  version: string;
  subject: string;
  grid: {
    dim: number;
    halfExtentMm: number;
    spacingMm: number;
    worldAxes: string;
    centredOn: string;
  };
  sdf: { rangeMm: number; encoding: string };
  ventricle: { dim: number };
  sulc: { dim: number; range: number } | null;
  occupancy: number;
  /**
   * Subject-derived anatomical reference points, used to place the dural folds
   * in the compliance field. Optional because older payloads predate them.
   */
  landmarks?: {
    corpusCallosumTopMm?: number;
    corpusCallosumBottomMm?: number;
    cerebellumTopMm?: number;
    brainstemCentreZMm?: number;
  };
  labelCount: number;
  tissueClasses: Record<string, number>;
  bytes: Record<string, number>;
  sources: Record<string, string>;
}

export interface RegionMeta {
  index: number;
  fsLabel: number;
  name: string;
  color: [number, number, number];
  tissue: number;
  /** Anatomical grouping: frontal, temporal, basal ganglia, ventricle, ... */
  lobe: string;
  /** Dominant Yeo-2011 7-network, or "none" for non-cortical regions. */
  network: string;
  hemisphere: 'left' | 'right' | 'midline';
}

export interface LoadedField {
  manifest: FieldManifest;
  regions: RegionMeta[];
  /** Signed distance to the parenchyma surface, r8unorm, linearly filterable. */
  sdf: RawTexture3D;
  /** Dense region index per voxel, r8uint, nearest only. */
  labels: RawTexture3D;
  /** Signed distance to the ventricular system, 128^3. Meshed by Surface Nets. */
  ventricles: RawTexture3D;
  ventricleDim: number;
  /**
   * CPU copies of the distance and label volumes, retained after upload.
   *
   * The vascular tree is grown by space colonization, an iterative graph
   * algorithm that is awkward on the GPU and needs to know where the cortical
   * band is and which territory each point belongs to. ~18 MB held for the life
   * of the session, which is cheap next to the 84 MB of GPU fields.
   */
  sdfBytes: Uint8Array;
  labelBytes: Uint8Array;
  bytesTransferred: number;
  ms: number;
}

function url(base: string, file: string): string {
  return `${import.meta.env.BASE_URL}fields/${base}/${file}`;
}

/**
 * Fetch a `.gz` payload, inflating it only if it actually arrives compressed.
 *
 * Different servers disagree about what to do with a file named `*.gz`, and
 * both behaviours are common:
 *
 *   - Vite's dev server sets `Content-Encoding: gzip`, so the browser inflates
 *     it transparently and `arrayBuffer()` is already the plain payload.
 *   - GitHub Pages serves it as opaque binary, so we get the gzip stream and
 *     must inflate it ourselves.
 *
 * Trusting either one breaks on the other, and the failure is ugly:
 * double-inflating throws a bare `TypeError: Failed to fetch` that looks like a
 * network problem rather than an encoding one. So sniff the two-byte gzip magic
 * and decide from the bytes. Transport-independent, works everywhere.
 *
 * (Brotli would save another ~15%, but no browser exposes
 * DecompressionStream('br') and a WASM decoder costs more than it saves.)
 */
async function fetchMaybeGz(u: string): Promise<Uint8Array> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${u}`);
  const raw = new Uint8Array(await res.arrayBuffer());

  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return raw;
}

/**
 * The distance field is stored as int8 but uploaded as r8unorm.
 *
 * Two reasons. r8snorm is not guaranteed filterable across backends, and
 * Babylon's snorm mapping is one more unverified thing in a stack that already
 * had six. r8unorm is unambiguously filterable. Because the encoding is affine,
 * interpolating the unorm value and then decoding is identical to interpolating
 * the distance itself, so linear filtering stays exactly correct.
 */
function int8ToUnorm(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = (src[i] + 128) & 0xff;
  return out;
}

/**
 * Replace the anatomy of an already-loaded field in place.
 *
 * The textures keep their identity, so every material, compute pass and bind
 * group that already references them stays valid — swapping subjects by
 * rebuilding the scene would mean re-creating a dozen pipelines and losing the
 * camera. Only the CONTENTS change, which is safe precisely because an ingested
 * subject is built on the same 208^3 grid as the bundled one.
 *
 * The ventricle field is deliberately NOT replaced: it is a separate 128^3
 * distance field that the ingest path does not yet produce, so the ventricular
 * mesh continues to show the previous subject's. The caller is expected to hide
 * it rather than display anatomy from two different brains at once.
 */
export function replaceFieldAnatomy(
  field: LoadedField,
  sdfBytes: Uint8Array,
  labelBytes: Uint8Array
): void {
  const n = field.manifest.grid.dim;
  if (sdfBytes.length !== n * n * n || labelBytes.length !== n * n * n) {
    throw new Error(
      `ingested volume is ${Math.cbrt(sdfBytes.length) | 0}^3 but the field is ${n}^3`
    );
  }
  field.sdf.update(int8ToUnorm(sdfBytes));
  field.labels.update(labelBytes);
  field.sdfBytes.set(sdfBytes);
  field.labelBytes.set(labelBytes);
}

/**
 * Anatomy supplied by the user instead of fetched.
 *
 * The manifest, region table and ventricle field still come from the bundled
 * subject: an ingested `aparc+aseg` provides the parenchyma and the labels, and
 * everything else (grid geometry, region names, the ventricular distance field)
 * is either identical by construction or not yet derivable in-browser. Stated
 * here rather than discovered later.
 */
export interface FieldOverride {
  sdfBytes: Uint8Array;
  labelBytes: Uint8Array;
  label: string;
}

export async function loadField(
  scene: Scene,
  subject: string,
  dim: number,
  override?: FieldOverride
): Promise<LoadedField> {
  const t0 = performance.now();
  const base = `${subject}-${dim}`;

  const [manifest, regions] = await Promise.all([
    fetch(url(base, 'manifest.json')).then((r) => r.json() as Promise<FieldManifest>),
    fetch(url(base, 'regions.json')).then((r) => r.json() as Promise<RegionMeta[]>),
  ]);

  const n = manifest.grid.dim;
  const vn = manifest.ventricle.dim;
  const [sdfRaw, labelRaw, ventRaw] = await Promise.all([
    fetchMaybeGz(url(base, 'sdf_brain.i8.gz')),
    fetchMaybeGz(url(base, 'labels.u8.gz')),
    fetchMaybeGz(url(base, 'sdf_vent.i8.gz')),
  ]);

  const expected = n * n * n;
  if (ventRaw.length !== vn * vn * vn) {
    throw new Error(`ventricle sdf size ${ventRaw.length} != ${vn}^3`);
  }
  if (sdfRaw.length !== expected) {
    throw new Error(`sdf size ${sdfRaw.length} != ${n}^3 (${expected})`);
  }
  if (labelRaw.length !== expected) {
    throw new Error(`labels size ${labelRaw.length} != ${n}^3 (${expected})`);
  }

  // A user-supplied subject replaces the anatomy but reuses everything else,
  // so it flows through the identical upload path rather than a parallel one.
  const sdfSrc = override ? override.sdfBytes : sdfRaw;
  const labelSrc = override ? override.labelBytes : labelRaw;

  const sdf = new RawTexture3D(
    int8ToUnorm(sdfSrc),
    n,
    n,
    n,
    Constants.TEXTUREFORMAT_R,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE
  );
  sdf.wrapU = Texture.CLAMP_ADDRESSMODE;
  sdf.wrapV = Texture.CLAMP_ADDRESSMODE;
  sdf.wrapR = Texture.CLAMP_ADDRESSMODE;

  // Region indices must never be interpolated — halfway between region 3 and
  // region 7 is not region 5.
  const labels = new RawTexture3D(
    labelSrc,
    n,
    n,
    n,
    Constants.TEXTUREFORMAT_R,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE
  );
  labels.wrapU = Texture.CLAMP_ADDRESSMODE;
  labels.wrapV = Texture.CLAMP_ADDRESSMODE;
  labels.wrapR = Texture.CLAMP_ADDRESSMODE;

  const ventricles = new RawTexture3D(
    int8ToUnorm(ventRaw),
    vn,
    vn,
    vn,
    Constants.TEXTUREFORMAT_R,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE
  );
  ventricles.wrapU = Texture.CLAMP_ADDRESSMODE;
  ventricles.wrapV = Texture.CLAMP_ADDRESSMODE;
  ventricles.wrapR = Texture.CLAMP_ADDRESSMODE;

  return {
    manifest,
    regions,
    sdf,
    labels,
    ventricles,
    ventricleDim: vn,
    sdfBytes: sdfSrc,
    labelBytes: labelSrc,
    bytesTransferred: sdfRaw.length + labelRaw.length + ventRaw.length,
    ms: performance.now() - t0,
  };
}
