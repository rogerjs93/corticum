# corticum — assessment and roadmap

An honest account of what the first public release (2026-08-14) does well, what
it does not do, and the planned work that follows from that. Written to be read
by someone deciding whether this tool is useful to them, so the limitations are
stated as plainly as the strengths.

corticum today is a strong teaching tool and a provisional research one. The gap
is not rendering quality or physics; it is **citability, interoperability, scale
and external validation**. A supervisor cannot cite a browser tab, a normative
connectome cannot read world-space coordinates, a benchmark of one brain is a
demo, and a disease model that has only ever been checked against itself is an
assertion.

The roadmap below closes that gap without abandoning the teaching identity. Most
items serve both, because the same machinery that generates a validation cohort
also generates an unlimited supply of unseen teaching cases.

---

## State at the first public release

### What it does well

**Pathology is emergent rather than authored.** Atrophy is a signed-distance
offset, and adding a positive scalar to an SDF *is* erosion — so sulcal widening
and ex-vacuo ventricular enlargement fall out of one line rather than being
drawn. Mass effect is the exponential of a stationary velocity field, invertible
by construction. All four pathologies write into the same three fields, so
comorbidity composes with no special-casing. This is the core architectural claim
and it holds.

**Verification is measured, not asserted, and the strongest gates have an axis
independent of the model.** Anatomy scores Dice 1.0000 against `aparc+aseg` with
zero differing voxels; the diffeomorphism round-trip is capped at 0.051 mm;
picks are cast through the real screen path and scored in Python at 20/20; the
NIfTI export is re-read with `nibabel` and required to land a lesion in the
commanded octant. The laterality bug — where an M1 occlusion infarcted both
hemispheres and still scored Dice 0.948 because model and gate shared a
side-blind lookup — was caught only by adding a spatial midline test. That class
of failure is the reason the independent-axis rule exists here.

**Negative results are published alongside positive ones.** The delta/alpha ratio
does not lateralise to the lesion in the shipped cohort (54%, chance), and the UI
is explicitly forbidden from implying otherwise. Most tools would omit this.

**Evidence tags are load-bearing.** Every parameter is marked `literature`,
`derived` or `plausible-approximation` in the panel, because a teaching tool that
cannot distinguish what the evidence says from what looks about right is worse
than no teaching tool.

**Some behaviour is genuinely emergent.** Collaterals alone leave ASPECTS at 0,
early reperfusion alone leaves it at 0, and both together give 10 — the
fast-progressor/slow-progressor distinction behind thrombectomy selection.
Nothing encodes that; it falls out of the growth term meeting the collateral
rescue term. Watershed zones are likewise derived from smoothed territory
membership rather than drawn.

**Two outputs nothing comparable offers.** Ground-truth NIfTI export carrying the
**true** displacement field, so a recovered warp can be scored exactly rather
than against another estimate. And a split counterfactual view — the same brain
with and without disease — which no viewer can provide, because the healthy
version of a diseased brain does not exist as data.

**It runs anywhere with WebGPU**, at 60 fps on a 4 GB card, with no install and a
~6 MB payload.

### What it does not do

**The synthetic image is the weakest link, and it gates the most valuable use.**
It is a tissue-class mapping: no noise, no bias field, no partial-volume model,
no skull or scalp. A registration or segmentation method benchmarked on it will
score unrealistically well and then fail on clinical data, which inverts the
purpose of a benchmark.

**There is no connectivity layer and no standard space.** Exports land in
subject/world coordinates while every normative connectome and published atlas
lives in MNI152, so the tool cannot currently feed the lesion-network-mapping and
connectome pipelines it is otherwise well suited to.

**It has never been externally validated.** No standard neuroimaging pipeline has
ever been run on its output. Every gate to date tests internal consistency or
agreement with the source segmentation — necessary, but not evidence that
simulated disease resembles real disease.

**Rates are uncalibrated, by explicit admission.** The sequence of events follows
the literature; the timings do not. Braak stages do not advance on a schedule,
and the stroke core-growth clock is documented as faster than DEFUSE-3 and DAWN
imply — which is why the collateral gate has to compare at 6 h rather than 24 h.

