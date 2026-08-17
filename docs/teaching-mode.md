# Teaching mode — design

Decided before any case exists, because the shell determines what a case can
ask, and three cases written against the wrong shell is a rewrite.

Status: **design agreed, not built.** Phase 7 of [`../ROADMAP.md`](../ROADMAP.md).

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

## 9. First build — vertical slice

One task type, one case, end to end, with the leak gate. `pick-region` on a
stroke: it exercises the existing picker, the territory LUT and the core mask,
and it is scored entirely from measured state.

Only widen to a second task type once that slice is complete — same
vertical-slice-first rule the rest of this project follows.
