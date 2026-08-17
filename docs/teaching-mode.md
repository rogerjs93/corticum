# Teaching mode — design

Decided before any case exists, because the shell determines what a case can
ask, and three cases written against the wrong shell is a rewrite.

Status: **built and gated** — `pick-region`, three cases. Phase 7 of
[`../ROADMAP.md`](../ROADMAP.md).

```
#/case/mca-territory-01          M1 - neglect, gaze preference
#/case/field-defect-01           PCA - homonymous field cut
#/case/aphasia-no-weakness-01    M2 inferior - fluent aphasia, FULL strength
await __corticum.verifyCases()   the leak gate
```

The three are a set. One and three are the same artery at different calibres,
separated only by whether strength is preserved; one and two are both left-sided
inattention, separated only by whether the patient is aware of it. Each pair
turns on a single examination finding, which is the point.

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

## 9a. Constraint found by writing case 4

`pick-region` picks the FIRST surface a ray hits, so **only territories exposed
on the lateral convexity can be answered by clicking.**

The best case in the set is the one that could not ship: a lacunar syndrome —
pure motor deficit of face, arm and leg with no aphasia, no neglect and full
fields — where the infarct sits in the lentiform and the teaching point is that
deep perforators are end arteries with no collateral supply. The learner would
have to cut into the brain to click it, and the teach shell renders no slice
control because the panel is suppressed.

That is a gap in the SHELL, not a reason to write a vaguer case. `allow`
currently only *removes* affordances — it blocks shortcuts — and does not yet
*provide* the controls it grants. Deep cases land when it does, and that is the
next piece of teaching-mode work.

## 9. First build — vertical slice

One task type, one case, end to end, with the leak gate. `pick-region` on a
stroke: it exercises the existing picker, the territory LUT and the core mask,
and it is scored entirely from measured state.

Only widen to a second task type once that slice is complete — same
vertical-slice-first rule the rest of this project follows.