**Scale is two subjects.** Browser-side ingest of a FreeSurfer subject works and
is verified, but there is no batch path, no cohort generation and no headless
mode, so nothing here can produce a dataset.

**CI validates types and nothing else.** Lint and `tsc` gate the publish; every
operator, staging, stroke, export and split gate is manual. A regression in the
physics the project rests on would ship silently.

**Exports are not citable.** There is a build timestamp but no semantic version,
parameter record, seed or content hash, so a result produced with this tool
cannot be referenced or regenerated by a reader.

**Lesion geometry is idealised.** Haematomas are spheres, infarct boundaries are
smooth, and expansion is applied to every bleed where roughly a third expand in
life.

**Known modelling gaps already documented in `CLAUDE.md`:** deep grey atrophy
arises only where a structure abuts CSF, so a structure whose loss is not
adjacent to a free surface is under-represented; MTA stops rising between Braak
IV and VI because of the staging weight table; Fazekas rides on the MS plaque
field and should be read as "how much white matter lesion is present", not as a
small-vessel grade; there is no intraventricular extension and no ICH score;
residual 8-bit blockiness remains in the curvature channel; and `sulc.i8.gz`
ships unused because the procedural sub-voxel detail pass was never built.

**WebGPU only, by design.** The architecture rests on compute shaders writing 3D
storage textures, which WebGL2 cannot do, so there is no fallback renderer and
most phones cannot run it.

### How to read this

The strengths are real and the limitations are not fatal — but they do determine
what the tool may currently be used *for*. It is ready for teaching and for
exploring parametric pathology. It is not yet ready to benchmark a method, to
supply a cohort, or to support a claim that simulated disease matches real
disease. The roadmap below is ordered to change that.

## Definition of done

**As a research instrument.** A researcher can generate a cohort of pathological
brains with known ground-truth deformation, in a standard space, from a script,
cite the exact version and parameters that produced it — and point to evidence
that a standard neuroimaging pipeline recovers from those brains the same effect
sizes it recovers from real patients.

**As a teaching tool.** All of the above, plus the live parametric exploration
that already works, plus guided cases that ask the learner to decide rather than
to watch.

---

## Hardware reality — this is a two-machine plan

| | Windows box (this PC) | Horizon (remote Ubuntu) |
|---|---|---|
| Role | corticum: generation, export, rendering | FreeSurfer, FSL, ENIGMA extraction |
| Spec | GTX 1050 Ti 4 GB, 4 cores, 15.9 GB RAM, 279 GB free on E: | 2 cores, Xeon Gold 6548N, ~5x typical throughput |
| Limits | fill-rate bound, not VRAM bound (~374 MB budgeted) | **wall time** — `recon-all -autorecon1` ~11 min/subject; full recon-all ~1.5–2 h |

**The binding constraint is recon-all wall time, not the GPU.** A 20-subject
cohort is 30–40 hours of processing on Horizon. Cohort size must therefore be
chosen deliberately and justified, never maximised. Everything in this roadmap is
sized to that reality.

**Storage.** Native-resolution export is 208³ @ 1 mm — required, because 128³ is
~1.6 mm and recon-all will not behave normally on it. Budget for the full three
volumes per subject plus FreeSurfer output; E: has room for a cohort in the low
tens, not hundreds.

---

## Experiment 0 — run this before building anything

**Hypothesis.** The current synthetic T1 is realistic enough for `recon-all` to
process, or it is not, and which stage breaks first tells us exactly what the
acquisition model has to satisfy.

**Method.** Export one healthy synthetic T1 at 208³. Run `recon-all -autorecon1`
on Horizon — skull-strip and intensity normalisation, which is precisely where an
image with no skull and no bias field should fail. ~11 minutes.

**Why this first.** Either it fails informatively, and Phase 2's scope is defined
by the failure rather than by my guesswork, or it partially survives and the
acquisition model needs less than expected. Both outcomes are worth more than a
week of speculative work. Do not start Phase 2 before this runs.

