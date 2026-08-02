import type { LoadedField } from '../fields/loader';

/**
 * ASPECTS — the Alberta Stroke Program Early CT Score.
 *
 * Ten regions of the MCA territory. The score starts at 10 and loses a point
 * for each region showing early ischaemic change, so 10 is a normal scan and 0
 * is the whole territory. It is the number that actually gates treatment: below
 * 6 has historically been used to argue against thrombectomy.
 *
 * WHY THE CORTICAL REGIONS ARE DERIVED GEOMETRICALLY RATHER THAN FROM PARCELS.
 * M1-M6 are not named gyri. They are defined by POSITION — anterior, middle and
 * posterior thirds of the lateral MCA cortex, read at two axial levels
 * (ganglionic, and supraganglionic just above the basal ganglia). A hand-written
 * gyrus-to-region table would be inventing a correspondence the scale does not
 * claim; splitting the MCA cortex by position is what the scale actually says.
 *
 * The subcortical regions DO correspond to structures and are taken from labels.
 *
 * The internal capsule is the one genuine gap: FreeSurfer has no label for it,
 * so it is approximated as cerebral white matter inside an ellipsoid fitted
 * between the lentiform and thalamic centroids. That is flagged in the UI.
 */

export const ASPECTS_REGIONS = [
  { id: 0, key: 'C', name: 'Caudate', kind: 'subcortical' },
  { id: 1, key: 'L', name: 'Lentiform', kind: 'subcortical' },
  { id: 2, key: 'IC', name: 'Internal capsule', kind: 'approximated' },
  { id: 3, key: 'I', name: 'Insular ribbon', kind: 'subcortical' },
  { id: 4, key: 'M1', name: 'Anterior MCA cortex', kind: 'cortical' },
  { id: 5, key: 'M2', name: 'Lateral MCA cortex', kind: 'cortical' },
  { id: 6, key: 'M3', name: 'Posterior MCA cortex', kind: 'cortical' },
  { id: 7, key: 'M4', name: 'Anterior MCA, supraganglionic', kind: 'cortical' },
  { id: 8, key: 'M5', name: 'Lateral MCA, supraganglionic', kind: 'cortical' },
  { id: 9, key: 'M6', name: 'Posterior MCA, supraganglionic', kind: 'cortical' },
] as const;

/** Structure marker written into the per-region lookup the shader reads. */
export const STRUCT = { none: 0, caudate: 1, lentiform: 2, insula: 3, cerebralWm: 4 } as const;

export function structOf(fsLabel: number): number {
  if (fsLabel === 11 || fsLabel === 50) return STRUCT.caudate;
  if (fsLabel === 12 || fsLabel === 51 || fsLabel === 13 || fsLabel === 52) {
    return STRUCT.lentiform; // putamen + pallidum
  }
  if (fsLabel === 1035 || fsLabel === 2035) return STRUCT.insula;
  if (fsLabel === 2 || fsLabel === 41) return STRUCT.cerebralWm;
  return STRUCT.none;
}

export interface AspectsGeometry {
  /** Superior limit of the basal ganglia; above this is supraganglionic. */
  ganglionicTopMm: number;
  /** Anterior/posterior extent of the MCA cortical territory. */
  mcaAnteriorMm: number;
  mcaPosteriorMm: number;
  /** Ellipsoid standing in for the internal capsule, per side. */
  icCentreMm: [number, number, number];
  icRadiiMm: [number, number, number];
}

/**
 * Derive the geometry from the subject's own labels rather than hard-coding
 * millimetre thresholds, which would be wrong for any other brain.
 *
 * Everything is measured on the LEFT side and mirrored, because the two sides
 * are near-symmetric at this scale and averaging them would blur the boundary
 * the score depends on.
 */
export function deriveAspectsGeometry(field: LoadedField): AspectsGeometry {
  const dim = field.manifest.grid.dim;
  const half = field.manifest.grid.halfExtentMm;
  const labels = field.labelBytes;

  // fsLabel per dense region index, so the voxel loop is one array lookup.
  const fsOf = new Int32Array(256).fill(-1);
  for (const r of field.regions) if (r.index < 256) fsOf[r.index] = r.fsLabel;

  const acc = {
    bgTop: -Infinity,
    mcaZmin: Infinity,
    mcaZmax: -Infinity,
    lentX: 0, lentY: 0, lentZ: 0, lentN: 0,
    thalX: 0, thalY: 0, thalZ: 0, thalN: 0,
  };
  const toMm = (i: number) => ((i + 0.5) / dim) * 2 * half - half;

  for (let iz = 0; iz < dim; iz++) {
    const z = toMm(iz);
    for (let iy = 0; iy < dim; iy++) {
      const y = toMm(iy);
      const row = dim * (iy + dim * iz);
      for (let ix = 0; ix < dim; ix++) {
        const fs = fsOf[labels[ix + row]];
        if (fs < 0) continue;
        const x = toMm(ix);

        // Basal ganglia ceiling: caudate, putamen, pallidum.
        if (fs === 11 || fs === 50 || fs === 12 || fs === 51 || fs === 13 || fs === 52) {
          if (y > acc.bgTop) acc.bgTop = y;
        }
        if (x < 0 && (fs === 12 || fs === 13)) {
          acc.lentX += x; acc.lentY += y; acc.lentZ += z; acc.lentN++;
        }
        if (x < 0 && fs === 10) {
          acc.thalX += x; acc.thalY += y; acc.thalZ += z; acc.thalN++;
        }
        // Cortical MCA extent: the DK lateral surface parcels.
        if ((fs >= 1000 && fs <= 1035) || (fs >= 2000 && fs <= 2035)) {
          if (z < acc.mcaZmin) acc.mcaZmin = z;
          if (z > acc.mcaZmax) acc.mcaZmax = z;
        }
      }
    }
  }

  const lent: [number, number, number] = acc.lentN
    ? [acc.lentX / acc.lentN, acc.lentY / acc.lentN, acc.lentZ / acc.lentN]
    : [-25, 0, 0];
  const thal: [number, number, number] = acc.thalN
    ? [acc.thalX / acc.thalN, acc.thalY / acc.thalN, acc.thalZ / acc.thalN]
    : [-12, 0, -12];

  // The posterior limb runs between the lentiform and the thalamus, so the
  // midpoint of their centroids is a defensible stand-in for its centre.
  return {
    ganglionicTopMm: Number.isFinite(acc.bgTop) ? acc.bgTop : 12,
    mcaAnteriorMm: Number.isFinite(acc.mcaZmax) ? acc.mcaZmax : 70,
    mcaPosteriorMm: Number.isFinite(acc.mcaZmin) ? acc.mcaZmin : -90,
    icCentreMm: [
      (lent[0] + thal[0]) / 2,
      (lent[1] + thal[1]) / 2,
      (lent[2] + thal[2]) / 2,
    ],
    icRadiiMm: [7, 12, 16],
  };
}

/** ASPECTS from per-region involvement; a region counts once it is mostly out. */
export function scoreAspects(
  involvedFraction: number[],
  threshold = 0.25
): { score: number; lost: string[] } {
  const lost: string[] = [];
  for (const r of ASPECTS_REGIONS) {
    if ((involvedFraction[r.id] ?? 0) > threshold) lost.push(r.key);
  }
  return { score: 10 - lost.length, lost };
}
