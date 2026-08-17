import type { Case } from './types';

/**
 * The case library.
 *
 * Cases are CONTENT, not features: adding one must never require a code
 * change. If it does, the schema is wrong.
 *
 * **Qualitative facts only, until Phase 5 calibrates the rates.** The sequence
 * of events follows the literature; the timings do not, and the stroke
 * core-growth clock is documented as running faster than DEFUSE-3 and DAWN
 * imply. "Which territory is this?" is fair. "How many hours since onset?"
 * asks about a clock this project knows is wrong.
 */
export const CASES: Case[] = [
  {
    id: 'mca-territory-01',
    stem:
      'A 72-year-old is brought in after sudden weakness down the left side, ' +
      'with dense inattention to the left. The gaze is driven to the right. ' +
      'NIHSS 16.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'm1',
        side: 'right',
        collateralGrade: 1,
        hoursSinceOnset: 4,
        recanalisationHour: Infinity,
      },
    },
    // Rotate and look, and switch sequence — that is ordinary radiology. NOT
    // `arteries`, which draws the occluded tree and names the answer outright;
    // NOT `time`, because scrubbing to zero shows the brain before the infarct.
    allow: ['rotate', 'zoom', 'pick', 'modality', 'slice', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Click a cortical region inside the infarct.',
      measure: 'infarct-territory',
    },
    because:
      'Left-sided weakness with left inattention and a rightward gaze ' +
      'preference localises to the RIGHT hemisphere — the corticospinal tract ' +
      'decussates, so the deficit is contralateral to the lesion. Dense ' +
      'neglect with gaze deviation points to a large middle cerebral artery ' +
      'territory rather than a lacune.',
    evidence: 'literature',
    cite: 'Contralateral motor deficit: standard neuroanatomy. Neglect and gaze preference in MCA syndrome: Heilman & Valenstein.',
  },

  {
    id: 'field-defect-01',
    stem:
      'A 71-year-old keeps catching the left side of door frames, and leaves ' +
      'food untouched on the left of the plate. Strength is normal in all four ' +
      'limbs and speech is unaffected. Confrontation testing shows a dense ' +
      'homonymous defect of the left visual field, and the patient is aware of ' +
      'it and frustrated by it.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'pca',
        side: 'right',
        collateralGrade: 1,
        hoursSinceOnset: 8,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'modality', 'slice', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Click a region inside the infarct.',
      measure: 'infarct-territory',
    },
    because:
      'An isolated homonymous field defect with normal strength and normal ' +
      'language localises behind the parietal and temporal lobes, to the ' +
      'occipital visual cortex supplied by the posterior circulation. The ' +
      'defect is contralateral because fibres carrying the left half of the ' +
      'visual world from BOTH eyes end in the right occipital lobe.\n\n' +
      'Awareness of the deficit is the discriminator from case one: a patient ' +
      'who is frustrated by what they cannot see has a field cut, whereas ' +
      'neglect is a failure to attend, and those patients do not complain.',
    evidence: 'literature',
    cite: 'Retinotopic organisation of the visual pathway; field defect vs neglect: standard clinical neurology.',
  },

  {
    id: 'aphasia-no-weakness-01',
    stem:
      'A 58-year-old, right-handed, begins speaking in fluent but nonsensical ' +
      'sentences, using wrong and invented words. They cannot follow a simple ' +
      'spoken instruction, and do not appear to realise anything is wrong. ' +
      'Strength is FULL in all four limbs and the face is symmetrical.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'm2inf',
        side: 'left',
        collateralGrade: 2,
        hoursSinceOnset: 5,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'modality', 'slice', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Click a region inside the infarct.',
      measure: 'infarct-territory',
    },
    because:
      'Fluent speech that carries no meaning, with comprehension lost and no ' +
      'awareness of the problem, is a receptive aphasia — and in a right-handed ' +
      'patient language is left-lateralised, so the lesion is on the LEFT.\n\n' +
      'Full strength is the informative part. The motor strip sits in the ' +
      'superior division, so an occlusion taking the whole vessel would weaken ' +
      'the face and arm. Language failure WITHOUT weakness means only the ' +
      'lower branch is involved — the same artery, a smaller lesion, a very ' +
      'different examination.',
    evidence: 'literature',
    cite: 'Wernicke aphasia and the MCA inferior division; language lateralisation in right-handers (~95%).',
  },
];

/**
 * Constraint on case design, learned by trying to write a deep one.
 *
 * `pick-region` picks the FIRST surface a ray hits, so only territories exposed
 * on the lateral convexity can be answered by clicking. A lacunar case — pure
 * motor deficit, no cortical signs, infarct in the lentiform — is a better
 * teaching question than any of these, and it is currently unanswerable: the
 * learner would have to cut into the brain, and the teach shell renders no
 * slice control because the panel is suppressed.
 *
 * That is a gap in the SHELL, not a reason to write a vaguer case. `allow`
 * currently only removes affordances (it blocks shortcuts); it does not yet
 * provide the controls it grants. Deep cases land when it does.
 */
export function findCase(id: string): Case | undefined {
  return CASES.find((c) => c.id === id);
}
