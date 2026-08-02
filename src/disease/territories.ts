/**
 * Arterial territories, mapped from FreeSurfer parcels.
 *
 * There is no arterial territory atlas in the payload — aseg and aparc describe
 * anatomy, not vascular supply — so this is a hand-authored assignment of each
 * parcel to the artery that principally supplies it. It follows standard
 * neuroanatomy and is citable, but it is an ASSIGNMENT, not a measurement, and
 * the UI says so: territories are tagged `plausible-approximation`, not
 * `literature`.
 *
 * What it is NOT: a validated vascular atlas (e.g. Liu et al. 2023). Real
 * territories vary between individuals, boundaries are fuzzy, and a parcel can
 * straddle two supplies. The value here is that the *pattern* of an M1
 * occlusion looks like an MCA infarct rather than like a sphere.
 *
 * The watershed zones are the part that is genuinely derived: nothing in this
 * table marks a border zone. They appear because the perfusion field is a
 * smoothed territory membership, so wherever two territories meet neither
 * reaches full value — which is exactly why border-zone infarcts happen.
 */

export const TERRITORY = {
  none: 0,
  /** Anterior cerebral — medial frontal and parietal. */
  aca: 1,
  /** MCA superior division — frontal operculum, rolandic, superior parietal. */
  mcaSuperior: 2,
  /** MCA inferior division — temporal and inferior parietal. */
  mcaInferior: 3,
  /** Lenticulostriate perforators — striatum, pallidum, internal capsule. */
  mcaDeep: 4,
  /** Posterior cerebral, cortical branches — occipital and inferomedial temporal. */
  pcaCortical: 5,
  /** Thalamoperforators. */
  pcaPerforating: 6,
  /** Anterior choroidal — medial temporal, choroid plexus, posterior limb. */
  anteriorChoroidal: 7,
  /** Cerebellar arteries (SCA / AICA / PICA lumped). */
  cerebellar: 8,
  /** Basilar perforators — pons and midbrain. */
  basilarPerforators: 9,
} as const;

export type TerritoryId = (typeof TERRITORY)[keyof typeof TERRITORY];

export interface TerritoryInfo {
  id: TerritoryId;
  name: string;
  short: string;
  /** Typical clinical syndrome, for the teaching panel. */
  syndrome: string;
}

export const TERRITORY_INFO: TerritoryInfo[] = [
  { id: TERRITORY.none, name: 'unassigned', short: '—', syndrome: '' },
  {
    id: TERRITORY.aca,
    name: 'Anterior cerebral artery',
    short: 'ACA',
    syndrome: 'contralateral leg-predominant weakness, abulia',
  },
  {
    id: TERRITORY.mcaSuperior,
    name: 'MCA — superior division',
    short: 'MCA sup',
    syndrome: 'face/arm-predominant weakness, Broca aphasia if dominant',
  },
  {
    id: TERRITORY.mcaInferior,
    name: 'MCA — inferior division',
    short: 'MCA inf',
    syndrome: 'Wernicke aphasia if dominant, visual field cut, neglect if not',
  },
  {
    id: TERRITORY.mcaDeep,
    name: 'Lenticulostriate perforators',
    short: 'MCA deep',
    syndrome: 'pure motor hemiparesis from internal capsule involvement',
  },
  {
    id: TERRITORY.pcaCortical,
    name: 'PCA — cortical branches',
    short: 'PCA ctx',
    syndrome: 'homonymous hemianopia with macular sparing, alexia',
  },
  {
    id: TERRITORY.pcaPerforating,
    name: 'Thalamoperforators',
    short: 'PCA perf',
    syndrome: 'pure sensory stroke, thalamic pain syndrome',
  },
  {
    id: TERRITORY.anteriorChoroidal,
    name: 'Anterior choroidal artery',
    short: 'AChA',
    syndrome: 'hemiparesis, hemianaesthesia and hemianopia together',
  },
  {
    id: TERRITORY.cerebellar,
    name: 'Cerebellar arteries',
    short: 'SCA/AICA/PICA',
    syndrome: 'ataxia, vertigo, nystagmus; risk of fourth-ventricle compression',
  },
  {
    id: TERRITORY.basilarPerforators,
    name: 'Basilar perforators',
    short: 'basilar perf',
    syndrome: 'crossed deficits, ocular motor palsies, locked-in if extensive',
  },
];

