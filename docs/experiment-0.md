# Experiment 0 — does a standard tool cope with the synthetic image?

Run 2026-08-18 on the Windows workstation in Docker (`brainlife/fsl:6.0.4-patched2`),
**not** on the remote FreeSurfer box. Deciding Phase 2's scope from evidence
rather than from guesswork.

## Method

Healthy `sample`, no disease, exported at native 208³ 1 mm via
`__corticum.exportToDisk(208)` → 35,996,000 bytes, reloaded in `nibabel` with a
correct diagonal affine and 13.4% brain occupancy. Then FSL `bet -m -f 0.5`,
which took **8.5 s**.

Ground truth needs no estimation here: the image is generated, so "brain" is
exactly `t1 > 0.01`.

## What I predicted, and why it was wrong

I predicted BET would score near-perfectly and the test would be **vacuous** —
the image is already a brain mask with tissue values painted in, so there is
nothing to strip.

That was wrong, and the real result is more useful.

## Result

| | |
|---|---|
| true brain voxels | 1,201,758 |
| BET mask voxels | 1,468,981 |
| **Dice** | **0.8907** |
| background wrongly kept | 279,625 |
| real tissue wrongly cut | 12,402 |

**BET did not fail loudly. It failed quietly**, producing a brain-shaped mask
22% too large. Dice 0.89 would pass unremarked in almost any write-up, and a
reviewer looking at the mask would see nothing obviously wrong.

Where the error sits:

| | |
|---|---|
| within 2 mm of tissue — sulcal CSF smoothed over | 246,905 (88%) |
| further out — surface pushed into background | 32,720 (12%) |

## Why

Two properties of the image, both measured:

1. **No skull, no scalp, no noise.** Background is *exactly* zero — 0 non-brain
   voxels carry any signal. BET's deformable surface is designed to settle
   between brain and skull; with no skull it has nothing to stop it, so it
   relaxes to a smooth envelope that swallows the sulci.
2. **No partial-volume ramp.** Mean intensity just inside the surface is 0.465
   and just outside is exactly 0.000 — a cliff, where a real T1 has a graded
   transition over 1–2 voxels. And 65% of brain voxels sit at exactly two
   values (0.780 and 0.450): white and grey matter as constants rather than
   distributions.

## What this settles for Phase 2

The acquisition model needs, in this order:

1. **Partial-volume mixing at boundaries** — the cliff is what defeats the
   surface fit, and it is the cheapest of the four to add.
2. **Skull and scalp** — without them a skull-stripper is not being tested at
   all, it is being handed its own answer and still getting it wrong.
3. **Rician noise** — 61 distinct values across the volume is not an image.
4. **Bias field** — least urgent; nothing here depends on it yet.

And it settles the gate design. "Does BET succeed?" is the wrong question,
because BET *did* succeed by its own lights. The gate must score the mask
against known ground truth, which this tool can supply and real data cannot.

## Cost

8.5 s per BET run on 4 cores. The realism loop is genuinely iterative at this
speed — add partial-volume, re-export, re-score, in under a minute per attempt.
Full `recon-all` confirmation (~1 h here) is worth doing only once the cheap
loop has stopped moving.


---

# Phase 2, first attempt: partial volume — a negative result

Added the partial-volume ramp the experiment above pointed at, then re-ran the
identical BET measurement. **It did not work**, and that is worth recording as
carefully as a success would be.

## The change

`export_volume.wgsl` used `if (d < 0.0)` — a hard binary cutoff, giving the
0.465-to-0.000 cliff. Replaced with coverage derived from the exact signed
distance:

```wgsl
let voxMm = 2.0 * half / params.cfg.x;
let coverage = clamp(0.5 - d / voxMm, 0.0, 1.0);
t1 = tissue * coverage;
```

No invented parameter: a voxel of side `v` centred `d` from the boundary is
covered by `clamp(0.5 - d/v, 0, 1)`. That is geometry, and it is available only
because the anatomy is generated rather than measured.

**The ramp is real and verified.** Mean intensity by distance from the surface:

| sdf | mean T1 |
|---|---|
| −1.0 … −0.5 mm | 0.465 |
| −0.5 … 0.0 mm | 0.354 |
| 0.0 … +0.5 mm | 0.180 |
| +0.5 … +1.0 mm | 0.000 |

145,887 voxels now sit at intermediate intensity, where previously there were
**zero**.

## The result

| | before | after |
|---|---|---|
| Dice | 0.8907 | **0.8903** |
| background kept | 279,625 | 282,462 |
| real tissue cut | 12,402 | 11,023 |
| oversize | +22.2% | **+22.6%** |
| error within 2 mm (sulci bridged) | 88% | **88%** |

Nothing moved. Slightly worse, within noise.

## Why the prediction was wrong — again

