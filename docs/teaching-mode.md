# Teaching mode — design

Decided before any case exists, because the shell determines what a case can
ask, and three cases written against the wrong shell is a rewrite.

Status: **built and gated** — `pick-region`, eight cases, cortical and deep. Phase 7 of
[`../ROADMAP.md`](../ROADMAP.md).

```
#/teach                          the case library
#/case/mca-territory-01          M1 - neglect, gaze preference
#/case/field-defect-01           PCA - homonymous field cut
#/case/aphasia-no-weakness-01    M2 inferior - fluent aphasia, FULL strength
#/case/lacune-01                 lenticulostriate - PURE MOTOR, deep
#/case/pure-sensory-01           thalamic relay   - PURE SENSORY, deep
#/case/locked-in-01              midline brainstem - bilateral by anatomy
#/case/broca-01                  M2 superior - effortful speech, comprehension INTACT
#/case/ipsilateral-ataxia-01     cerebellar  - signs on the SAME side
await __corticum.verifyCases()   the leak gate
```

The six are a set, built so that each pair turns on ONE examination finding:

| Pair | Identical except |
|---|---|
| `mca-territory-01` / `aphasia-no-weakness-01` | same artery, different calibre — is strength preserved? |
| `mca-territory-01` / `field-defect-01` | both left-sided inattention — is the patient AWARE of it? |
| `lacune-01` / `pure-sensory-01` | both deep lacunes millimetres apart — motor or sensory? |
| `broca-01` / `aphasia-no-weakness-01` | same artery, two branches — is comprehension intact? |

`ipsilateral-ataxia-01` is the odd one out on purpose: seven cases teach that a
lesion produces its deficit on the OPPOSITE side, and this one inverts it. The
cerebellar pathways cross twice and cancel, so the patient falls TOWARDS the
lesion. Applying the contralateral rule here lands in the wrong hemisphere every
time, which is exactly why it is worth a case.

That third pair is the sharpest, and the scorers enforce it in both directions:
in the motor case the thalamus scores `none`, and in the sensory case the
lentiform scores `none`. Deep, correct side, wrong supply. A scorer that waved
through "any deep structure on the correct side" would teach the opposite of
what both cases are for.

`locked-in-01` earns its place differently: it is the only site with
`bilateral: true`, and **no case exercised that branch until now**. Every other
territory is paired left and right and a real infarct stops at the midline; the
vertebrals fuse into one midline vessel, so here both sides score `full` —
verified, and only here.

**Cases 2 and 3 were added with ZERO code changes**, which is the schema doing
its job: cases are content, and if adding one needs a code change the schema is
wrong.

### What the first run taught

**The leak gate caught the very case it shipped with**, which is the outcome
that justifies building it before the second case. The stem says *"the gaze is
driven to the right"* and the answer side is right, so a bare word match on
`left`/`right` flagged it.

That was a FALSE positive, and fixing it sharpened the rule. A lateralised
vignette *must* say left and right — those signs are the input to the reasoning.
The leak is the side welded to the anatomy (*"right MCA"*), not the side of a
symptom. Matching bare sides would have failed every honest case and trained the
author to delete the clinical detail that makes a case worth doing.

**Routing needed a `hashchange` reload.** Pasting `#/case/x` into an
already-loaded page silently did nothing, because the shell is chosen at boot.
Entering, leaving or switching cases now rebuilds — the panel especially must
not survive into a case.

## 0a. Two things writing these cases exposed

**The scorer was teaching a rule that is not universal.** Its partial-credit
message asserted *"the deficit is contralateral to the lesion"* — true of the
cerebrum, FALSE of the cerebellum. Adding a cerebellar case would have made the
tool state something wrong. The scorer now reports only WHAT was measured
("right territory, wrong side") and leaves mechanism to the case's `because`,
which knows which rule applies to it. **Measure in the scorer, explain in the
case.**

