import type { DiseasePatch, Evidence } from './types';

/**
 * Disease progression over time.
 *
 * Each scenario owns a time axis in the units that disease is actually
 * discussed in — years for neurodegeneration, hours for acute stroke, months
 * for a growing mass — and maps a point on that axis to a parameter set.
 *
 * A blunt honesty note that the UI repeats: the *sequence* of events in these
 * trajectories follows the literature, but the *rates* are population
 * averages at best and are wrong for any individual. Braak stages do not
 * advance on a schedule. Everything here is tagged accordingly.
 */

export interface Scenario {
  id: string;
  name: string;
  /** Units of the time axis. */
  unit: 'years' | 'months' | 'hours';
  tMax: number;
  /** Sensible playback speed, in time-units per real second. */
  playRate: number;
  evidence: Evidence;
  citation?: string;
  /** What the viewer should be looking for as time advances. */
  narrative: (t: number) => string;
  at(t: number): DiseasePatch;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Alzheimer's disease.
 *
 * Braak stage against time is deliberately non-linear: I-II can persist for
 * decades without symptoms, the limbic stages III-IV roughly coincide with
 * amnestic MCI, and V-VI with dementia. Modelled as a smooth ramp reaching
 * stage VI at about 15 years from the earliest detectable pathology, which is
 * far longer than the clinical course because most of it is preclinical.
 */
const alzheimers: Scenario = {
  id: 'alzheimers',
  name: "Alzheimer's disease",
  unit: 'years',
  tMax: 15,
  playRate: 1.2,
  evidence: 'plausible-approximation',
  citation: 'Braak & Braak 1991/1995 for the sequence; rates are illustrative',
  narrative: (t) => {
    if (t < 2) return 'transentorhinal — clinically silent, no visible atrophy';
    if (t < 5) return 'entorhinal cortex thinning; still asymptomatic';
    if (t < 8) return 'limbic stage — hippocampus involved, temporal horn widening';
    if (t < 12) return 'neocortical association areas; primary cortices still spared';
    return 'widespread — primary motor, sensory and visual finally involved';
  },
  at(t) {
    const y = clamp(t, 0, this.tMax);
    // Ramps to 6 at tMax, with an early plateau so the silent stages last.
    const stage = clamp(Math.pow(y / this.tMax, 0.85) * 6, 0, 6);
    return {
      neuro: {
        braakStage: stage,
        ftdSeverity: 0,
        ftdAsymmetry: 0.45,
        peakThinningMm: 2.2,
        nigralLoss: 0,
      },
    };
  },
};

/**
 * Behavioural-variant frontotemporal dementia.
 *
 * Younger onset and a faster course than AD, and asymmetric from early on —
 * the asymmetry is what distinguishes it at a glance.
 */
const ftd: Scenario = {
  id: 'ftd',
  name: 'Frontotemporal dementia (bvFTD)',
  unit: 'years',
  tMax: 10,
  playRate: 0.9,
  evidence: 'plausible-approximation',
  citation: 'distribution follows bvFTD imaging literature; rates illustrative',
  narrative: (t) => {
    if (t < 1.5) return 'earliest anterior temporal and orbitofrontal change';
    if (t < 4) return 'frontal and insular atrophy, already asymmetric';
    if (t < 7) return 'knife-edge temporal pole; marked frontal volume loss';
    return 'severe frontotemporal atrophy with relative posterior sparing';
  },
  at(t) {
    const y = clamp(t, 0, this.tMax);
    return {
      neuro: {
        braakStage: 0,
        ftdSeverity: clamp(y / this.tMax, 0, 1),
        // Asymmetry is present early and persists.
        ftdAsymmetry: 0.5,
        peakThinningMm: 2.6,
        nigralLoss: 0,
      },
    };
  },
};

/**
 * Parkinson's disease.
 *
 * Rendered as progressive loss of nigral neuromelanin rather than atrophy,
 * because structural MRI in PD is famously subtle and shrinking things would
 * misrepresent what the disease looks like. Motor symptoms appear only after
 * roughly half the nigral neurons are gone, which the narrative flags.
 */
const parkinsons: Scenario = {
  id: 'parkinsons',
  name: "Parkinson's disease",
  unit: 'years',
  tMax: 20,
  playRate: 1.6,
  evidence: 'plausible-approximation',
  citation: 'nigral cell loss precedes motor onset; magnitudes illustrative',
  narrative: (t) => {
    if (t < 4) return 'preclinical nigral cell loss — no motor signs yet';
    if (t < 7) return 'approaching the ~50-60% threshold for motor onset';
    if (t < 13) return 'established motor Parkinsonism; nigra visibly depigmented';
    return 'advanced nigral depigmentation';
  },
  at(t) {
    const y = clamp(t, 0, this.tMax);
    return {
      neuro: {
        braakStage: 0,
        ftdSeverity: 0,
        ftdAsymmetry: 0.45,
        peakThinningMm: 2.2,
        nigralLoss: clamp(y / this.tMax, 0, 1),
      },
    };
  },
};

/**
 * Relapsing-remitting multiple sclerosis.
 *
 * Lesion burden accumulates in steps rather than smoothly: each relapse adds
 * plaques that only partially resolve. Modelled as a staircase so scrubbing
 * time shows discrete events, which is closer to how the disease behaves than
 * a linear ramp.
 */
const ms: Scenario = {
  id: 'ms',
  name: 'Multiple sclerosis (relapsing-remitting)',
  unit: 'years',
  tMax: 20,
  playRate: 1.6,
  evidence: 'plausible-approximation',
  citation: 'periventricular distribution and Dawson finger orientation are anatomical; burden is illustrative',
  narrative: (t) => {
    if (t < 1) return 'first demyelinating event';
    if (t < 6) return 'relapsing course — periventricular plaques accumulating';
    if (t < 13) return 'confluent periventricular disease; Dawson fingers evident';
    return 'high lesion burden with callosal thinning';
  },
  at(t) {
    const y = clamp(t, 0, this.tMax);
    // Staircase: roughly one relapse every ~1.6 years, partially remitting.
    const relapses = Math.floor(y / 1.6);
    const withinStep = (y % 1.6) / 1.6;
    const burden = clamp((relapses + withinStep * 0.35) / 12, 0, 1);
    return {
      ms: {
        enabled: y > 0.15,
        load: burden,
        periventricularBias: 1,
        fingerAspect: 3,
      },
    };
  },
};

/**
 * A growing intra-axial mass.
 *
 * Volume grows roughly exponentially while edema tracks the growth rate rather
 * than the size — which is why a fast-growing lesion produces more mass effect
 * than a larger indolent one.
 */
const mass: Scenario = {
  id: 'mass',
  name: 'Intra-axial mass lesion',
  unit: 'months',
  tMax: 24,
  playRate: 2.5,
  evidence: 'plausible-approximation',
  citation: 'growth and edema behaviour are illustrative, not a validated tumour model',
  narrative: (t) => {
    if (t < 3) return 'small lesion, no appreciable mass effect';
    if (t < 9) return 'peritumoral edema tracking along white matter';
    if (t < 16) return 'ventricular compression; midline beginning to shift';
    return 'substantial mass effect and midline shift';
  },
  at(t) {
    const m = clamp(t, 0, this.tMax);
    const f = m / this.tMax;
    return {
      mass: {
        enabled: m > 0.3,
        centre: [28, 18, 22],
        radiusMm: 6 + 26 * Math.pow(f, 0.8),
        edemaExtentMm: 8 + 22 * f,
        edemaStrength: clamp(0.4 + f, 0, 1.2),
        necrosis: clamp(0.25 + 0.45 * f, 0, 0.8),
        kind: 'tumour',
        hoursSinceIctus: 0,
      },
    };
  },
};

/**
 * Acute ischemic stroke.
 *
 * The only scenario here whose course is not monotonic. Cytotoxic edema builds
 * over the first two to three days, peaks at 48-72 h — the window in which
 * malignant MCA infarction kills — then resolves over the following week. Only
 * after roughly three weeks does the core cavitate and the tissue retreat,
 * which is why late imaging shows a defect rather than a mass.
 *
 * Swelling is delivered through the VELOCITY field (it is genuine displacement)
 * and cavitation through the OFFSET field (it is tissue loss). That distinction
 * is the same one that separates mass effect from atrophy everywhere else.
 */
const stroke: Scenario = {
  id: 'stroke',
  name: 'Ischemic stroke (MCA)',
  unit: 'hours',
  tMax: 720,
  playRate: 40,
  evidence: 'plausible-approximation',
  citation:
    'core/penumbra thresholds follow the DEFUSE-3 / DAWN framing; edema time ' +
    'course from malignant MCA infarction literature; magnitudes illustrative',
  narrative: (t) => {
    if (t < 1) return 'occlusion — perfusion lost, tissue still viable';
    if (t < 6) return 'core forming; penumbra still salvageable — thrombectomy window';
    if (t < 24) return 'core growing into the penumbra; early parenchymal change';
    if (t < 48) return 'cytotoxic edema building; sulcal effacement';
    if (t < 96) return 'peak swelling (48–72 h) — the window for malignant infarction';
    if (t < 240) return 'edema resolving; mass effect receding';
    if (t < 500) return 'subacute — the infarct is established';
    return 'chronic cavitation with ex-vacuo change';
  },
  at(t) {
    const h = clamp(t, 0, this.tMax);
    // Edema rises to a 48-72 h peak, then resolves by roughly day 10.
    const rise = clamp(h / 56, 0, 1);
    const fall = 1 - clamp((h - 72) / 168, 0, 1);
    const swell = Math.min(rise, fall);
    return {
      stroke: {
        enabled: h > 0.05,
        site: 'm1',
        collateralGrade: 1.5,
        hoursSinceOnset: h,
        recanalisationHour: Number.POSITIVE_INFINITY,
        side: 'left',
      },
      // Swelling reuses the mass-effect machinery: a region of the brain has
      // gained volume, which is exactly what the incompressible expansion field
      // already models.
      mass: {
        enabled: swell > 0.02,
        centre: [-34, 6, 6],
        radiusMm: 10 + 26 * swell,
        edemaExtentMm: 26,
        edemaStrength: 1.1 * swell,
        necrosis: 0.12,
        // Cytotoxic swelling, not blood.
        kind: 'tumour',
        hoursSinceIctus: 0,
      },
    };
  },
};

/**
 * Intracerebral haemorrhage.
 *
 * The other half of "stroke", and the half a CT exists to rule out: about 15%
 * of strokes are bleeds, and giving thrombolysis to one is catastrophic. Which
 * is why the timeline here starts at minutes — the diagnosis is made in the
 * first scan, not over days.
 *
 * Volume is the dominant predictor of outcome and the reason haematoma
 * EXPANSION matters: a third of these grow in the first hours, and that growth
 * is the main thing acute treatment tries to prevent.
 */
const ich: Scenario = {
  id: 'ich',
  name: 'Intracerebral haemorrhage',
  unit: 'hours',
  tMax: 336, // two weeks, enough to watch the CT signal fade
  playRate: 24,
  evidence: 'plausible-approximation',
  citation:
    'Volume/expansion framing after Broderick et al. 1993 and the ' +
    'INTERACT/ATACH blood-pressure trials; signal evolution is textbook.',
  narrative(t) {
    if (t < 1) return 'hyperacute: hyperdense on CT within minutes — this is the finding that excludes thrombolysis';
    if (t < 6) return 'haematoma expansion; volume is the dominant predictor of outcome';
    if (t < 24) return 'expansion plateaus; mass effect and midline shift develop';
    if (t < 72) return 'perihaematomal oedema; still bright on CT, now DARK on T2';
    if (t < 168) return 'subacute: bright on T1 as methaemoglobin forms, while CT fades';
    return 'chronic: CT isodense, a hemosiderin rim that will persist for life';
  },
  at(t) {
    const h = clamp(t, 0, this.tMax);
    // A deep ganglionic bleed — the commonest hypertensive site, and the one
    // whose mass effect on the internal capsule causes the dense hemiplegia.
    return {
      mass: {
        enabled: h > 0.01,
        centre: [30, 34, 6],
        radiusMm: 16,
        // Perihaematomal oedema builds over days rather than being present at
        // once, which is why the lesion keeps growing after the bleeding stops.
        edemaExtentMm: 6 + 16 * clamp(h / 96, 0, 1),
        edemaStrength: 0.9 * clamp(h / 72, 0, 1),
        necrosis: 0.85,
        kind: 'haemorrhage',
        hoursSinceIctus: h,
        // Lobulated from the start; an irregular margin is itself a sign.
        irregularity: 0.55,
        // Left putamen — the classic hypertensive site. Confining the clot to
        // it is what makes the bleed look like a putaminal haemorrhage rather
        // than a ball centred near one.
        targetRegion: -1,
        // Fresh clot is dense; it liquefies over the following fortnight.
        density: 1 - 0.35 * clamp((h - 168) / 336, 0, 1),
      },
    };
  },
};

export const SCENARIOS: Scenario[] = [alzheimers, ftd, parkinsons, ms, mass, stroke, ich];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Everything a scenario does not set must be reset, or states leak between runs. */
export function baselineForScenario(): DiseasePatch {
  return {
    globalAtrophyMm: 0,
    neuro: {
      braakStage: 0,
      ftdSeverity: 0,
      ftdAsymmetry: 0.45,
      peakThinningMm: 2.2,
      nigralLoss: 0,
    },
    ms: { enabled: false, load: 0.5, periventricularBias: 1, fingerAspect: 3 },
    mass: {
      enabled: false,
      centre: [28, 18, 22],
      radiusMm: 18,
      edemaExtentMm: 22,
      edemaStrength: 1,
      necrosis: 0.55,
      kind: 'tumour',
      hoursSinceIctus: 0,
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
