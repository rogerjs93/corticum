/**
 * Braak staging of Alzheimer neurofibrillary pathology.
 *
 * Braak H, Braak E. "Neuropathological stageing of Alzheimer-related changes."
 * Acta Neuropathol 1991;82:239-259.
 * Braak H, Braak E. "Staging of Alzheimer's disease-related neurofibrillary
 * changes." Neurobiol Aging 1995;16:271-278.
 *
 * The staging is the point. Alzheimer's does not thin the cortex uniformly — it
 * begins transentorhinally, spreads through limbic structures, and only reaches
 * neocortical association areas late, while **primary motor, primary
 * somatosensory and primary visual cortex are relatively spared until the very
 * end**. That sparing is diagnostic: an "atrophy" model that thinned
 * precentral gyrus at stage III would be visibly wrong to anyone who reads
 * scans, and would teach the wrong thing.
 *
 * Weights are relative severity per region (0..1) at each stage, applied to a
 * global severity in millimetres. They are `derived`, not `literature`: Braak
 * describes the ORDER and DISTRIBUTION of pathology, not millimetres of
 * cortical thinning, so the spatial pattern is faithful while the magnitude is
 * calibrated to produce plausible volume loss (see verifyVolumes).
 */

import type { Evidence } from './types';

/** FreeSurfer label ids, left/right pairs. */
const ENTORHINAL = [1006, 2006];
const PARAHIPPOCAMPAL = [1016, 2016];
const FUSIFORM = [1007, 2007];
const INFERIOR_TEMPORAL = [1009, 2009];
const ISTHMUS_CINGULATE = [1010, 2010];
const HIPPOCAMPUS = [17, 53];
const AMYGDALA = [18, 54];

const TEMPORAL_POLE = [1033, 2033];
const MIDDLE_TEMPORAL = [1015, 2015];
const SUPERIOR_TEMPORAL = [1030, 2030];
const INFERIOR_PARIETAL = [1008, 2008];
const SUPERIOR_PARIETAL = [1029, 2029];
const SUPRAMARGINAL = [1031, 2031];
const PRECUNEUS = [1025, 2025];
const SUPERIOR_FRONTAL = [1028, 2028];
const ROSTRAL_MIDDLE_FRONTAL = [1027, 2027];
const CAUDAL_MIDDLE_FRONTAL = [1003, 2003];
const POSTERIOR_CINGULATE = [1023, 2023];

/** Primary cortices — spared until stage VI. This is the diagnostic feature. */
const PRECENTRAL = [1024, 2024];
const POSTCENTRAL = [1022, 2022];
const PERICALCARINE = [1021, 2021];
const PARACENTRAL = [1017, 2017];

type WeightMap = Map<number, number>;

function add(m: WeightMap, labels: number[], w: number): void {
  for (const l of labels) m.set(l, Math.max(m.get(l) ?? 0, w));
}

/**
 * Relative atrophy weight per FreeSurfer label at a given Braak stage (1..6).
 * Stage 0 is a healthy brain.
 */