**The territory LUT cannot represent the motor strip.** It assigns each parcel
to ONE artery, and `precentral` — which really spans the midline leg area on the
medial supply and the face and hand on the convexity — is assigned wholesale to
the medial one, so it scores `none` for a superior-division occlusion. A learner
reasoning correctly from face-and-arm weakness to the motor strip would have been
marked wrong.

`broca-01` therefore routes its reasoning through the frontal operculum, which
the model does place in that branch, rather than through the homunculus. Writing
a case against a distinction the model cannot make marks correct reasoning wrong,
which is worse than not having the case.

## 0. Separate, but reachable

Teaching is a mode, so the parameter panel — the answer key — is never on screen
during a case. The cost of that separation is discoverability, and for a while
it was total: cases existed, nothing linked to them, and nothing led back out.

- **In**: one LINK at the top of the panel, deliberately not a tenth section.
  Cases are a different mode, not another parameter, and putting them in the
  panel is exactly the clutter the mode split exists to avoid. The panel still
  has 9 sections in 5 groups, unchanged.
- **Library**: `#/teach` lists the cases by PRESENTATION and links back to the
  full tool.
- **Out**: every case has "← all cases", and "next case →" appears only AFTER
  the learner commits — a visible next button beforehand is an invitation to
  skip the thinking, which is the exercise.

**The library nearly leaked.** The first version tagged each case "cut required"
or "surface". It was wrong (every case grants `slice`, so all six read the same)
and worse, a correct version would have been a leak: cortical-versus-deep is
precisely the discrimination the lacunar and pure-sensory cases exist to teach,
and labelling it in the index answers them from the menu. No depth tag ships.

## 1. It is a MODE, not a section

The parameter panel is the answer key. A case asking "which vessel is
occluded?" is already answered by a dropdown reading *MCA — M1 proximal*; the
time scrubber gives away the clock, and the Measurements section prints ASPECTS.

So teaching cannot be a tenth panel section. It takes the screen: panel not
rendered, HUD reduced to the case identity.

Entered by URL — `#/teach` for the library, `#/case/<id>` for one case — so a
supervisor can send a link to a specific case. That is the actual teaching use.

## 2. A case is data, not code

A case is **a `DiseaseState` plus a question**. That means the whole existing
engine is already the case renderer, cases are authorable without touching WGSL
or TypeScript, and Phase 3 cohorts can emit them later without a new format.

```ts
interface Case {
  id: string;
  stem: string;              // clinical vignette, plain prose
  state: DiseaseState;       // the existing type, verbatim
  allow: Affordance[];       // which controls the learner gets — default deny
  task: Task;                // what they must DO
  reveal: Reveal;            // what to show once they commit
}
```

## 3. `allow` is the load-bearing field

Some controls **are** the answer, so every case declares its own affordances and
the default is deny. A DWI-FLAIR case grants modality switching — that is the
skill being taught — and withholds the time scrubber, which is the answer.

```ts
type Affordance =
  | 'rotate' | 'zoom' | 'pick' | 'xray' | 'lens'
  | 'modality' | 'slice' | 'time' | 'split' | 'arteries';
```

Without this every case leaks, and it leaks silently — the author will not
notice, because they already know the answer.

## 4. The learner answers by ACTING

Not by choosing from a list. Answering by doing is the whole reason to teach on
this rather than on slides, and the simulator can score it because it knows what
is true.

| Task | The learner… | Scored against |
|---|---|---|
| `pick-region` | clicks the structure | the true label / territory / core mask |
| `set-modality` | picks the sequence that would show it | measured conspicuity at that timepoint |
| `place-marker` | clicks where they would aim | the true lesion or network centroid |
| `set-value` | drags to an estimate (e.g. ASPECTS) | the measured score |

### The rule that matters most

**The answer is MEASURED, not authored.** A case never stores "the correct answer
is 7". It stores *how to measure* the answer, and the scorer reads it from the
running model — `measureAspects()`, `territoryOf()`, the core mask, the
conspicuity table.

