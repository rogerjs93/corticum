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
