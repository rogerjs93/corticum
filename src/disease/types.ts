/**
 * Provenance of a parameter or behaviour.
 *
 * Every control the UI exposes carries one of these, because a teaching tool
 * that cannot distinguish "this is what the literature says" from "this looks
 * about right" is worse than no teaching tool. Anything tagged
 * `plausible-approximation` must say so where the user can see it.
 */
export type Evidence = 'literature' | 'derived' | 'plausible-approximation';

export interface MassLesionState {
  enabled: boolean;
  /** Centre in world millimetres: X = right, Y = superior, Z = anterior. */
  centre: [number, number, number];
  radiusMm: number;
  /** How far vasogenic edema reaches beyond the lesion margin. */
  edemaExtentMm: number;
  edemaStrength: number;
  /** Fraction of the radius the lesion claims as its own volume. */
  necrosis: number;
  /**
   * What the lesion is MADE of.
   *
   * Geometrically a haematoma and a tumour are the same operator — a
   * space-occupying mass that displaces tissue — so they share the velocity and
   * offset fields rather than duplicating them. What differs is the tissue
   * type, and therefore how the lesion looks on each modality and how fast it
   * evolves. A tumour grows over months; a haematoma is hyperdense on CT within
   * minutes, expands over hours, and changes MRI signal over weeks as
   * haemoglobin degrades.
   */
  kind: 'tumour' | 'haemorrhage';
  /**
   * How lobulated the clot margin is. 0 is a perfect sphere, which is what a
   * haematoma never is — an irregular margin is itself a radiological sign,
   * predicting expansion.
   */
  irregularity: number;
  /**
   * Dense region index to confine the bleed to, or -1 for a free-floating
   * mass. A putaminal bleed should look like a putamen, not like a ball that
   * happens to be centred on one.
   */
  targetRegion: number;
  /**
   * Clot density 0..1. Drives how hyperdense it reads and how completely it
   * claims the space it occupies — a loose, partly-liquid collection is both
   * less bright and less space-occupying than an organised clot.
   */
  density: number;
  /**
   * Hours since ictus, for a haemorrhage. Drives haematoma expansion and the
   * blood-degradation signal; ignored when `kind` is 'tumour', which uses the
   * scenario timeline in months instead.
   */
  hoursSinceIctus: number;
}

export interface NeurodegenerationState {
  /** 0 = healthy, 1..6 = Braak stage. */
  braakStage: number;
  /** Behavioural-variant FTD severity, 0..1. */
  ftdSeverity: number;
  /** FTD left/right asymmetry, 0..1. */
  ftdAsymmetry: number;
  /**
   * Peak cortical thinning in mm at weight 1.0. Cortical thickness is ~2.5 mm
   * and severe AD thins association cortex by roughly 0.5 mm, so ~1 mm at full
   * regional weight puts the extremes in the right neighbourhood.
   */
  peakThinningMm: number;
  /** @see verifyStaging — calibrated so Braak VI lands in a plausible range. */
  /** Parkinson nigral depigmentation, 0..1. Rendered as pigment loss, not atrophy. */
  nigralLoss: number;
}

export interface DemyelinationState {
  enabled: boolean;
  /** Overall lesion burden, 0..1. */
  load: number;
  /** How strongly lesions hug the ventricular surface. */
  periventricularBias: number;
  /** Elongation of each lesion along the medullary-vein direction. */
  fingerAspect: number;
}

export interface StrokeState {
  enabled: boolean;
  /** Occlusion site id, see OCCLUSION_SITES. */
  site: string;
  /** Leptomeningeal collateral grade, 0 (none) .. 3 (excellent). */
  collateralGrade: number;
  /** Hours since symptom onset. */
  hoursSinceOnset: number;
  /** Hour at which flow was restored; Infinity for no recanalisation. */
  recanalisationHour: number;
  /** Which hemisphere the occlusion is on. */
  side: 'left' | 'right';
  /**
   * Several simultaneous occlusions, each with its own side. Patient presets
   * need this: a real stroke_qeeg record routinely names lesions in more than
   * one territory, sometimes in both hemispheres. When empty, `site` + `side`
   * are used, so ordinary single-site selection is unaffected.
   */
  lesions?: Array<{ site: string; side: 'left' | 'right' }>;
}

export interface DiseaseState {
  /** Uniform cortical thinning in mm, independent of any staging. */
  globalAtrophyMm: number;
  mass: MassLesionState;
  neuro: NeurodegenerationState;
  ms: DemyelinationState;
  stroke: StrokeState;
}

/**
 * A partial update to the disease state.
 *
 * `Partial<DiseaseState>` is not enough: it makes the top-level keys optional
 * but still demands a COMPLETE nested state, so every scenario literal had to
 * be rewritten each time a field was added to MassLesionState — which happened
 * twice and broke the build both times. `applyDisease` merges with
 * Object.assign, so partial nested states were always correct at runtime; only
 * the type was lying.
 */
export type DiseasePatch = {
  globalAtrophyMm?: number;
  mass?: Partial<MassLesionState>;
  neuro?: Partial<NeurodegenerationState>;
  ms?: Partial<DemyelinationState>;
  stroke?: Partial<StrokeState>;
};

export function defaultDiseaseState(): DiseaseState {
  return {
    globalAtrophyMm: 0,
    mass: {
      enabled: false,
      // Right frontal white matter — a common site, and far enough from the
      // midline that shift develops progressively rather than immediately.
      centre: [28, 18, 22],
      radiusMm: 18,
      edemaExtentMm: 22,
      edemaStrength: 1,
      necrosis: 0.55,
      kind: 'tumour',
      hoursSinceIctus: 6,
      irregularity: 0,
      targetRegion: -1,
      density: 1,
    },
    neuro: {
      braakStage: 0,
      ftdSeverity: 0,
      ftdAsymmetry: 0.45,
      peakThinningMm: 2.2,
      nigralLoss: 0,
    },
    ms: {
      enabled: false,
      load: 0.5,
      periventricularBias: 1,
      fingerAspect: 3,
    },
    stroke: {
      enabled: false,
      site: 'm1',
      collateralGrade: 1.5,
      hoursSinceOnset: 6,
      recanalisationHour: Number.POSITIVE_INFINITY,
      side: 'left',
    },
  };
}

/** True when nothing is altering the anatomy. */
export function isNullState(s: DiseaseState): boolean {
  return (
    s.globalAtrophyMm === 0 &&
    !s.mass.enabled &&
    s.neuro.braakStage === 0 &&
    s.neuro.ftdSeverity === 0 &&
    s.neuro.nigralLoss === 0 &&
    !s.ms.enabled &&
    !s.stroke.enabled
  );
}
