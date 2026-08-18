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
    title: 'Weakness and inattention down one side',
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
    title: 'Bumping into things on one side',
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
    title: 'Fluent nonsense, full strength',
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
  {
    id: 'lacune-01',
    title: 'Face, arm and leg equally weak',
    stem:
      'A 64-year-old with many years of poorly controlled blood pressure wakes ' +
      'with weakness of the face, arm and leg on the right, all affected to ' +
      'much the same degree. Speech is slurred, but language itself is intact ' +
      '— words are found normally, instructions are followed, and there is no ' +
      'inattention. The visual fields are full.\n\n' +
      'The infarct is not on the surface. Cut into the brain to find it.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'lsa',
        side: 'left',
        collateralGrade: 3,
        hoursSinceOnset: 12,
        recanalisationHour: Infinity,
      },
    },
    // `slice` is what makes this answerable — the target is nowhere near the
    // convexity. Collateral grade is deliberately 3: excellent collaterals, and
    // the deep tissue infarcts anyway, which is the whole point.
    allow: ['rotate', 'zoom', 'pick', 'slice', 'modality', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Cut an axial plane, then click the infarcted structure.',
      measure: 'infarct-territory',
    },
    because:
      'Weakness of face, arm and leg in equal measure, with NO disturbance of ' +
      'language, no inattention and full fields, is a pure motor syndrome. ' +
      'Cortical signs are absent because no cortex is involved: the lesion sits ' +
      'in the deep grey and internal capsule, where the descending motor fibres ' +
      'are packed close enough that a small infarct takes the whole half of the ' +
      'body. A surface infarct large enough to weaken the leg as much as the ' +
      'face would almost never spare language and attention as well.\n\n' +
      'Note the collaterals in this case are EXCELLENT, and the tissue died ' +
      'regardless. The small perforating arteries are end arteries with no ' +
      'collateral supply at all, which is why good collaterals rescue the ' +
      'cortical rim and never rescue the deep grey.',
    evidence: 'literature',
    cite: 'Fisher, lacunar syndromes; pure motor hemiparesis and the internal capsule. Perforator end-artery anatomy.',
  },
  {
    id: 'pure-sensory-01',
    title: 'One half of the body numb',
    stem:
      'A 69-year-old describes the whole of the right side — face, arm, trunk ' +
      'and leg — as numb and not their own. Light touch, pinprick and ' +
      'temperature are all reduced on that side, to much the same degree ' +
      'throughout. Strength is FULL: the arm and leg lift against resistance ' +
      'without difficulty. Language, attention and visual fields are normal.\n\n' +
      'Weeks later, the numb side becomes persistently and unpleasantly ' +
      'painful.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'thalamoperf',
        side: 'left',
        collateralGrade: 3,
        hoursSinceOnset: 10,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'slice', 'modality', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Cut a plane, then click the infarcted structure.',
      measure: 'infarct-territory',
    },
    because:
      'Sensory loss over an entire half of the body — face, arm, trunk and leg ' +
      'together — with completely preserved strength is a pure sensory ' +
      'syndrome. Everything the body feels funnels through one small relay on ' +
      'its way to cortex, so an infarct of a few millimetres there takes the ' +
      'whole hemibody at once. A cortical lesion large enough to do that would ' +
      'almost certainly disturb language or attention as well.\n\n' +
      'Strength is spared because the descending motor fibres do not pass ' +
      'through the relay — they run in the internal capsule just lateral to ' +
      'it. That is the anatomical mirror of the pure motor case: the same ' +
      'calibre of vessel, a few millimetres apart, opposite examination.\n\n' +
      'The delayed, unpleasant pain in the numb side is characteristic of this ' +
      'location.',
    evidence: 'literature',
    cite: 'Dejerine & Roussy, central post-stroke pain; Fisher, pure sensory stroke.',
  },

  {
    id: 'locked-in-01',
    title: 'Awake, aware, unable to move',
    stem:
      'A 54-year-old collapses. They cannot move any limb, and cannot speak or ' +
      'swallow. They are AWAKE and aware: they open and close the eyes to ' +
      'command, and look up and down on request. Horizontal eye movement is ' +
      'lost; vertical movement and blinking are preserved, and it is possible ' +
      'to hold a conversation through them. Sensation appears intact.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'basilar',
        side: 'left',
        collateralGrade: 1,
        hoursSinceOnset: 6,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'slice', 'modality', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Cut a plane, then click the infarcted structure.',
      measure: 'infarct-territory',
    },
    because:
      'Quadriparesis with speech and swallowing lost, while consciousness, ' +
      'vertical gaze and blinking survive, is the locked-in syndrome. The ' +
      'lesion sits ventrally in the brainstem, where the descending motor ' +
      'fibres for both sides of the body run close together along with the ' +
      'centres for horizontal gaze. Vertical gaze and the arousal system lie ' +
      'higher and further back, which is why awareness is spared — and why ' +
      'this patient is not unconscious despite a devastating deficit.\n\n' +
      'This is also the one stroke in this set that is bilateral by ANATOMY ' +
      'rather than by accident. Every other territory is paired left and ' +
      'right, and a real infarct stops at the midline. Here the two vertebral ' +
      'arteries fuse into a single midline vessel, so its small branches ' +
      'supply both halves of the brainstem: one occlusion, both sides. Clicking ' +
      'either side of the midline is correct here, and only here.',
    evidence: 'literature',
    cite: 'Plum & Posner, locked-in syndrome; ventral pontine anatomy and midline vertebrobasilar supply.',
  },
  {
    id: 'broca-01',
    title: 'Effortful speech, weak face and arm',
    stem:
      'A 61-year-old, right-handed, has sudden weakness of the right side of ' +
      'the face and of the right arm. The LEG is barely affected — they can ' +
      'still walk. Speech is sparse and effortful, produced in short broken ' +
      'phrases, and they are visibly frustrated by it. They follow every ' +
      'instruction correctly and clearly understand what is said to them.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'm2sup',
        side: 'left',
        collateralGrade: 2,
        hoursSinceOnset: 4,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'modality', 'slice', 'xray'],
    // MODEL LIMIT worth knowing before writing another motor case: the
    // territory LUT assigns each parcel to ONE artery, and `precentral` — which
    // really spans the midline leg area (medial supply) and the face/hand on
    // the convexity — is assigned wholesale to the medial one. So the motor
    // strip scores `none` here. The reasoning below therefore routes through
    // the frontal operculum, which the model does place in this branch, rather
    // than through the homunculus. Teaching a split the model cannot represent
    // would mark correct reasoning wrong.
    task: {
      kind: 'pick-region',
      prompt: 'Click the region where speech production lives.',
      measure: 'infarct-territory',
    },
    because:
      'Effortful, non-fluent speech WITH preserved comprehension is an ' +
      'expressive aphasia. The patient knows what they want to say and cannot ' +
      'get it out, which is why they are frustrated — the receptive case is ' +
      'not, because they cannot tell anything is wrong. In a right-handed ' +
      'patient language sits on the left, so the lesion is left and the ' +
      'weakness is on the right.\n\n' +
      'Expressive language lives in the frontal operculum, on the lateral ' +
      'convexity just in front of the motor strip — so the infarct that takes ' +
      'speech production also takes the face and hand next door, and spares ' +
      'the leg further over. That neighbourhood IS the answer here.\n\n' +
      'Compare this with the fluent case: the SAME artery, the other branch. ' +
      'There language failed and strength was normal; here strength fails and ' +
      'comprehension survives. One vessel, two branches, opposite examinations.',
    evidence: 'literature',
    cite: 'Broca aphasia and the MCA superior division; motor homunculus and the medial leg representation.',
  },

  {
    id: 'ipsilateral-ataxia-01',
    title: 'Sudden vertigo and a veering walk',
    stem:
      'A 48-year-old develops abrupt spinning vertigo with vomiting, and ' +
      'cannot stand without falling towards the LEFT. Reaching for an object ' +
      'with the left hand, they overshoot it and correct clumsily. The eyes ' +
      'beat on lateral gaze. Strength is FULL in all four limbs, sensation is ' +
      'intact, the face is symmetrical, and language is normal.\n\n' +
      'This is a simulation, not a real patient.',
    state: {
      stroke: {
        enabled: true,
        site: 'pica',
        side: 'left',
        collateralGrade: 2,
        hoursSinceOnset: 7,
        recanalisationHour: Infinity,
      },
    },
    allow: ['rotate', 'zoom', 'pick', 'modality', 'slice', 'xray'],
    task: {
      kind: 'pick-region',
      prompt: 'Rotate to see the underside of the brain, then click the infarct.',
      measure: 'infarct-territory',
    },
    because:
      'Abrupt vertigo with limb clumsiness and nystagmus, and NO weakness or ' +
      'sensory loss, points away from the cerebral hemispheres altogether.\n\n' +
      'Now the side — because this case inverts the rule every other case here ' +
      'teaches. The corticospinal tract decussates, so a hemisphere lesion ' +
      'produces its deficit on the OPPOSITE side of the body. The pathways ' +
      'through this structure cross twice, which cancels out, so its signs ' +
      'appear on the SAME side as the lesion. The patient falls TOWARDS the ' +
      'lesion, not away from it. Applying the contralateral rule here puts you ' +
      'in the wrong hemisphere every time.\n\n' +
      'This matters practically. A dizzy patient with full strength is easy to ' +
      'dismiss as benign, and swelling in this territory can compress the ' +
      'fourth ventricle and obstruct the flow of CSF.',
    evidence: 'literature',
    cite: 'Ipsilateral cerebellar signs (double decussation); PICA territory infarction and fourth-ventricular compression.',
  },
];

/**
 * Historical note, kept because the constraint shaped the shell.
 *
 * `pick-region` picks the FIRST surface a ray hits, so for a while only
 * territories exposed on the lateral convexity were answerable at all. A deep
 * case could not ship: reaching the lentiform means cutting into the brain, and
 * `allow` only REMOVED affordances — it blocked shortcuts and provided nothing.
 *
 * That was a gap in the shell rather than a reason to write a vaguer case, and
 * it is now closed: granting `slice` renders a cut control, and the picker
 * already honours the clip, so a click on the cut face names the tissue there.
 * `lacune-01` below is the case that was blocked.
 */
export function findCase(id: string): Case | undefined {
  return CASES.find((c) => c.id === id);
}