export function braakWeights(stage: number): WeightMap {
  const m: WeightMap = new Map();
  if (stage <= 0) return m;

  // I-II — transentorhinal and entorhinal.
  add(m, ENTORHINAL, Math.min(1, stage / 2) * 0.9);

  // III-IV — limbic. The hippocampus is the structure clinicians actually
  // measure, so it carries the strongest weight here.
  if (stage >= 3) {
    const t = Math.min(1, (stage - 2) / 2);
    add(m, ENTORHINAL, 1.0);
    add(m, HIPPOCAMPUS, t * 1.0);
    add(m, PARAHIPPOCAMPAL, t * 0.85);
    add(m, AMYGDALA, t * 0.7);
    add(m, FUSIFORM, t * 0.5);
    add(m, INFERIOR_TEMPORAL, t * 0.45);
    add(m, ISTHMUS_CINGULATE, t * 0.4);
    add(m, TEMPORAL_POLE, t * 0.5);
  }

  // V-VI — neocortical association areas.
  if (stage >= 5) {
    const t = Math.min(1, (stage - 4) / 2);
    add(m, MIDDLE_TEMPORAL, t * 0.7);
    add(m, SUPERIOR_TEMPORAL, t * 0.6);
    add(m, INFERIOR_PARIETAL, t * 0.7);
    add(m, SUPERIOR_PARIETAL, t * 0.5);
    add(m, SUPRAMARGINAL, t * 0.6);
    add(m, PRECUNEUS, t * 0.65);
    add(m, POSTERIOR_CINGULATE, t * 0.55);
    add(m, SUPERIOR_FRONTAL, t * 0.5);
    add(m, ROSTRAL_MIDDLE_FRONTAL, t * 0.55);
    add(m, CAUDAL_MIDDLE_FRONTAL, t * 0.45);
  }

  // VI only, and even then lightly: primary cortices are the last to go.
  if (stage >= 6) {
    add(m, PRECENTRAL, 0.18);
    add(m, POSTCENTRAL, 0.18);
    add(m, PERICALCARINE, 0.2);
    add(m, PARACENTRAL, 0.2);
  }

  return m;
}

/**
 * Behavioural-variant frontotemporal dementia.
 *
 * Frontal, anterior temporal, insula and anterior cingulate, characteristically
 * ASYMMETRIC, with knife-edge atrophy of the temporal pole. The asymmetry is
 * what distinguishes it at a glance from Alzheimer's.
 */
export function ftdWeights(severity: number, asymmetry = 0.45): WeightMap {
  const m: WeightMap = new Map();
  if (severity <= 0) return m;

  // Left labels are the odd-indexed entries here (1xxx = left, 2xxx = right).
  const sided = (labels: number[], w: number) => {
    m.set(labels[0], Math.max(m.get(labels[0]) ?? 0, w * (1 + asymmetry)));
    m.set(labels[1], Math.max(m.get(labels[1]) ?? 0, w * (1 - asymmetry)));
  };

  sided(TEMPORAL_POLE, 1.0);
  sided([1032, 2032], 0.85); // frontal pole
  sided(SUPERIOR_FRONTAL, 0.7);
  sided(ROSTRAL_MIDDLE_FRONTAL, 0.75);
  sided([1012, 2012], 0.8); // lateral orbitofrontal
  sided([1014, 2014], 0.75); // medial orbitofrontal
  sided([1018, 2018], 0.7); // pars opercularis
  sided([1019, 2019], 0.7); // pars orbitalis
  sided([1020, 2020], 0.7); // pars triangularis
  sided([1035, 2035], 0.8); // insula
  sided([1002, 2002], 0.7); // caudal anterior cingulate
  sided([1026, 2026], 0.7); // rostral anterior cingulate
  sided(SUPERIOR_TEMPORAL, 0.5);
  sided(MIDDLE_TEMPORAL, 0.45);

  for (const [k, v] of m) m.set(k, v * severity);
  return m;
}

export interface StagingInfo {
  label: string;
  detail: string;
  evidence: Evidence;
  citation: string;
}

export function braakInfo(stage: number): StagingInfo {
  const detail = [
    'no neurofibrillary pathology',
    'transentorhinal — clinically silent',
    'entorhinal — clinically silent',
    'limbic: hippocampus and parahippocampal gyrus involved',
    'limbic, established — memory impairment typically appears',
    'neocortical association areas; primary cortices still spared',
    'neocortical, widespread — primary motor/sensory/visual finally involved',
  ][Math.max(0, Math.min(6, stage))];
  return {
    label: stage === 0 ? 'none' : `Braak ${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][stage]}`,
    detail,
    // The spatial pattern follows the literature; the millimetres do not.
    evidence: 'derived',
    citation: 'Braak & Braak, Acta Neuropathol 1991; Neurobiol Aging 1995',
  };
}