This is the project's own recurring lesson (gotchas #39, #42, #43) applied to
teaching: a case with a typed-in answer key can drift out of agreement with the
simulation, and then the tool confidently teaches something it is not doing. An
authored key is a second source of truth, and the one that is wrong is always
the one nobody re-checks.

### Tolerance is part of the task, not the scorer

Clicking a gyrus is not a point equality test. `pick-region` grades:

| | |
|---|---|
| exact parcel | full credit |
| same arterial territory | partial |
| same hemisphere | none, but say so |

Stated per task type so a case cannot quietly redefine what "right" means.

## 5. The reveal is the payoff

corticum knows the truth, so the reveal shows **measured** ground truth rather
than an assertion: the true ASPECTS, the true core and mismatch volumes, the
territory that was actually starved.

Then the counterfactual: wipe the split divider across the lesion and show the
brain **that patient would have had**. No real teaching case can do this, because
the healthy version of a diseased brain does not exist as data. It does here.

Every clinical claim in reveal text carries an **evidence tag**, same rule as the
parameter panel. A case cannot ship without one.

## 6. What cases may ask, for now

**Qualitative facts only, until Phase 5 calibrates the rates.**

The sequence of events follows the literature; the timings do not, and the stroke
core-growth clock is documented as faster than DEFUSE-3 and DAWN imply.

| Fair to ask now | Not until calibrated |
|---|---|
| Is DWI positive while FLAIR is still negative? | How many hours since onset? |
| Would this be visible on CT yet? | What will the core volume be at 6 h? |
| Which territory is this? | What is the atrophy rate? |
| Does the deep grey survive here? | |
| Collaterals or reperfusion — which rescues this? | |

## 7. Constraints

- **No backend.** Session-local tally, no accounts, no stored results. The tool
  is a static site and should stay one.
- **Never implies a real patient.** The stem is a vignette over a simulation, and
  the reveal says so.
- **Cases are content, not features.** Adding a case must never require a code
  change; if it does, the schema is wrong.

## 8. Gate — a case must not leak its answer

Automated, because an author cannot self-check this: they already know the answer
and will not see it on screen.

Render each case with its own `allow` list, scrape every piece of visible text
and every enabled control, and assert that the answer does not appear among them.
A case whose task is `pick-region` on an M1 occlusion fails if any permitted
control names the MCA.

This is the one gate that has to exist before the second case is written.

## 9a. `allow` had to PROVIDE, not just remove

`pick-region` picks the FIRST surface a ray hits, so at first only territories on
the lateral convexity were answerable. The best case in the set could not ship: a
lacunar syndrome, pure motor deficit of face, arm and leg with no cortical signs,
infarct in the lentiform. Answering it means cutting into the brain — and the
panel that normally provides a cut control is suppressed, by design.

The root cause was that `allow` only ever *removed* affordances. It blocked
shortcuts and provided nothing, so a case could grant `slice` and the learner
still had no way to slice. All four cases also granted `modality` with no
sequence selector to use.

Granted affordances now render controls, and only granted ones. The picker
already honoured the clip, so a click on the cut face names the tissue there —
verified: an axial cut then a pick at screen centre returns deep tissue, not
cortex.

`lacune-01` is that case, now shipped. Its grading is the sharpest in the set:

| Click | Grade |
|---|---|
| left putamen / pallidum / caudate | full |
| right putamen | partial — right supply, wrong hemisphere |
| **left thalamus** | **none** — deep, correct side, DIFFERENT perforator supply |
| left cortex | none |

That thalamus row is the point. It is the distinction between a pure motor and a
pure sensory syndrome, and a scorer that waved through "any deep structure on the
left" would teach the opposite of what the case is for.

## 9. First build — vertical slice

One task type, one case, end to end, with the leak gate. `pick-region` on a
stroke: it exercises the existing picker, the territory LUT and the core mask,
and it is scored entirely from measured state.

Only widen to a second task type once that slice is complete — same
vertical-slice-first rule the rest of this project follows.
