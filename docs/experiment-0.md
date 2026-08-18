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
