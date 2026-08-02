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
