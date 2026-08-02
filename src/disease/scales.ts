import type { RegionMeta } from '../fields/loader';

/**
 * Clinical visual rating scales, derived from measured volume.
 *
 * These scales are what a radiologist actually writes in a report — "MTA 3,
 * Fazekas 2" — and no teaching tool computes them live, so a student sees a
 * picture of atrophy without knowing what it would be CALLED. That gap is the
 * whole reason for this file.
 *
 * IMPORTANT CAVEAT, and it is not a small one. The published scales are VISUAL
 * judgements made on a specific plane against reference figures: Scheltens MTA
 * grades the height of the hippocampal formation and the widths of the choroid
 * fissure and temporal horn on a coronal slice; GCA grades sulcal widening
 * quadrant by quadrant. What follows maps measured VOLUME LOSS onto those
 * grades instead, because volume is what this model actually knows. The cut
 * points below are chosen to put the grades in roughly the right order of
 * magnitude — they are `plausible-approximation`, not validated thresholds, and
 * a grade from here would not agree with a radiologist on any given brain.
 */

export interface ScaleResult {
  key: string;
  name: string;
  grade: number;
  max: number;
  /** The measurement the grade was derived from. */
  basis: string;
  interpretation: string;
}

function band(value: number, cuts: number[]): number {
  let g = 0;
  for (const c of cuts) if (value >= c) g++;
  return g;
}

const MTA_INTERP = [
  'normal',
  'widened choroid fissure only',
  'also widened temporal horn',
  'moderate hippocampal volume loss',
  'severe hippocampal volume loss',
];

const GCA_INTERP = [
  'no cortical atrophy',
  'mild — sulcal widening',
  'moderate — gyral volume loss',
  'severe — knife-blade atrophy',
];

const FAZEKAS_INTERP = [
  'none or a single punctate focus',
  'punctate foci',
  'beginning confluence of foci',
  'large confluent areas',
];

/**
 * Medial temporal atrophy, from hippocampal volume against the healthy baseline.
 *
 * Age matters: MTA 2 is abnormal below 75 but common above it. That comparison
 * needs normative data this project does not ship, so the grade is reported
 * without an age adjustment and must not be read as "abnormal".
 */
export function mtaScale(hippocampalLossPct: number): ScaleResult {
  return {
    key: 'MTA',
    name: 'Medial temporal atrophy (Scheltens)',
    grade: band(hippocampalLossPct, [5, 15, 30, 45]),
    max: 4,
    basis: `hippocampal volume ${hippocampalLossPct.toFixed(1)}% below baseline`,
    interpretation: MTA_INTERP[band(hippocampalLossPct, [5, 15, 30, 45])],
  };
}

/** Global cortical atrophy, from whole-brain parenchymal loss. */
export function gcaScale(brainLossPct: number): ScaleResult {
  const g = band(brainLossPct, [3, 8, 15]);
  return {
    key: 'GCA',
    name: 'Global cortical atrophy',
    grade: g,
    max: 3,
    basis: `parenchymal volume ${brainLossPct.toFixed(1)}% below baseline`,
    interpretation: GCA_INTERP[g],
  };
}

/**
 * Fazekas, from demyelinating lesion load.
 *
 * The weakest of the four by some distance. Fazekas grades small-vessel white
 * matter hyperintensities; the only white-matter lesion this model has is the
 * MS plaque field, which is a different disease with a different distribution
 * (periventricular and radial along the medullary veins, rather than diffuse
 * and confluent). Read it as "how much white matter lesion is present", not as
 * a small-vessel disease grade.
 */
export function fazekasScale(plaqueLoad: number): ScaleResult {
  const g = band(plaqueLoad, [0.15, 0.4, 0.7]);
  return {
    key: 'Fazekas',
    name: 'White matter lesion load (Fazekas-like)',
    grade: g,
    max: 3,
    basis: `demyelination load ${(plaqueLoad * 100).toFixed(0)}%`,
    interpretation: FAZEKAS_INTERP[g],
  };
}

/** Sum hippocampal volume across both hemispheres from a by-label map. */
export function hippocampalVolume(v: Map<number, number>): number {
  return (v.get(17) ?? 0) + (v.get(53) ?? 0);
}

/** Total parenchyma, excluding CSF spaces, from a by-label map. */
export function parenchymalVolume(v: Map<number, number>, regions: RegionMeta[]): number {
  const csf = new Set<number>();
  for (const r of regions) {
    // tissue class 1 is csf_ventricle in the shipped manifest.
    if (r.tissue === 1) csf.add(r.fsLabel);
  }
  let total = 0;
  for (const [label, mm3] of v) if (!csf.has(label)) total += mm3;
  return total;
}