---

## The variance problem — read before planning any cohort

With one subject and deterministic operators, every simulated patient is
identical, between-group variance is zero, and Cohen's *d* is meaningless. **Real
anatomical variance is required for any ENIGMA comparison to mean anything.**

The solution is already on disk: the **40 AOMIC ID1000 subjects** already
processed through recon-all for the ENIGMA teaching work. corticum's browser-side
ingest accepts exactly what those produce (`aparc+aseg` as `.nii`/`.nii.gz`, and
it is verified against the Python builder at label agreement 1.0000 and inside-mask
Dice 1.0000). So the substrate is real anatomical variation, and only the
pathology is simulated. No new anatomy needs to be acquired or processed.

This also means **Phase 3 (headless) is a hard prerequisite for validation**, not
a convenience: ingesting 40 subjects one at a time through a file-open dialog is
not a pipeline.

---

## Phase 0 — Make it citable

**Why.** Nothing this tool produces is currently referenceable. A paper needs
"corticum v1.2.0, subject X, these parameters, seed Y" and a way to regenerate it.

**Work**
- Semantic version in `package.json`, surfaced in the UI and stamped into exports.
- JSON sidecar beside every exported NIfTI: version, full parameter set, subject
  id, seed, grid dim, content hash per volume.
- Determinism audit: same spec twice on the same GPU, diff the exports. Document
  what is bit-stable and what is not.

**Gate.** Two runs of one spec produce identical hashes; one changed parameter
produces a different hash; the sidecar alone suffices to reconstruct the run.

**Document, don't solve.** Cross-GPU bit-identity is not attainable (driver
floating point). State the tolerance rather than implying reproducibility you
cannot deliver.

**Effort** S. **Risk** low. **Runs on** this PC.

---

## Phase 1 — Make it addressable (MNI152 export)

**Why.** Highest research value per unit effort in this document. Every normative
connectome, published atlas and lesion-network-mapping pipeline lives in MNI152.
corticum exports in subject/world space, which makes it a closed world.

**Work**
- Register shipped subjects to MNI152 once, offline on Horizon (FLIRT/ANTs); ship
  the transform beside the field payload.
- Export lesion masks, composed field and displacement field in MNI152 alongside
  native.
- Warp the displacement field's **components**, not only its grid — the same trap
  already documented for the RAS permutation applies again.

**Gate.** Independent axis: load the MNI export in `nibabel` and require a lesion
placed at a known anatomical target to land within tolerance of that structure's
coordinates in a **published** MNI atlas — not corticum's own parcellation. A gate
scored against the internal LUT only checks self-consistency.

**Effort** S–M. **Risk** low. **Runs on** both (transform computed on Horizon,
applied here).

---

## Phase 2 — Make it honest (acquisition realism)

**Why.** The synthetic T1 is a tissue-class mapping: no noise, no bias field, no
partial-volume, no skull. A method benchmarked on it scores unrealistically well
and then fails clinically, which inverts the purpose. This is the single biggest
limitation on the research claim — and it gates all ENIGMA work, because
recon-all's surface placement depends on the partial-volume gradient that the
current image does not have.