Experiment 0 concluded "partial-volume ramp first, because it is what defeats
the surface fit". **That inference was wrong.**

BET's model is *brain inside skull*. It uses the bright-scalp / dark-skull
signature to establish an OUTER BOUND for its deformable surface. There is no
skull here at all, so nothing stops the surface expanding — and a 1 mm intensity
ramp at the pial surface does not supply an outer bound. The error is 88%
bridged sulci both before and after, which is the same failure unchanged.

**The binding constraint is the missing skull, not the missing ramp.**

## Corrected priority

1. **Skull and scalp** — the actual blocker for anything skull-strip shaped.
2. Rician noise.
3. Bias field.
4. ~~Partial volume~~ — done, and kept. It is still correct and still needed for
   tissue segmentation and registration boundary accuracy, both of which model
   partial volume explicitly. It simply does not fix BET, and claiming it did
   would have been the easy thing to write.

## The lesson worth keeping

Two predictions in a row, both wrong, both cheap to falsify because the loop is
8.5 s. The value of the loop is not speed for its own sake — it is that a wrong
idea costs a minute instead of a week. Had this been queued on the remote box in
a batch with the noise model and the bias field, all three would have shipped
together and the credit would have gone to whichever was listed first.

---

# The gate was wrong. All three conclusions above rest on a meaningless target.

Before adding a third thing to chase the number, I finally asked what BET scores
on a **real** T1 measured the same way. It should have been the first
measurement, not the fourth.

## The reference value

FSL `bet` on `sample`'s own `T1.mgz`, scored against parenchyma from its
`aparc+aseg` — identical metric, identical code path:

| | Dice | oversize |
|---|---|---|
| real T1, f=0.3 | 0.4518 | +242.6% |
| real T1, f=0.5 | 0.6100 | +123.3% |
| real T1, f=0.6 | 0.6744 | +85.9% |
| **synthetic, best over f** | **0.8838** | +18.1% |

**The synthetic image does not do worse than a real brain by this metric. It
does considerably better.**

## Why

BET produces a *brain plus surrounding CSF and dura* mask. That is what brain
extraction means, and it is what downstream tools expect. It never claimed to
reproduce the pial surface. Scoring it against a voxel-exact parenchyma mask
measures a thing the tool does not attempt — so 0.89 was never a failing grade
and "22% oversize" was never a defect. A real brain is 86–243% oversized by the
same yardstick.

