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
];

export function findCase(id: string): Case | undefined {
  return CASES.find((c) => c.id === id);
}