/** Cortical parcel offsets (add 1000 for left, 2000 for right). */
const ACA_CTX = [14, 17, 28, 26, 2, 32, 24];
// medialorbitofrontal, paracentral, superiorfrontal, rostralanteriorcingulate,
// caudalanteriorcingulate, frontalpole, precentral(medial strip — assigned to
// MCA below, ACA only takes the paracentral portion)

const MCA_SUP_CTX = [3, 18, 19, 20, 22, 24, 27, 29, 31, 12];
// caudalmiddlefrontal, parsopercularis, parsorbitalis, parstriangularis,
// postcentral, precentral, rostralmiddlefrontal, superiorparietal,
// supramarginal, lateralorbitofrontal

const MCA_INF_CTX = [1, 8, 9, 15, 30, 33, 34, 35];
// bankssts, inferiorparietal, inferiortemporal, middletemporal,
// superiortemporal, temporalpole, transversetemporal, insula

const PCA_CTX = [5, 6, 7, 11, 13, 16, 21, 23, 25, 10];
// cuneus, entorhinal, fusiform, lateraloccipital, lingual, parahippocampal,
// pericalcarine, posteriorcingulate, precuneus, isthmuscingulate

/** Subcortical FreeSurfer labels. */
const SUBCORTICAL: Record<number, TerritoryId> = {
  11: TERRITORY.mcaDeep, // caudate L
  50: TERRITORY.mcaDeep,
  12: TERRITORY.mcaDeep, // putamen L
  51: TERRITORY.mcaDeep,
  13: TERRITORY.mcaDeep, // pallidum L
  52: TERRITORY.mcaDeep,
  26: TERRITORY.mcaDeep, // accumbens L
  58: TERRITORY.mcaDeep,
  10: TERRITORY.pcaPerforating, // thalamus L
  49: TERRITORY.pcaPerforating,
  17: TERRITORY.anteriorChoroidal, // hippocampus L
  53: TERRITORY.anteriorChoroidal,
  18: TERRITORY.anteriorChoroidal, // amygdala L
  54: TERRITORY.anteriorChoroidal,
  31: TERRITORY.anteriorChoroidal, // choroid plexus L
  63: TERRITORY.anteriorChoroidal,
  8: TERRITORY.cerebellar, // cerebellum cortex L
  47: TERRITORY.cerebellar,
  7: TERRITORY.cerebellar, // cerebellum WM L
  46: TERRITORY.cerebellar,
  16: TERRITORY.basilarPerforators, // brainstem
  28: TERRITORY.basilarPerforators, // ventral DC L
  60: TERRITORY.basilarPerforators,
};

/**
 * Territory supplying a FreeSurfer label.
 *
 * Cerebral white matter is assigned by proximity at runtime rather than here:
 * a single "cerebral WM" label covers territory belonging to all three cerebral
 * arteries, so mapping it to any one of them would be wrong. It inherits from
 * whichever cortical territory is nearest, which is also what makes deep
 * white-matter watershed infarcts fall out correctly.
 */
export function territoryOf(fsLabel: number): TerritoryId {
  if (fsLabel in SUBCORTICAL) return SUBCORTICAL[fsLabel];

  if ((fsLabel >= 1000 && fsLabel <= 1035) || (fsLabel >= 2000 && fsLabel <= 2035)) {
    const off = fsLabel % 1000;
    if (ACA_CTX.includes(off)) return TERRITORY.aca;
    if (MCA_SUP_CTX.includes(off)) return TERRITORY.mcaSuperior;
    if (MCA_INF_CTX.includes(off)) return TERRITORY.mcaInferior;
    if (PCA_CTX.includes(off)) return TERRITORY.pcaCortical;
    return TERRITORY.mcaSuperior;
  }

  return TERRITORY.none;
}