Third time this project has built a gate that scored the wrong thing (#39 stroke
Dice against a cortex-only truth, #43 a gate exercising a code path nobody ran).
The tell is identical each time: a number that looks plausible, and no reference
value to compare it against.

## What the earlier conclusions are actually worth

- *"BET fails quietly, 22% oversized"* — **withdrawn**. It is 18–22% oversized
  where a real brain is 86%. That is not a failure.
- *"Partial volume first, it is what defeats the surface fit"* — **withdrawn**,
  and it was already falsified by measurement before this.
- *"The binding constraint is the missing skull"* — **withdrawn**. The skull
  bounded the surface exactly as predicted (oversize 22.6% → 16.1%, and −0.5% at
  f=0.7), but the metric it was aimed at was meaningless.

What survives: partial volume and the skull are both anatomically correct and
both stay. They are needed by tissue segmentation and registration, which model
partial volume explicitly, and no skull-strip evaluation of any kind is possible
without a skull to strip. Neither is justified by the BET numbers, and the commit
messages that implied otherwise were wrong.

## The corrected gate — which the roadmap already specified

Phase 2 in `ROADMAP.md` says, in writing:

> Validate it by **effect on real tools**: run FSL BET, FAST, or SynthSeg across
> a sweep of SNR and bias severity, and require their performance to degrade in
> the direction and roughly the magnitude they degrade on real data.

That is the right gate. I wrote it, then implemented "does BET get the right
answer on synthetic", which is a different and much weaker question.

**The realism signal is the DIFFERENCE between synthetic and real behaviour, not
the absolute score on synthetic.** By that measure the current image is
identifiably synthetic in a specific, quantified way: BET oversizes it by 18%
where it oversizes a real brain by 86%, because the image has thin uniform CSF
and none of the dura, cisterns or tentorium that a real vault contains.

That is a concrete, falsifiable target for the next attempt, and it is the first
one in this document that is measured against a reference rather than against
an assumption.

---

# The realism gate, and its baseline

`tools/realism/realism_gate.py` — runs the same tool at the same settings on the
synthetic image and on a real T1, and reports the **delta**. It never reports a
synthetic score on its own, because that is the mistake that cost three rounds
above.

## Baseline, 2026-08-18

| f | synthetic Dice / oversize | real Dice / oversize | Δ oversize |
|---|---|---|---|
| 0.3 | 0.8809 / +22.5% | 0.4518 / +242.6% | −220.1 pt |
| 0.4 | 0.8828 / +18.9% | 0.5077 / +192.9% | −174.0 pt |
| 0.5 | 0.8830 / +16.1% | 0.6100 / +123.3% | −107.2 pt |
| 0.6 | 0.8838 / +18.1% | 0.6744 / +85.9% | −67.8 pt |
| 0.7 | 0.8328 / −0.5% | 0.6844 / +46.4% | **−46.9 pt** |

**Closest agreement: 46.9 percentage points at f=0.7.** That is the number Phase
2 reduces. A realistic image drives it toward zero.

## A second signal, visible in the table

Look at how each column responds to `f`. Across the sweep the REAL image's
oversize collapses 242.6% → 46.4%, while the synthetic barely moves, 22.5% →
−0.5%. BET's threshold has far more to grip on in a real head — dura, cisterns,
the tentorium, the neck, noise — whereas the synthetic image is nearly
threshold-insensitive because there is so little non-parenchyma inside the
vault.

**Sensitivity to a tool's own parameter is itself a realism signal**, and it
points at the same missing anatomy the oversize gap does.

## Caveat, stated rather than buried

The two ground truths are not symmetric. The synthetic side is exact — the
geometry is generated, so `sdf < 0` is the answer by construction. The real side
is a FreeSurfer segmentation, which is an estimate with its own error. The delta
is still the right quantity because each side is scored against the best truth
available for it, but a change in the delta of a few points should not be read
as meaningful.

## Next

- **Add FAST** to the harness. Tissue segmentation models partial volume
  explicitly, so it is where the PV ramp should show a benefit — or fail to,
  which is equally worth knowing.
- **Widen the real reference beyond one subject.** 40 AOMIC subjects are already
  recon-all'd; a distribution turns "is the synthetic close?" into "is the
  synthetic inside the real range?".
- Then cisterns and dura, which is what the gap actually points at.

---

# FAST added to the harness — and it gives an unambiguous answer

BET turned out to be a poor probe: it scores the synthetic image *better* than a
real one, because its output is a generous brain-plus-CSF mask and any metric
built on that is arguable. FAST is not arguable.

## The result

| | synthetic | real |
|---|---|---|
| FAST 3-class fit converged | **No** | Yes |

FAST segments the real brain fine and **cannot segment the synthetic one at
all**. It prints `MeaNsK variance nan` and collapses all three tissue classes
into one — while exiting 0, which is how the first version of this harness
recorded `CSF 1.0000, GM 0.0000, WM 0.0000` as though it were data.

**A tool refusing to process the image is the least ambiguous realism signal
available.** No choice of metric can flatter it, which is exactly the failure
mode the BET work fell into.

## Diagnosis, after two wrong guesses

- *Zero variance in tissue interiors?* Measured coefficient of variation within
  bands: synthetic WM 0.015, real 0.018. Comparable. **Wrong** — and wrong
  because the measurement was badly built: selecting voxels *within* a narrow
  intensity band imposes that band's width as the apparent spread.
- *Intensity scale too small (0–0.78 vs 0–129)?* Scaled by 200 and re-ran.
  Still `MeaNsK variance nan`. **Wrong.**
- **Mass concentration.** Measured properly, on the BET-extracted brain:

  | | top-2 intensities hold |
  |---|---|
  | synthetic | **49.9%** of voxels |
  | real | 13.0% |

  Half the synthetic image sits on two exact values. A Gaussian fitted to a
  delta spike drives its component variance to zero, and the fit dies.

## What this makes the next step

**Rician noise, on evidence rather than intuition.** Noise is not decoration
here — it is what turns two delta spikes into two distributions and makes the
image fittable at all. The target is unambiguous and binary: FAST must converge.

Note this reverses the priority twice over. The original guess was partial
volume, then skull. Both are anatomically right and both stay, and neither was
the blocker. Noise was, and it took a tool that fails loudly to show it.

## Harness change

A collapsed fit is now recorded as a **result**, not an abort. A tool declining
to run is a measurement, and the harness that hides it is worse than no harness
— which the first version demonstrated by reporting the collapse as clean data.

---

# Rician noise — the first unambiguous pass

Added deterministic Rician noise to the export, σ = 0.02 in the 0..1 intensity
units where white matter sits at 0.78, i.e. **SNR ≈ 39** in WM — inside the
20–100 range a real T1 occupies.

Deterministic on purpose: a per-voxel hash of position and seed, never a clock,
because Phase 0's gate requires that the same spec exported twice produces
identical SHA-256 digests. Rician rather than Gaussian because an MR magnitude
image is the modulus of a complex signal with noise in each channel, so it adds
in quadrature.

## The binary target: FAST must converge

| | before | after |
|---|---|---|
| FAST 3-class fit, synthetic | **collapsed** | **CONVERGED** |
| top-2 intensities hold | 49.9% | **1.0%** (real: 13.0%) |
| background | exactly 0.000 | 0.0376 mean, Rayleigh |

Half the image no longer sits on two exact values, the mixture has variance to
fit, and FAST segments it. **This is the first unambiguous pass in the whole
sequence** — not a score that needed interpreting, a tool that could not run and
now runs.

The background is a free consequence worth noting: Rician noise on zero signal
is Rayleigh-distributed with a positive mean, so air is no longer exactly zero.
Real skull-strippers expect signal outside the head, and this image had none.

## Now the full comparison, which is the point of the harness

| | synthetic | real | delta |
|---|---|---|---|
| CSF fraction | 0.1722 | 0.2318 | −0.060 |
| GM fraction | 0.4026 | 0.4270 | −0.024 |
| WM fraction | 0.4253 | 0.3413 | **+0.084** |
| MIXED voxels | 0.1932 | 0.3196 | **−0.126** |
| mean peak PVE | 0.9413 | 0.8936 | +0.048 |
| BET oversize gap | | | 45.9 pt (was 46.9) |

Two honest readings:

**GM/WM balance is off by ~8 points.** The synthetic image is white-matter
heavy relative to a real brain. That is a property of the tissue-class mapping,
not of the noise.

**MIXED is 19% against 32% real.** The partial-volume ramp put real mixed
voxels into the image — there were essentially none before — but a real brain
has *two thirds again* as many. One voxel of ramp at the outer surface is not
the same as graded boundaries throughout, and interior GM/WM boundaries are
still sharper than life.

So the PV ramp finally has a measurement that can see it, and that measurement
says it is real but insufficient. That is a far more useful verdict than
anything BET produced.

## Where the numbers stand

| target | value |
|---|---|
| FAST converges | ✅ pass |
| BET oversize gap | 45.9 pt (from 46.9) |
| MIXED gap | 12.6 pt |
| WM fraction gap | 8.4 pt |

Three quantified gaps, all measured against a real brain rather than an
assumption. The next change either moves them or it does not.

---

# Interior partial volume — supersampling, and every gap narrows

The MIXED gap said the outer-surface ramp was real but insufficient: 19.3%
against 32.0% real. The fix is not a tuning knob on the grey/white curve — it is
that **a voxel is a volume, not a point.** Its intensity is the average of tissue
across it, and that averaging *is* partial volume. Sampling only the voxel centre
is precisely what a scanner does not do.

## Two changes, both principled rather than tuned

**2×2×2 supersampling.** The intensity computation moved into `intensityAt()`
and is evaluated at eight quarter-points inside each voxel, then averaged.
Analytic SDF coverage is kept alongside it rather than replaced — the distance
field locates the boundary far more precisely than eight samples could.

**Dropped `smoothstep(0.15, 0.75)` on the grey/white membership.** That curve
exists to keep the *render* crisp on screen; it is a look, and it does not belong
in a synthetic scan. The props channel is already a continuous tissue membership,
so using it directly is the physical reading and leaves the graded boundary
intact.

## Result

| | before | after | real | gap |
|---|---|---|---|---|
| MIXED voxels | 0.1932 | **0.2734** | 0.3196 | 12.6 → **4.6 pt** |
| GM fraction | 0.4026 | **0.4325** | 0.4270 | −2.4 → **+0.6 pt** |
| WM fraction | 0.4253 | **0.3804** | 0.3413 | +8.4 → **+3.9 pt** |
| CSF fraction | 0.1722 | **0.1871** | 0.2318 | −6.0 → **−4.5 pt** |
| mean peak PVE | 0.9413 | **0.9114** | 0.8936 | +4.8 → **+1.8 pt** |

**Every gap narrowed, and GM fraction essentially closed** — 0.4325 against
0.4270, six tenths of a point. The white-matter excess more than halved.

Cost: none measurable. Export stayed at ~21 s despite 8× the texture sampling,
because the pass was bandwidth-bound on readback rather than on sampling.

## What is left, honestly

CSF is still 4.5 points low and BET's oversize gap barely moved. Both point the
same way, and it is the same thing the very first BET result pointed at: this
head has a thin uniform 2.5 mm CSF shell where a real one has cisterns, sulcal
CSF of varying depth, dura and a tentorium. That is anatomy, not acquisition —
the remaining Phase 2 items (bias field) will not touch it.

## Scorecard

| target | status |
|---|---|
| FAST converges | ✅ |
| GM fraction | ✅ 0.6 pt |
| mean peak PVE | 1.8 pt |
| WM fraction | 3.9 pt |
| MIXED voxels | 4.6 pt |
| CSF fraction | 4.5 pt |
| BET oversize | ~46 pt — anatomy, not acquisition |