**Work** (scope set by Experiment 0's failure mode, not by this list)
- Rician noise at controllable SNR.
- Smooth multiplicative bias field.
- Partial-volume mixing at tissue boundaries instead of hard class assignment.
- Skull and scalp, so skull-stripping is a step that can fail rather than be
  skipped.
- Optional: parameterise by TR/TE/TI with per-tissue T1/T2/PD, making "synthetic
  T1" defensible rather than hand-tuned.

**Gate — ENIGMA as a realism test.** Do not judge realism by eye. Run the **full
ENIGMA structural protocol** on a *healthy* synthetic brain and require the 14
subcortical volumes and 68 cortical thickness values to land inside the normal
range of ENIGMA control cohorts. Realism is a claim about how standard software
behaves, so standard software must be the judge — and the same pipeline is
already built and validated here against the consortium.

**Effort** M. **Risk** medium; over-claiming is easiest here. Evidence tag stays
`plausible-approximation` until the gate passes.

**Runs on** this PC (generation) + Horizon (recon-all, ~2 h per test brain).

---

## Phase 3 — Make it plural (headless driver and cohorts)

**Why.** A cohort of one is a demo, you cannot batch-generate from a browser
window, and 40-subject ingest needs a pipeline. Prerequisite for Phases 4 and 5.

**Feasibility is already established.** Compute dispatch goes through Babylon's
`ComputeShader`, but every compute shader is **plain WGSL** with `//!include` — a
structural choice made for verifiability — and `tests/node/wgsl_validate.mjs`
already resolves those includes against Dawn's Node bindings. The shaders are
portable; only the dispatch layer is not.

**Work**
- Thin direct dispatch layer over the `webgpu` Dawn bindings, replacing Babylon's
  `ComputeShader` for the ~8 compute passes the export path needs. Reuse the
  existing Node include resolver — two loaders, one rule, is already the convention.
- Batch ingest of FreeSurfer `aparc+aseg` (the 40 AOMIC subjects).
- Cohort spec (JSON): subjects, pathology, parameter ranges, N, seed.
- CLI: `corticum generate cohort.json --out ./cohort/`.

**Gate.** For the same seed and spec, headless export must match browser export
within a stated tolerance. Everything downstream rests on this; a headless path
that silently diverges poisons every cohort generated from it.

**Effort** L — the largest item here. **Risk** medium-high. **Mitigation:** port
the export path only. Rendering stays browser-only forever; no cohort needs pixels.

**Runs on** this PC.

---

## Phase 4 — Make it trustworthy (gates in CI)

**Why.** CI runs lint and `tsc` — it validates types and nothing else. Every
operator, staging, stroke, export and split gate is manual, so a regression in the
physics the project rests on would ship silently. Largest reliability gap.

**Work**
- Run operator, staging and export gates headlessly on every push via the Phase 3
  driver.
- Keep hardware gates (frame time, picking, pixel-scored comparisons) manual and
  say so, alongside the existing note about `npm run wgsl`.

**The trap.** CI runners have no real GPU and fall back to a software adapter;
numeric results will differ from the 1050 Ti. CI gates must be **structural or
tolerance-based** — healthy state produces exactly zero displacement, round-trip
under threshold, core is a subset of hypoperfusion — never exact values calibrated
on hardware. A gate passing for the wrong reason is worse than no gate; that is
this project's most expensive recurring lesson, applied to its own pipeline.

**Effort** M, gated on Phase 3. **Risk** low once 3 lands.

---

## Phase 5 — Make it validated (ENIGMA effect-size profile)

**Why this replaces the ADNI plan.** ADNI gives an atrophy *rate* — one scalar per
structure to fit. ENIGMA gives an **effect-size profile across ~14 subcortical
structures and 68 cortical regions at once**, so the test is whether the operators
reproduce the *spatial pattern* of real disease, not a single number. Far harder
to pass by accident. And the pipeline is already built and validated here against
the consortium (right hippocampus d = −0.43 against their −0.46).

**Method**
1. Ingest the 40 AOMIC subjects as anatomical substrate (real between-subject
   variance — see the variance section above).
2. Split into simulated case/control. Apply Braak-staged AD to the cases.
3. Export synthetic T1 at 208³ per subject.
4. Run the full ENIGMA structural protocol on Horizon.
5. Compute Cohen's *d* per structure and correlate that profile against ENIGMA's
   published AD meta-analysis.

**Gate.** Correlation across structures between simulated and published effect-size
profiles, with the *pattern* as the claim — not agreement on any single structure.
Pre-register the threshold before running, or it is a fit rather than a test.

**The genuinely novel output.** corticum knows the **true** volume of every
structure (it already integrates the composed field). So three quantities become
comparable where the field can normally get only two:

| | |
|---|---|
| 1. True volume | corticum's own integration |
| 2. Measured volume | FreeSurfer, from the synthetic image |
| 3. Published value | ENIGMA meta-analysis |

The gap between 1 and 2 is **FreeSurfer's measurement error scored against ground
truth**, which is unobtainable on real data because nobody knows a living
hippocampus's true volume. That is a result in its own right, and it is precisely
the "how much of a biomarker is biology and how much is pipeline" question.

**Cohort sizing.** At ~2 h/subject, 40 subjects is ~80 h on Horizon. Run in two
batches and check the healthy arm first — if Phase 2's realism gate passes on
controls, the case arm is worth the compute; if it does not, stop.

**Scope limits, stated now**
- **Structural only.** No diffusion model, so ENIGMA-DTI is out of reach without
  simulating FA/MD — a large separate build.
- **AD is the right first target** — Braak staging gives a specific predicted profile.
- **PD is a poor fit** — modelled as neuromelanin loss, not atrophy; ENIGMA-PD's
  structural effects are subtle.
- **Stroke does not apply** — ENIGMA Stroke Recovery is lesion-outcome, not volumetry.

**Effort** M–L, mostly compute wall time. **Risk** medium. **Runs on** both.

---

## Phase 6 — Make lesions real

**Why.** Haematomas are spheres and infarct boundaries are smooth. For network
mapping, lesion *shape* matters — real infarcts have irregular boundaries following
vascular anatomy. The machinery exists in the perfusion model.

**Work**
- Derive irregular lesion masks by thresholding the perfusion field with spatial
  noise, instead of drawing primitives.
- Irregular haematoma morphology; expansion applied to a realistic subset rather
  than to every bleed (currently all expand; roughly a third do in life).

**Gate.** Shape statistics — compactness, surface-to-volume ratio, boundary
irregularity — fall within the distribution measured from a real lesion dataset
(ATLAS v2.0 stroke segmentations are public and suitable).

**Effort** S–M. **Risk** low. Serves teaching and research equally.

---

## Phase 7 — Deepen the teaching identity

**Why.** The education side should strengthen as the research side does. Everything
below reuses machinery built above; Phase 3 cohorts give an unlimited supply of
unseen cases.

**Work**
- Guided cases requiring a **decision**, not observation: given this DWI, this
  FLAIR and this clock, would you thrombolyse? The DWI-FLAIR mismatch, ASPECTS and
  perfusion mismatch readouts already support this end to end.
- Case generator drawing from Phase 3 cohorts so learners never see one brain twice.
- Self-check revealing ground truth *after* the learner commits — something no real
  teaching case can offer.

**Gate.** A case cannot ship unless every clinical claim in its feedback carries an
evidence tag, same rule as the parameter panel.

**Effort** M, ongoing. **Risk** low. **Runs on** this PC.

---

## Cross-cutting rules

1. **Every gate needs an axis independent of the model.** Restated because it is
   this project's most expensive recurring lesson and has already produced two
   gates that passed for the wrong reason. The ENIGMA alignment is valuable
   precisely because FreeSurfer and the consortium share no code or assumptions
   with the thing under test.
2. **Evidence tags are load-bearing.** A parameter leaves
   `plausible-approximation` only when a gate says so, and only that parameter.
3. **Nothing is done until it has been run and observed.**
4. **Publish the negative results.** The delta/alpha ratio finding is a credibility
   asset; the same standard applies to anything Phase 5 fails to reproduce.
5. **Compute is the scarce resource.** Every cohort run on Horizon costs tens of
   hours. Decide n in advance, justify it, and check the cheap arm first.

## Explicitly not doing

- **Rendering headlessly.** Only the export path needs portability. Pixel-identical
  offscreen rendering would cost weeks and serve nothing.
- **A WebGL2 fallback.** The architecture rests on compute shaders writing 3D
  storage textures; the right answer stays a clear unsupported message.
- **Simulating diffusion.** Large separate build; revisit only if the structural
  ENIGMA loop succeeds.
- **More pathologies before the existing ones are validated.** Breadth is the easy
  axis and would dilute the claim rather than strengthen it.
