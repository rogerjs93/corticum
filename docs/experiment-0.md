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