/** Occlusion sites offered in the UI, with the territories each one starves. */
export interface OcclusionSite {
  id: string;
  name: string;
  /** Territories lost, and how completely (1 = full). */
  affects: Array<{ territory: TerritoryId; severity: number }>;
  /**
   * True where the occlusion genuinely takes both sides. Only the basilar
   * perforators qualify: the two vertebrals fuse into ONE basilar artery, so a
   * perforator occlusion there is midline and bilateral by anatomy. Everything
   * else is paired left and right, and a territory id carries no side — so
   * without this flag every stroke would infarct both hemispheres.
   */
  bilateral?: boolean;
  note: string;
}

export const OCCLUSION_SITES: OcclusionSite[] = [
  {
    id: 'm1',
    name: 'MCA — M1 (proximal)',
    affects: [
      { territory: TERRITORY.mcaSuperior, severity: 1 },
      { territory: TERRITORY.mcaInferior, severity: 1 },
      { territory: TERRITORY.mcaDeep, severity: 1 },
    ],
    note:
      'The classic large-vessel occlusion. Takes both cortical divisions AND the ' +
      'lenticulostriates, which is why deep structures infarct even when good ' +
      'collaterals rescue the cortical rim — the perforators have no collateral supply.',
  },
  {
    id: 'm2sup',
    name: 'MCA — M2 superior division',
    affects: [{ territory: TERRITORY.mcaSuperior, severity: 1 }],
    note: 'Face and arm weakness with expressive aphasia if dominant; deep structures spared.',
  },
  {
    id: 'm2inf',
    name: 'MCA — M2 inferior division',
    affects: [{ territory: TERRITORY.mcaInferior, severity: 1 }],
    note: 'Receptive aphasia if dominant, or neglect if not. Often no weakness.',
  },
  {
    id: 'aca',
    name: 'ACA — A2',
    affects: [{ territory: TERRITORY.aca, severity: 1 }],
    note: 'Medial frontal territory: leg-predominant weakness, abulia.',
  },
  {
    id: 'pca',
    name: 'PCA — P2',
    affects: [{ territory: TERRITORY.pcaCortical, severity: 1 }],
    note: 'Occipital infarct with homonymous hemianopia.',
  },
  {
    id: 'pcap1',
    name: 'PCA — P1 (with perforators)',
    affects: [
      { territory: TERRITORY.pcaCortical, severity: 1 },
      { territory: TERRITORY.pcaPerforating, severity: 1 },
    ],
    note: 'Adds thalamic involvement to the occipital infarct.',
  },
  {
    id: 'lsa',
    name: 'Lenticulostriate (lacunar)',
    affects: [{ territory: TERRITORY.mcaDeep, severity: 1 }],
    note:
      'Striatocapsular / lacunar infarct: a single deep perforator, not the ' +
      'parent MCA, so the cortex is entirely spared. Classically pure motor ' +
      'hemiparesis. These arteries are end-arteries with no collateral supply, ' +
      'which is why a vessel under a millimetre across produces a fixed deficit.',
  },
  {
    id: 'thalamoperf',
    name: 'Thalamoperforator',
    affects: [{ territory: TERRITORY.pcaPerforating, severity: 1 }],
    note:
      'Paramedian thalamic infarct. Classically pure sensory stroke, later ' +
      'thalamic pain. Occlusion of a shared trunk (artery of Percheron) takes ' +
      'both thalami — the rare case where a deep stroke is legitimately bilateral.',
  },
  {
    id: 'acha',
    name: 'Anterior choroidal',
    affects: [{ territory: TERRITORY.anteriorChoroidal, severity: 1 }],
    note: 'Small vessel, disproportionate deficit: motor, sensory and visual together.',
  },
  {
    id: 'basilar',
    name: 'Basilar — perforators',
    affects: [{ territory: TERRITORY.basilarPerforators, severity: 1 }],
    bilateral: true,
    note:
      'Brainstem infarct. Small volume, potentially devastating. The only ' +
      'bilateral site here — the vertebrals fuse into one midline basilar.',
  },
  {
    id: 'pica',
    name: 'PICA / cerebellar',
    affects: [{ territory: TERRITORY.cerebellar, severity: 1 }],
    note: 'Cerebellar infarct; swelling can compress the fourth ventricle.',
  },
];

export function occlusionById(id: string): OcclusionSite | undefined {
  return OCCLUSION_SITES.find((s) => s.id === id);
}
