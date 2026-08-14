/**
 * NIfTI-1 / NIfTI-2 reader.
 *
 * The counterpart to `export/nifti.ts`, and deliberately a separate file: the
 * writer emits one narrow shape it fully controls, while a reader has to cope
 * with whatever a real tool produced — either NIfTI version, either endianness,
 * six datatypes, an arbitrary affine, and gzip.
 *
 * Scope is what corticum actually needs to ingest a FreeSurfer subject: the
 * voxel data, the voxel-to-world affine, and enough header to know how to
 * interpret both. No extensions, no time series, no complex types.
 */

export interface NiftiVolume {
  /** Voxel counts, x fastest. */
  dims: [number, number, number];
  /** Voxel size in mm. */
  pixdim: [number, number, number];
  /** 4x4 voxel -> world (RAS) affine, row-major. */
  affine: Float32Array;
  /** Scalar data, one value per voxel, already scaled by scl_slope/inter. */
  data: Float32Array;
  datatypeName: string;
  description: string;
}

const DT = new Map<number, { size: number; name: string }>([
  [2, { size: 1, name: 'uint8' }],
  [4, { size: 2, name: 'int16' }],
  [8, { size: 4, name: 'int32' }],
  [16, { size: 4, name: 'float32' }],
  [64, { size: 8, name: 'float64' }],
  [256, { size: 1, name: 'int8' }],
  [512, { size: 2, name: 'uint16' }],
  [768, { size: 4, name: 'uint32' }],
]);

/** Inflate if the two-byte gzip magic is present. */
async function maybeGunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Read a NIfTI file.
 *
 * Endianness is detected from the header-size field rather than assumed:
 * `sizeof_hdr` is 348 (NIfTI-1) or 540 (NIfTI-2), so if it reads as neither in
 * little-endian, the file is big-endian. Guessing wrong here does not throw —
 * it silently yields a volume of nonsense — which is why it is checked rather
 * than defaulted.
 */
export async function readNifti(input: ArrayBuffer | Blob): Promise<NiftiVolume> {
  const raw = input instanceof Blob ? await input.arrayBuffer() : input;
  const buf = await maybeGunzip(raw);
  const view = new DataView(buf);

  const sizeLE = view.getInt32(0, true);
  let little = true;
  let v2 = false;
  if (sizeLE === 348) {
    little = true;
  } else if (sizeLE === 540) {
    little = true;
    v2 = true;
  } else {
    const sizeBE = view.getInt32(0, false);
    if (sizeBE === 348) {
      little = false;
    } else if (sizeBE === 540) {
      little = false;
      v2 = true;
    } else {
      throw new Error(
        `not a NIfTI file (header size reads ${sizeLE} / ${sizeBE}, expected 348 or 540)`
      );
    }
  }

  // NIfTI-2 widens dim/pixdim to 64-bit and moves everything after them, so the
  // field offsets differ throughout. Only the fields we need are mapped.
  const off = v2
    ? { datatype: 12, bitpix: 14, dim: 16, sclSlope: 176, sclInter: 184, voxOffset: 168, srow: 400, descrip: 344, pixdim: 104 }
    : { datatype: 70, bitpix: 72, dim: 40, sclSlope: 112, sclInter: 116, voxOffset: 108, srow: 280, descrip: 148, pixdim: 76 };

  const readDim = (i: number) =>
    v2 ? Number(view.getBigInt64(off.dim + i * 8, little)) : view.getInt16(off.dim + i * 2, little);
  const readPix = (i: number) =>
    v2 ? view.getFloat64(off.pixdim + i * 8, little) : view.getFloat32(off.pixdim + i * 4, little);

  const nd = readDim(0);
  if (nd < 3) throw new Error(`expected a 3-D volume, got ${nd} dimensions`);
  const dims: [number, number, number] = [readDim(1), readDim(2), readDim(3)];
  const pixdim: [number, number, number] = [readPix(1), readPix(2), readPix(3)];

  const datatype = view.getInt16(off.datatype, little);
  const dt = DT.get(datatype);
  if (!dt) throw new Error(`unsupported NIfTI datatype ${datatype}`);

  const voxOffset = v2
    ? Number(view.getBigInt64(off.voxOffset, little))
    : view.getFloat32(off.voxOffset, little);

  let slope = v2 ? view.getFloat64(off.sclSlope, little) : view.getFloat32(off.sclSlope, little);
  const inter = v2 ? view.getFloat64(off.sclInter, little) : view.getFloat32(off.sclInter, little);
  // A zero slope means "no scaling", not "multiply everything by zero" — a
  // literal reading blanks the volume.
  if (slope === 0) slope = 1;

  const n = dims[0] * dims[1] * dims[2];
  const need = voxOffset + n * dt.size;
  if (need > buf.byteLength) {
    throw new Error(
      `file is truncated: need ${need} bytes for ${dims.join('x')} ${dt.name}, have ${buf.byteLength}`
    );
  }

  const data = new Float32Array(n);
  const base = voxOffset;
  for (let i = 0; i < n; i++) {
    const p = base + i * dt.size;
    let v: number;
    switch (datatype) {
      case 2: v = view.getUint8(p); break;
      case 256: v = view.getInt8(p); break;
      case 4: v = view.getInt16(p, little); break;
      case 512: v = view.getUint16(p, little); break;
      case 8: v = view.getInt32(p, little); break;
      case 768: v = view.getUint32(p, little); break;
      case 16: v = view.getFloat32(p, little); break;
      default: v = view.getFloat64(p, little); break;
    }
    data[i] = v * slope + inter;
  }

  // sform if present, else fall back to a diagonal from pixdim. qform is not
  // read: it duplicates the same mapping in quaternion form, and where the two
  // disagree sform is the one tools honour.
  const affine = new Float32Array(16);
  const readSrow = (r: number, c: number) =>
    v2
      ? view.getFloat64(off.srow + (r * 4 + c) * 8, little)
      : view.getFloat32(off.srow + (r * 4 + c) * 4, little);
  const sformCode = v2 ? view.getInt32(348, little) : view.getInt16(254, little);
  if (sformCode > 0) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) affine[r * 4 + c] = readSrow(r, c);
    }
  } else {
    affine[0] = pixdim[0];
    affine[5] = pixdim[1];
    affine[10] = pixdim[2];
    // Centre the volume, which is the best guess available without a header.
    affine[3] = (-dims[0] / 2) * pixdim[0];
    affine[7] = (-dims[1] / 2) * pixdim[1];
    affine[11] = (-dims[2] / 2) * pixdim[2];
  }
  affine[15] = 1;

  let description = '';
  for (let i = 0; i < 80; i++) {
    const ch = view.getUint8(off.descrip + i);
    if (ch === 0) break;
    description += String.fromCharCode(ch);
  }

  return { dims, pixdim, affine, data, datatypeName: dt.name, description };
}

/** Apply a row-major 4x4 affine to a voxel index. */
export function applyAffine(
  a: Float32Array,
  i: number,
  j: number,
  k: number
): [number, number, number] {
  return [
    a[0] * i + a[1] * j + a[2] * k + a[3],
    a[4] * i + a[5] * j + a[6] * k + a[7],
    a[8] * i + a[9] * j + a[10] * k + a[11],
  ];
}
