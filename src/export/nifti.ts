/**
 * Minimal NIfTI-1 writer.
 *
 * Enough to emit volumes and vector fields that FSL, ANTs, ITK and nibabel all
 * read without complaint. Written by hand rather than pulled from a library
 * because the whole format is one 348-byte header and this keeps the project's
 * dependency surface at zero for a file that will not change again.
 *
 * ORIENTATION IS THE PART THAT GOES WRONG. corticum's world axes are
 * X = Right, Y = Superior, Z = Anterior. NIfTI's canonical frame is RAS+:
 * X = Right, Y = Anterior, Z = Superior. Those differ by a Y/Z swap, which is an
 * ODD permutation — encoding it in the affine alone would give a
 * negative-determinant (left-handed) matrix that is legal but reads as
 * radiological convention and invites exactly the silent left-right flip this
 * project has already been bitten by once. So the data is PERMUTED into RAS on
 * write and the affine stays diagonal and positive. Boring beats clever here.
 */

const HEADER_BYTES = 348;
const VOX_OFFSET = 352;

/** NIfTI datatype codes. */
const DT_FLOAT32 = 16;
const DT_UINT8 = 2;

export interface NiftiOptions {
  /** Voxel size in mm (isotropic). */
  voxelMm: number;
  /** World-space coordinate of voxel (0,0,0) centre, in RAS mm. */
  originMm: [number, number, number];
  /** Free text stored in the header; truncated to 79 chars. */
  description?: string;
  /** NIfTI intent code — 1006 marks a displacement vector field. */
  intentCode?: number;
  /** Trailing vector components per voxel (3 for a displacement field). */
  components?: number;
}

/**
 * Build a NIfTI-1 file from a volume sampled on corticum's grid.
 *
 * `src` is indexed x-fastest in WORLD axes (X=R, Y=S, Z=A) with `components`
 * values interleaved per voxel. The output is permuted to RAS.
 */
export function writeNifti(
  src: Float32Array | Uint8Array,
  dim: number,
  opts: NiftiOptions
): ArrayBuffer {
  const comps = opts.components ?? 1;
  const isFloat = src instanceof Float32Array;
  const bytesPerValue = isFloat ? 4 : 1;
  const voxels = dim * dim * dim;
  if (src.length !== voxels * comps) {
    throw new Error(`expected ${voxels * comps} values, got ${src.length}`);
  }

  const dataBytes = voxels * comps * bytesPerValue;
  const buf = new ArrayBuffer(VOX_OFFSET + dataBytes);
  const view = new DataView(buf);
  const LE = true;

  view.setInt32(0, HEADER_BYTES, LE);

  // dim[0] is the number of dimensions in use. A vector field is 5-D in NIfTI's
  // convention: three spatial, one (unused) temporal, then the components.
  const ndim = comps > 1 ? 5 : 3;
  view.setInt16(40, ndim, LE);
  view.setInt16(42, dim, LE);
  view.setInt16(44, dim, LE);
  view.setInt16(46, dim, LE);
  view.setInt16(48, comps > 1 ? 1 : 1, LE); // dim[4] = time
  view.setInt16(50, comps > 1 ? comps : 1, LE); // dim[5] = components
  view.setInt16(52, 1, LE);
  view.setInt16(54, 1, LE);

  view.setInt16(68, opts.intentCode ?? 0, LE);
  view.setInt16(70, isFloat ? DT_FLOAT32 : DT_UINT8, LE);
  view.setInt16(72, isFloat ? 32 : 8, LE);

  // pixdim[0] is qfac; +1 keeps the qform right-handed, which it is now that
  // the data has been permuted rather than the axes flipped.
  view.setFloat32(76, 1, LE);
  view.setFloat32(80, opts.voxelMm, LE);
  view.setFloat32(84, opts.voxelMm, LE);
  view.setFloat32(88, opts.voxelMm, LE);
  view.setFloat32(92, 1, LE);

  view.setFloat32(108, VOX_OFFSET, LE);
  view.setFloat32(112, 1, LE); // scl_slope
  view.setFloat32(116, 0, LE); // scl_inter
  view.setInt8(123, 2 | 8); // xyzt_units: mm + sec

  const desc = (opts.description ?? 'corticum synthetic').slice(0, 79);
  for (let i = 0; i < desc.length; i++) view.setUint8(148 + i, desc.charCodeAt(i));

  // sform only. qform duplicates the same information in quaternion form and
  // the two disagreeing is a classic source of silent misregistration, so it is
  // deliberately left at 0 (unknown) rather than filled in approximately.
  view.setInt16(252, 0, LE); // qform_code = unknown
  view.setInt16(254, 2, LE); // sform_code = aligned to anatomical truth

  const [ox, oy, oz] = opts.originMm;
  const v = opts.voxelMm;
  // srow_x at 280, srow_y at 296, srow_z at 312 — four floats each, so the
  // translation column is at +12, NOT +16. Writing srow_z's offset to 328 puts
  // it in intent_name instead, and the file still loads: the affine just
  // silently has a zero where a -102 mm shift belongs.
  const SROW_X = 280;
  const SROW_Y = 296;
  const SROW_Z = 312;
  // Diagonal and positive, because the data is already RAS.
  view.setFloat32(SROW_X, v, LE);
  view.setFloat32(SROW_X + 12, ox, LE);
  view.setFloat32(SROW_Y + 4, v, LE);
  view.setFloat32(SROW_Y + 12, oy, LE);
  view.setFloat32(SROW_Z + 8, v, LE);
  view.setFloat32(SROW_Z + 12, oz, LE);

  view.setUint8(344, 0x6e); // 'n'
  view.setUint8(345, 0x2b); // '+'
  view.setUint8(346, 0x31); // '1'
  view.setUint8(347, 0);

  // Permute world (x=R, y=S, z=A) into RAS (i=R, j=A, k=S).
  //
  // NIfTI stores components as SEPARATE volumes (component-major), not
  // interleaved per voxel — getting this backwards produces a file that opens
  // fine and is quietly wrong, which is the worst kind of bug in this format.
  const out = isFloat
    ? new Float32Array(buf, VOX_OFFSET, voxels * comps)
    : new Uint8Array(buf, VOX_OFFSET, voxels * comps);

  for (let k = 0; k < dim; k++) {
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        // RAS (i,j,k) -> world (x=i, y=k, z=j)
        const srcVox = i + dim * (k + dim * j);
        const dstVox = i + dim * (j + dim * k);
        for (let c = 0; c < comps; c++) {
          out[dstVox + voxels * c] = src[srcVox * comps + c];
        }
      }
    }
  }

  return buf;
}

/**
 * Displacement vectors must be permuted like the grid AND have their components
 * reordered, because a vector's components live in the same frame its axes do.
 * Permuting the volume without permuting the vector is a bug that produces a
 * field pointing in a plausible but wrong direction.
 */
export function worldVectorsToRas(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]; // R stays R
    out[i + 1] = src[i + 2]; // A comes from world Z
    out[i + 2] = src[i + 1]; // S comes from world Y
  }
  return out;
}

export function downloadBlob(data: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
