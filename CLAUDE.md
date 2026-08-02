# corticum

A real-time parametric brain renderer. WebGPU + Babylon.js + hand-written WGSL.
No textures, no meshes, no HDRIs and no animation data in the repository —
everything visible is generated on the GPU at load time from a small
MRI-derived field.

Full plan (phases, architecture, verification): `C:\Users\roger\.claude\plans\i-want-to-create-starry-diffie.md`

## Stack / constraints (and why each pin exists)

| Pin | Reason |
|---|---|
| **Vite `^6.4.3`** | Node here is **v20.15.1**; Vite 7 needs ≥20.19. Same trap as arlabeler. Do not `npm create vite` onto latest. |
| **`@babylonjs/core` 8.56.2** (exact) | Essentially the whole corpus of WebGPU-compute forum answers and playgrounds targets 7.x/8.x. 9.19.0 exists — re-run the Phase 0 spike against it before moving. |
| **`@oxlint/binding-win32-x64-msvc` as a direct devDependency** | oxlint ≥1.20 declares `engines.node ^20.19 \|\| >=22.12`, so npm **skips its native binding as an optional dep** on Node 20.15 and `npx oxlint` dies with "Cannot find native binding". The binary itself runs fine on 20.15 — the constraint is conservative. Declaring it directly forces the install. Makes linting win32-x64-only, which is acceptable here. |
| **`webgpu` (Dawn node bindings) `^0.4.0`** | Real Tint validation headlessly. Binds the **actual D3D12 adapter** on this machine, not SwiftShader. |

GPU target: **GTX 1050 Ti, 4 GB** (Pascal). VRAM is not the constraint (~374 MB
budgeted); **fill rate is** — 112 GB/s and the march is bandwidth-bound.

## Shader dialects — the most important convention here

There are **two incompatible WGSL dialects** in this project. Confusing them is
the single easiest way to waste an afternoon.

- **`src/shaders/common/` and `src/shaders/compute/` — plain WGSL.**
  Explicit `@group(N) @binding(M)`, real entry points, standard syntax. A file
  containing only functions is a legal WGSL module, so **every one of these
  files is standalone-valid and is checked by `npm run wgsl`.**
- **`src/shaders/render/` — Babylon's preprocessed dialect.**
  `varying x : T;` / `attribute x : T;` / `uniform x : T;`, accessed as
  `vertexInputs.x`, `vertexOutputs.x`, `fragmentInputs.x`, `fragmentOutputs.color`,
  `uniforms.x`. **No `@group`/`@binding`** — Babylon injects them. Textures need
  a companion `var <name>Sampler : sampler;`. This is **not** valid standalone
  WGSL and is excluded from validation.

**Therefore: all real shader logic lives in `common/`, and `render/` files stay
thin wrappers.** That is a deliberate structural choice driven by
verifiability, not by taste.

Includes use `//!include <path-relative-to-shaders>`. It is a *comment*, so an
unresolved chunk is still parseable. Resolved by `src/engine/wgsl.ts` in the
browser and by `tests/node/wgsl_validate.mjs` on disk — two loaders, one rule,
keep them in step.

## Gotchas (hard-won in the Phase 0 spike — all verified on hardware)

1. **`engine.createComputeContext is not a function`** — you must
   side-effect import `@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader`.
   Nothing in the typings hints at it: the methods are declared on the engine
   interface whether or not the extension was loaded.

2. **`StorageBuffer` + `BUFFER_CREATIONFLAG_READ` is not enough.** Babylon maps
   `READ → COPY_SRC` and **never adds `COPY_DST`**, so `clear()` / `update()`
   fail validation. Use **`BUFFER_CREATIONFLAG_READWRITE`**. Worse: the invalid
   `ClearBuffer` **poisons the entire frame's command buffer**, silently
   discarding every dispatch recorded alongside it — the symptom is a compute
   result of all zeros with no error thrown.

3. **Babylon clears depth+stencil *between* rendering groups by default.** This
   silently defeats the whole hybrid design — the raymarch writes correct
   per-fragment depth, then the next group wipes it and every rasterized mesh
   draws on top. Fix:
   `scene.setRenderingAutoClearDepthStencil(group, false)` for every group
   above 0. **This one line is what makes raymarch and raster share a depth
   buffer.**

4. **`engine.readPixels()` returns the swapchain's native byte order — BGRA on
   Windows** (`getPreferredCanvasFormat() === 'bgra8unorm'`). Read it as RGBA
   and red/blue swap: a salmon isosurface comes back blue-purple and a yellow
   probe gets counted as a blue one. `readFrame()` in `src/spike/spike.ts`
   normalises this. Cost real debugging time — it looks exactly like a depth bug.

5. **`canvas.toDataURL()` / `drawImage(canvas)` yield a blank white image** on a
   WebGPU canvas (no preserved drawing buffer). Use `engine.readPixels()`.
   Again: looks like "the render is broken" rather than "the capture is broken".

6. **`mesh.setVerticesBuffer(vb)` needs an explicit `totalVertices`** when the
   buffer is a GPU-only `DataBuffer` — Babylon normally infers it from the
   CPU-side array, which does not exist. Omit it and `getTotalVertices()` stays
   0, the draw is skipped, and the mesh renders nothing, silently. Also set
   `mesh.isUnIndexed = true` and give it an explicit `BoundingInfo`, or it gets
   frustum-culled.

7. **`dispatchWhenReady` only guarantees the dispatch was *recorded*.** Before
   the render loop starts there is no frame boundary to submit it, so an
   immediate readback returns zeros. Render one frame first
   (`submitPendingWork` in the spike). Load-time field builds in Phase 1+ hit
   this directly.

8. **`navigator.gpu.requestAdapter()` took ~6.3 s cold** in the agent's browser
   pane. Not a hang — wait it out before concluding WebGPU is unavailable.

### Phase 1 additions (field upload + verification)

9. **NumPy C-order is z-fastest; WebGPU 3D textures are x-fastest.** A C-ordered
   `arr[x][y][z]` lays out z fastest, but a 3D texture indexes
   `x + y*W + z*W*H`. Uploading without `arr.transpose(2,1,0)` silently swaps
   the volume's X and Z axes — and it still looks like a brain from most
   angles, which is why it survived visual inspection and was only caught by
   Dice. See `to_gpu_order()` in `tools/prep/build_fields.py`.

10. **Voxel centres are at `(i + 0.5) / dim`, not `i / dim`.** Getting this
    wrong puts every sample exactly on a voxel boundary where trilinear
    filtering averages two neighbours. The anatomy still looks broadly right.
    Both the raymarch and the verification probe get this from one shared
    chunk, `common/field.wgsl` — if the probe had its own copy it could certify
    a field the renderer draws differently.

11. **Servers disagree about `*.gz`.** Vite's dev server sets
    `Content-Encoding: gzip` so the browser inflates transparently; GitHub
    Pages serves it as opaque binary. Trusting either breaks on the other, and
    double-inflating throws a bare `TypeError: Failed to fetch` that reads as a
    network problem. `fetchMaybeGz()` sniffs the two-byte gzip magic instead.

12. **A compute dispatch may not be submitted by the next `scene.render()`.**
    `dispatchWhenReady` only *records* it; which encoder it lands in is not
    under the caller's control, so with a render loop running the readback
    races. Most results come back correct and the occasional one is untouched
    buffer — silently, as plausible-looking zeros. For anything measured:
    poison the buffer with a sentinel, submit two frames, and refuse to return
    until every element was overwritten (`src/verify/sliceProbe.ts`).

13. **Float32 sentinels must be `Math.fround`ed.** `-1e30` is not exactly
    representable in float32, so `readValue === -1e30` compares float32 against
    float64 and is never true. The sentinel then survives undetected — and
    being negative, it packed as "inside" and reported a slice that was
    entirely brain. Exactly the failure the sentinel existed to prevent.

14. **`captureFrame` must render in the same task as the readback.** Relying on
    the running loop yields an all-zero read *including alpha*, which becomes a
    fully transparent PNG — and a transparent PNG is indistinguishable from a
    white one, so it reads as "the renderer is broken". `captureFrame` now
    takes a render callback and throws if the frame is fully transparent.

### Phase 2 additions (derived fields + shading)

15. **March the small texture; sample the big one once.** The most expensive
    mistake so far: moving the distance field into the 256³ `rgba8unorm`
    working field so it could carry extra channels. A ray takes ~40 distance
    samples and exactly ONE normal sample, so this changed 40 fetches/ray from
    1 byte out of a 9 MB texture to 4 bytes out of a 67 MB one — 4× the
    bandwidth with far worse cache locality. **Frame time went 15 ms → ~1000 ms
    at the same resolution.** Reverting the march to the shipped `r8unorm`
    payload and keeping the baked field for per-hit shading only gave
    **17.5 ms at full 1280×800**. Bandwidth on the hot path is the whole game
    on a 112 GB/s card.

16. **Baked normals beat central differences twice over.** Precomputing the
    normal into a 256³ texture removes 6–12 fetches per shaded pixel *and*
    looks better, because hardware filtering of a baked normal is smoother than
    differencing a filtered field. It also stays valid under the Phase 3 warp:
    it is the material-space normal, transformed by the inverse-transpose
    Jacobian.

17. **Never take a second derivative of an 8-bit field on adjacent voxels.**
    Curvature = Laplacian, and quantisation noise in a second difference scales
    as 1/h². At h = 1 voxel the curvature channel was pure speckle — invisible
    in specimen mode, glaring in x-ray. A ±3-voxel stencil cuts the noise ~9×
    and real cortical curvature is a millimetre-scale quantity that survives it.

18. **Class indices cannot be interpolated.** "Halfway between tissue class 1
    and class 3" is not class 2. Anything the shader needs to filter must be
    stored as a continuous membership (`props.b` = ventricle-ness,
    `props.a` = deep-grey-ness), not as a class id.

19. **`scene.render()` is the wrong way to flush compute at load time** — it
    requires a camera and a ready material, neither of which exists while the
    fields are being built. `engine.beginFrame(); engine.endFrame();` opens and
    closes the command encoder, which is all a dispatch needs.

### Phase 3 additions (disease operators)

21. **exp(w) is only a diffeomorphism while w is Lipschitz.** The guarantee is
    conditional, roughly `‖w/2ⁿ‖·L < 0.5`, and two things broke L:
    the compliance field's dural sheets jump 0.02 → 0.45 across ~1.5 voxels
    (a near-discontinuity, effectively infinite L), and the naive interior
    clamp `max(r, R/2)` let the lesion-centre velocity spike to 4R/3.
    Symptom: round-trip error with **mean 0.0004 mm but max 10.9 mm** — a
    handful of outliers, not a systematic bias. Fixes: blur the velocity field
    (`blur3d.wgsl`), extend the interior field as `A·r/max(r,R)³` which caps the
    magnitude at R/3, and raise the squaring count to 8. Worst-case error went
    **10.87 mm → 0.051 mm**, with zero points over threshold.

22. **Report distributions, not maxima, for field measurements.** A bare max
    cannot distinguish "systematically wrong" from "one outlier at a
    discontinuity", and those need completely different fixes. The probe now
    reports mean, p99 and the fraction over threshold.

23. **A manual quality override must disable the automatic ladder.** Without
    the flag, `setQuality` was overridden on the next frame and the two fought,
    each override calling `setHardwareScalingLevel` and reallocating the
    swapchain. This produced ~1 s stalls that looked exactly like a shader
    performance collapse. The tell was frame time being **non-monotonic in
    pixel count** (16k px slower than 64k px) — impossible for real fill-rate
    cost, so the measurement itself had to be at fault.

24. **Timing `scene.render()` in a loop measures nothing.** It records commands;
    the GPU work is asynchronous. A 30-frame loop of full-resolution raymarch
    "measured" 1.1 ms/frame. Use the render loop's own delta time, after letting
    it settle past the resize and shader-compile transients.

25. **Ping-pong parity is worth asserting.** With an even number of squarings
    the result lands back in the texture the chain *started* in, so `u_0` must
    be written to the target, not the scratch. The assertion caught this
    immediately; silently returning the wrong texture would have looked like a
    subtly wrong deformation.

### Phase 4 additions (mesh hybrid + picking)

27. **A compute module's UNUSED bindings are stripped from its pipeline layout.**
    The Surface Nets classify pass declared `verts` and `indices` (inherited
    from a shared chunk) but never touched them. Tint stripped them, Babylon
    still bound them per `bindingsMapping`, layout and bind group no longer
    matched — and **the dispatch silently did nothing**. No error, no warning.
    The only symptom was `cellSlot` staying zero, which made every cell look
    active and produced a plausible index count from a degenerate mesh.
    **Declare exactly what you use, and give each pass its own bindingsMapping.**

28. **Babylon's `entryPoint` option did not reliably select a second `main`.**
    Two ComputeShaders over one module with `entryPoint: 'classify'` /
    `'emit'` both ran the first function; the tell was a counter that came out
    exactly double. Split multi-pass algorithms into one file per entry point.

29. **Prefer `StorageBuffer.update()` over `.clear()` before a dispatch.**
    `clear()` is a recorded GPU command whose ordering against the following
    dispatch is not the caller's to control, and it raced: every `atomicAdd`
    returned 0. A queue `writeBuffer` (i.e. `update()`) is ordered before the
    commands that follow it.

30. **`scene.createPickingRay` needs `import '@babylonjs/core/Culling/ray'`.**
    Without it Babylon throws the bare **string** "Ray needs to be imported
    before…" — a string, not an Error, so `e.message` is `undefined` and the
    failure reads as an unhandled GPU fault. Same class as gotcha #1.

31. **Pick just INSIDE the surface, not on it.** The hit sits exactly on the
    parenchyma boundary, where the nearest label voxel is as likely to be
    background as tissue — picking the raw hit reported "Unknown" most of the
    time. Step ~1–4 mm along the ray into the tissue.

### Phase 5 additions (staging + demyelination)

33. **Sharp per-region quantities need resolution; smooth fields do not.**
    The offset field carries per-region atrophy, whose boundaries are sharp. At
    OP_DIM 64 (3.25 mm) the hippocampus spanned ~3 cells, most of which sampled
    a neighbouring label, and Braak-V hippocampal loss measured **1.94%** against
    a 15-30% literature range — while the staging *pattern* was already correct.
    Raising OP_DIM to 128 (1.625 mm) fixed it. The deformation half of the field
    is genuinely smooth and would have been fine at 64.

34. **A voxel-radius blur is not a physical-radius blur.** Doubling OP_DIM
    halved the velocity blur's physical smoothing distance, the Lipschitz bound
    rose, and the diffeomorphism round-trip drifted 0.051 → 0.123 mm, through
    the gate. `VELOCITY_BLUR_PASSES` must scale with `OP_DIM`.

35. **`createPickingRay` takes CSS pixels, not render pixels.** With the quality
    ladder at 4x the render buffer is 320x200 while the canvas is 1280x800, so
    passing `engine.getRenderWidth()/2` aims near the top-left corner and every
    ray misses. Use `canvas.clientWidth/clientHeight`. The interactive handler's
    `clientX - rect.left` was always correct; only programmatic callers broke.

36. **A counter-based probe cannot use the sentinel trick.** Counts start at
    zero, so "never written" and "genuinely zero" are the same bits. `VolumeProbe`
    measures twice and requires agreement instead — which is not theoretical: it
    produced two spurious gate failures when run straight after another probe.

37. **Never edit a `.wgsl` file with PowerShell `Set-Content -Encoding utf8`.**
    PS 5.1 writes a UTF-8 **BOM**, and Tint rejects it outright
    (`invalid character (UTF-8 BOM) found`). `Get-Content` also reads as ANSI by
    default, so any non-ASCII character round-trips into mojibake. Use the Edit
    tool, or `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`.

38. **Run verification probes in adversarial order.** Three of the bugs above
    only appeared when `verifyOperators` → `verifyStaging` → `verifyPicks` ran
    back to back. Each passed in isolation.

41. **A threshold tuned on one atlas is a gate on the atlas, not the model.**
    Absolute electrode-to-parcel distance scales with parcel size, so the same
    EEG projection scored 33 mm on Destrieux and 37 mm on Desikan-Killiany and
    tripped a bound calibrated on the first. Prefer a scale-free statistic — a
    RANK against the alternatives — whenever the natural units depend on a
    choice that is not the thing under test.

42. **Verify the artifact you ship, not the one you computed.** `eeg_forward.py`
    scored the raw projection matrix and then row-normalised it before writing.
    Row scaling can move a column's argmax, so the localisation report described
    a matrix that no longer existed. Both gates now run against the file the
    renderer loads.

39. **An id that omits a distinction cannot be gated on that distinction — and
    a gate built from the same id inherits the blind spot.** Territory ids carry
    no side, so an M1 occlusion infarcted both hemispheres, and the Dice gate
    scored it **0.948** because its ground truth was derived from the same
    side-blind `territoryOf`. Model and gate were wrong in the *same direction*,
    which is the one arrangement no amount of re-running catches. When a
    verification path derives its truth from the same table the model uses,
    the shared table is exactly what goes unverified — the gate must add an
    independent axis (here, a spatial midline test) or it is only checking
    self-consistency.

40. **Empty-space acceleration was measured out of the design.** A
    min-distance-per-block occupancy grid looked obvious, but the shipped field
    is clipped at ±16 mm so sphere tracing already steps ~14 mm through air,
    while an 8-voxel block is 6.5 mm. The block grid would have been *slower*.
    The version that would help is an unclipped coarse field (64³ over
    ±104 mm ⇒ ~57 mm steps, tens of kB gzipped) — only worth adding if the
    march, rather than the shading, is ever shown to be the bottleneck.

### Confirmed-good (no workaround needed)

- `RawTexture3D(..., Constants.TEXTURE_CREATIONFLAG_STORAGE)` really does
  produce a bindable `texture_storage_3d<rgba8unorm, write>`.
- `ComputeShader` with `{ computeSource }` + `bindingsMapping`, `atomicAdd`,
  and `StorageBuffer.read(..., noDelay=true)` all behave as documented.
- **`fragmentOutputs.fragDepth` works from a `ShaderMaterial`** — measured
  two-way against rasterized geometry, so the half-res RTT + bilateral
  fallback is **not** needed.

### WebGPU core-format facts that drive the design

- Core storage-capable formats are only 16. **`r8unorm`, `r8snorm`, `r8uint`,
  `r16float`, `rg8*` are NOT storage-capable** in core.
- `read_write` texture access is core only for `r32*` → **design every compute
  pass write-only to a distinct target (ping-pong), never read-modify-write.**
- `r32float` is **not filterable** in core. `rgba8unorm`/`rgba8snorm` are.
  Hence `rgba8unorm` for the working field: the only format that is both
  storage-writable and linearly samplable without optional features.

## Conventions

- `base: './'` + hash routing, so `dist/` is servable from any subpath.
- Every runtime asset URL built from `import.meta.env.BASE_URL`.
- Field payloads live in `public/fields/<id>/`, indexed by a sibling `index.json`.
- Dev-only screenshot sink: `POST /__shot` with a base64 PNG body and an
  `x-shot-name` header writes to `tests/artifacts/<name>.png`. The agent
  browser pane cannot composite frames, so this is the only way to *see* a
  render — and it is what the Phase 2+ golden-image tests will use.
- **`window.__corticum.renderOneFrame()`** — synchronous single-frame entry
  point. rAF never fires in a hidden document, so nothing that must be
  verifiable may depend on the render loop. Present from the first commit
  because retrofitting it is painful.

## Verify

```bash
npm run build && npm run lint && npm run wgsl
```

- `npm run build` → `tsc -b && vite build`
- `npm run wgsl` → real Tint validation of every plain-WGSL chunk. Confirmed to
  exit **1** with a `line:col` diagnostic on a broken shader and **0** when clean.
- Browser gates: open the app, then in the console
  `await window.__corticum.verifyDepth()` and
  `window.__corticum.gates()`.
  `verifyDepth()` is a *measured* claim, not an eyeball: a yellow probe placed
  between the camera and the isosurface must be visible, and a magenta probe
  behind it must contribute **exactly 0** pixels.
- `await window.__corticum.capture('name')` writes a PNG to `tests/artifacts/`.

### Phase 1 anatomy gate

```bash
python tools/prep/build_fields.py --subject sample
```

Then in the browser console: `await window.__corticum.verifyAnatomy()` — this
samples the uploaded field through a compute shader on five canonical slices and
POSTs the raw distances to `tests/artifacts/`. Score them against the source
MRI with:

```bash
python tools/prep/verify_slice.py
```

The two paths deliberately share no code: a round-trip check written against the
same array the builder produced would pass even if the upload flipped an axis,
the sampler was off by half a voxel, or the decode used the wrong range — all
three of which actually happened.

**Nothing is "done" until it has been run and observed.**
Phase 0: gates S1–S8 pass on the 1050 Ti (`tests/artifacts/phase0_spike.png`).
Phase 1: Dice **1.0000 with zero differing voxels** on 5 slices × 2 subjects
(`fsaverage`, `sample`); payload ~2.0 MB gzipped.
Phase 2: **16–18 ms at full 1280×800** (~60 fps) in both art modes; derived
fields build in ~2.5 s; anatomy gate still passes
(`tests/artifacts/phase2_specimen.png`, `phase2_xray.png`).
Phase 3: all three operator gates pass — null-state identity, diffeomorphism
round-trip **max 0.051 mm** (threshold 0.1 mm, zero points over), midline shift
monotonic in lesion size. Operator re-evaluation is **~2 ms**, so parameters are
live-draggable. Frame time unchanged at 17.2–17.8 ms with a lesion active.

### Phase 3 gate

In the browser console:

```
await window.__corticum.verifyOperators()
```

Writes `tests/artifacts/operators_<subject>.json`.

### Phase 4 gate

In the browser console:

```
await window.__corticum.verifyPicks(20)
```

Then:

```bash
python tools/prep/verify_picks.py
```

Picks are cast through the REAL screen path — camera, Babylon picking ray, the
shared WGSL march — not by calling the sampler directly, because the thing under
test is whether a *click* names the right region. Result: **20/20 agree with
`aparc+aseg.mgz`**.

Keys: **X** cross-fades specimen ⇄ x-ray, **V** toggles the extracted
ventricular mesh (13,028 triangles, extracted in ~210 ms).

### Phase 5 gate

```
await window.__corticum.verifyStaging()
```

Sweeps Braak I–VI and integrates the composed field, binning volume by region.
All five gates pass on `sample`:

| Gate | Result |
|---|---|
| staging order (entorhinal before hippocampus) | PASS |
| primary cortex spared until Braak VI | PASS — precentral 0% through IV, 0.07% at V, 4.29% at VI |
| monotonic progression | PASS |
| whole-brain loss at Braak VI | **5.72%** (expected 2–12%) |
| hippocampal loss at Braak V | **27.25%** (expected 15–30%) |

**Run the probes in adversarial order** (`verifyOperators` → `verifyStaging` →
`verifyPicks`); three real bugs only appeared when they ran back to back.

**Scope note on atrophy.** The offset operator erodes the *parenchyma* surface,
so cortical thinning, sulcal widening and ex-vacuo ventricular enlargement
emerge directly. Deep grey structures have no free surface in that field, so
their loss arises only where they abut CSF — for the hippocampus that is the
temporal horn, which does reach the published range, but by ex-vacuo retreat
rather than the intrinsic neuronal loss that dominates in life. A structure
whose atrophy is *not* adjacent to CSF would be under-represented and would need
a per-structure distance field.

**On the midline-shift gate:** the plan called for "commanded 8 mm measures
8 ± 0.5 mm". There is deliberately no commanded-shift parameter — shift is an
*emergent* consequence of lesion volume acting through the compliance field,
which is the whole architectural claim, so a dial that set it directly would
test nothing. The gate instead sweeps lesion radius and requires shift to grow
monotonically while the deformation stays an exact diffeomorphism. The absolute
shift magnitude is **not calibrated against clinical data** and is tagged
`plausible-approximation`.

## Runtime field layout (Phase 2)

| Texture | Res | Format | Read | Purpose |
|---|---|---|---|---|
| `field.sdf` (shipped) | 208³ | r8unorm | ~40×/ray | marching, AO, subsurface |
| `derived.normals` | 256³ | rgba8unorm | 1×/hit | RGB normal, A curvature |
| `derived.props` | 128³ | rgba8unorm | 1×/hit | R myelin, G tissue, B ventricle, A deep-grey |

A 256³ `work` field is built as a **temporary** (tricubic upsample) purely so
normals can be differenced from a smooth field, then disposed. Runtime
footprint is ~84 MB.

## Parametric control

Atrophy is a **per-region lookup**, not a global knob:

```
atrophy[r] = ( braak[r] + ftd[r] + ... ) × vulnerability[r] + override[r]
```

`vulnerability` scales what a disease already assigns (composes with staging,
cannot invent atrophy where the disease does not reach); `override` adds
millimetres directly (free exploration). Both live in
`src/disease/regions.ts`; the GPU side is one label fetch plus one array index.

`regions.json` carries **lobe**, **Yeo-2011 network** and **hemisphere** per
region, so grouped selection costs no extra payload and no GPU change:

```js
await __corticum.setGroup('network', 'default mode', { overrideMm: 3 })
await __corticum.setGroup('lobe', 'frontal', { vulnerability: 2 })
await __corticum.setRegion('Left-Hippocampus', { vulnerability: 1.5 })
__corticum.groups('network')          // list groups + member counts
__corticum.groupMembers('network', 'default mode')
await __corticum.clearRegions()
```

The network map is computed **from fsaverage** whatever subject is built — it
is a relationship between two atlases, not a property of one brain, and only
fsaverage ships the Yeo annotations. Reading them from an individual subject
silently yields "none" for every region.

Sanity check that it is right: the derived default-mode network (precuneus,
isthmus + rostral anterior cingulate, inferior parietal, middle temporal,
superior frontal, parahippocampal) overlaps the Braak V–VI neocortical list
almost exactly — two independent atlases agreeing on the AD signature.

### Selection highlight

```js
__corticum.highlightGroup('network', 'default mode')   // 18 regions
__corticum.highlightRegion('Left-Hippocampus')
__corticum.clearSelection()
```

Clicking the surface also selects, and `setRegion`/`setGroup` highlight what
they modify — identification and highlighting are one gesture.

Three things make it read correctly:

1. **A uniform array, not another 3D texture.** One float per region index
   packed four-per-`vec4`; 114 regions would otherwise cost 8 MB of texture for
   a single scalar.
2. **Applied AFTER tone mapping.** The glow is interface, not tissue. Run
   through the tonemapper it gets compressed with the shading and reads as a
   suspiciously luminous gyrus rather than as a selection.
3. **Probed a little way INSIDE the surface**, along the inward normal, taking
   the strongest of three depths. Reading the label at the surface point gives a
   dithered, stippled highlight because neighbouring pixels land on labelled
   tissue or background more or less at random — the same failure, and the same
   fix, as the picker reporting "Unknown".

## Timeline

`src/disease/trajectories.ts` defines five scenarios, each with its own time
axis in the units that disease is actually discussed in — years for
neurodegeneration, months for a growing mass, hours for acute stroke — plus a
`narrative(t)` string describing what to look for.

Playback coalesces rather than queues: evaluation is ~2 ms and async, so a naive
"evaluate every frame" would fall further behind the scrubber the longer it ran.
`requestEval` keeps only the NEWEST pending time so the field converges on where
the slider actually is.

**The sequence of events follows the literature; the rates do not.** Braak
stages do not advance on a schedule. Everything in this file is tagged
`plausible-approximation` and the panel shows that tag.

## Control panel

`src/ui/panel.ts` — plain DOM, no framework. Disease selector, time scrubber
with transport, group selector (network / lobe / hemisphere), single-region
search, vulnerability and override sliders, live volume readout, a **Stroke**
section (occlusion site, side, collateral grade, hours since onset, arteries
toggle), view controls.

The side control disables itself for a bilateral site rather than offering a
choice that does nothing.

Every parameter carries an **evidence tag** — `literature`, `derived`, or
`plausible-approximation` — rendered as a coloured dot with a tooltip, because a
teaching tool that cannot distinguish "this is what the evidence says" from
"this looks about right" is worse than no teaching tool.

The **live volume readout is debounced hard (420 ms trailing)** and uses a
coarser 128³ grid than the 192³ verification gate. It integrates the composed
field and reads back from the GPU, which is far heavier than the operator
evaluation driving the sliders; during playback it deliberately shows as stale
and only settles when the timeline pauses. Honest and late beats instant and
wrong.

Good check that the staging table is doing real work: scrub Alzheimer's with the
default-mode network selected. Loss stays at **0.0% through Braak II–IV** and
only reaches **−17.7% at Braak VI** — DMN involvement is a late-stage feature,
and it emerges from the table rather than being scripted.

## Arterial territories and stroke

`src/disease/territories.ts` maps each FreeSurfer parcel to its supplying artery
(ACA, MCA sup/inf/deep, PCA cortical/perforating, anterior choroidal,
cerebellar, basilar perforators) and lists nine occlusion sites with their
clinical syndromes.

**This is an assignment, not a measurement** — tagged `plausible-approximation`,
not a validated vascular atlas. Real territories vary between individuals and
boundaries are fuzzy.

**Watershed zones ARE derived.** Nothing marks them. Perfusion is a *smoothed
territory membership* sampled over two neighbourhood shells (4 mm and 11 mm), so
wherever two territories meet neither reaches full value — which is exactly why
border-zone infarcts happen. Deep white matter, far from any cortical ribbon,
ends up with weak membership from several territories at once: the internal
borderzone falls out for free.

**White matter has no territory of its own.** `cerebral WM` is one label
spanning all three cerebral arteries, so it is `none` in the LUT and inherits
membership from its neighbourhood instead. This matters for the *gate* too — see
below.

### Phase 6 gate

```
await window.__corticum.verifyStroke()
```

| Gate | Result |
|---|---|
| territory shape (collaterals off) | **worst Dice 0.914** across M1 / M2-sup / ACA / PCA; M1 = 0.950 |
| laterality | contralateral core **0.000** at every site |
| collaterals spare the rim | rim infarct **95.7% → 68.7%** grade 0→3, while deep stays **100.0% → 99.9%** |

**The gate was wrong before the model was.** The first run scored Dice 0.575–0.62
with "54% spill" — because the ground truth counts only cortical parcels while a
real MCA infarct plainly involves the white matter underneath. Scoring against a
cortex-only truth counts correct behaviour as error. The comparison is now
restricted to territory-bearing voxels, which asks the falsifiable question:
does the core cover the right cortex and spare the wrong cortex?

The rim/deep split is the more interesting half. A model that merely scaled the
deficit down with collateral grade would produce a smaller infarct and pass a
naive size test while having the physiology backwards. Collaterals arrive over
the pial surface, so rescue must decay inward — and the lenticulostriates, which
have no collateral supply at all, must infarct regardless. `deepCoreFraction`
staying at 1.000 across every grade is the evidence that they do.

**Then the gate was wrong a second time, in the other direction.** A territory id
carries no side — `mcaSuperior` is the same value in both hemispheres — so the
occlusion LUT starved the MCA territory *bilaterally*. An "M1 occlusion" infarcted
both hemispheres, which is not a stroke. It scored **Dice 0.948** anyway, because
the ground truth was built from the same side-blind `territoryOf` and counted the
wrong hemisphere as correctly infarcted.

Laterality is applied as a spatial gate at the midline (world X = Right, so left
is `x < 0`) rather than by doubling the territory enum: the two hemispheres have
separate arterial supply and a real infarct genuinely stops at the midline, so a
2 mm smoothstep at `x = 0` is the honest operator. `OcclusionSite.bilateral`
marks the one site where both sides are correct — the basilar perforators, since
the vertebrals fuse into a single midline artery.

The new `laterality` gate measures core in the **mirror** of the occluded
territory and requires ~0. Note the direction of the fix: worst Dice went
0.921 → 0.914 while M1 went 0.948 → **0.950**, because bilateral spill is no
longer being scored as correct.

**Both halves had the bug.** `vessels.setOcclusion` matched on territory too, so
a left M1 occlusion also greyed out the right MCA tree. A trunk's side is the
sign of its root's world X.

### Arterial tree

Grown by space colonization (Runions et al. 2007), not drawn: 9,000 attractors
are scattered in the parenchyma, bucketed by `(territory, side)`, and each trunk
competes only for its own cloud. 17 hand-authored trunks (8 mirrored pairs plus
the basilar) give the Circle-of-Willis origins; everything distal is derived.
Radii follow Murray's law (`r_parent³ = Σ r_child³`).

```
window.__corticum.verifyVessels()
```

| Gate | Result |
|---|---|
| territory agreement | **0.922** overall, worst trunk 0.725 (anterior choroidal) |
| branching | maxChildren 3, leaves 1228 ≈ bifurcations 1200 + 17 trunks |

Three bugs, each with a distinct numeric signature:

1. **Trunks ended at the skull base**, outside influence range → 382/9000
   attractors consumed, 4125 ms. Fixed by extending each trunk toward its own
   territory's centroid.
2. **Attractors attached only to TIPS**, and each tip's child replaced it, so
   every trunk had exactly one growing end forever. It extruded a single strand
   and could never branch. Attractors must attach to the nearest node **anywhere
   in the tree** — branching is an emergent consequence of different attractors
   claiming different interior nodes.
3. **No child cap → a fan, not a tree.** With the tip restriction lifted, the
   trunk root stayed nearest for attractors on every side and accumulated
   **211 children**, drawing as a star of straight strands. Real arteries
   bifurcate; closing a node at 2 children forces the next attractor further out,
   which is what makes the tree recursive. Murray's law is stated for
   bifurcations, so this also makes the radii mean what they claim.

`leaves ≈ bifurcations + roots` is the identity a binary tree must satisfy, and
it is the cheapest possible check that the branching is real rather than
decorative. `maxChildren` catches the fan directly.

Perf: the spatial hash is built once and appended to (the tree only ever gains
nodes); rebuilding it per iteration cost ~5 s for no benefit. The cell key folds
in the trunk index, so a trunk never scans nodes it would reject. Dead attractors
are compacted out of their bucket rather than skipped, because by the end of the
run most of the bucket is dead. **5634 ms → 586 ms**, and 9000/9000 attractors
consumed.

Press **A** to toggle, or use the arteries button in the Stroke section.

## Patient presets and qEEG (Phase 7)

Two shipped artifacts, both built offline, both tiny:

| File | Size | What |
|---|---|---|
| `presets.json` | 27 kB | 50 stroke_qeeg patients: demographics, NIHSS/mRS, and lesions parsed from the free-text `StrokeLocation` |
| `eeg_proj.json` | 35 kB | 68 DK parcels x 29 channels — the EEG-to-cortex projection |
| `qeeg.json` | 129 kB | relative band power per patient per channel, reduced from 505 MB of EDF |

```bash
python tools/prep/eeg_presets.py     # participants.tsv -> presets.json
python tools/prep/eeg_forward.py     # BEM + dSPM inverse -> eeg_proj.json  (~40 min)
python tools/prep/eeg_rescore.py     # re-scores the gate without rebuilding the forward
python tools/prep/eeg_bandpower.py   # EDF -> qeeg.json
```

### Why Desikan-Killiany and not the planned Destrieux

The plan called for 152 Destrieux parcels plus a new per-voxel `patch_index`
field. Two measurements killed it. The localisation error is **~33 mm median**,
so 148 parcels is far finer than the method supports — rendering a resolution
the data does not have is exactly what the evidence tags exist to prevent. And
the renderer already ships a DK label field with a per-region uniform-array path
(selection highlight, atrophy LUT), so DK costs **no new payload, no new upload
and no new shader**. Coarser and honest beat finer and invented.

### Why the subject is `sample`

fsaverage as installed has only a source space and **no BEM surfaces**, so it
cannot produce a forward solution without a download. `sample` ships a full
3-layer BEM, its own head co-registration and its own aparc — and it is already
corticum's default rendered subject, so the EEG model and the anatomy on screen
are the same individual. No morphing, no template head, no download.

### Gates

| Gate | Result |
|---|---|
| preset laterality | **30/30** lesions contralateral to the recorded paralysis |
| EEG hemisphere agreement | **0 mismatches** across 24 lateral electrodes |
| EEG proximity rank | median **0.971** (chance 0.5), worst 0.794 |
| parcel join | **0** of 68 projection rows unmatched to a region |

**The laterality gate is the strong one.** The corticospinal tract decussates,
so a unilateral lesion must be contralateral to the weakness — and that scores
the side parsed out of prose against the `ParalysisSide` column, which the parser
never reads. A reversed side is the single most likely silent error here and no
amount of looking at the render would catch it.

**The proximity gate replaced a bad one.** The first version thresholded absolute
electrode-to-parcel distance, which scales with parcel SIZE: the same projection
scores 33 mm on Destrieux and 37 mm on DK, so a threshold tuned on one silently
fails the other — a gate measuring the atlas, not the model. It now asks how the
peak parcel *ranks* among same-hemisphere parcels, which is scale-free.

**And it was scoring the wrong matrix.** `eeg_forward.py` verified the raw matrix
and then row-normalised before writing; row scaling can move a column's argmax,
so the report did not describe the file the renderer loads. `eeg_rescore.py`
scores the shipped array. Same lesson as everywhere else here: **the gate must
test what actually runs.**

### The measured negative result — read this before believing the overlay

**The delta/alpha ratio in this cohort does NOT lateralise to the lesion.**
Across 46 patients with a unilateral lesion, DAR was higher over the affected
hemisphere in **54%** of cases. That is chance.

Two reasons, both visible in the data: 51 of 76 lesions are subcortical or
pontine (deep strokes produce little focal cortical slowing, and only **3**
patients have a purely cortical lesion), and the recordings are chronic (median
3 months), by which time acute slowing has resolved. The recordings are also
**motor imagery, not resting state**, so published DAR thresholds do not
transfer — and the alpha map peaking centrally rather than occipitally is the mu
rhythm, which is correct for the task.

So the overlay shows *the recorded scalp topography mapped onto anatomy*. It is
not a lesion localiser and the UI must never imply it is. That the classic qEEG
marker fails on deep strokes is itself the teaching point.

### Multi-lesion presets

A real record routinely names several lesions, sometimes in both hemispheres
("Left paraventricular, Right temporal lobe"). `StrokeState.lesions` carries them
all, and laterality moved from one global side scalar into a **per-territory
`sideLut`**, so different territories can be starved on different sides in one
evaluation. A plain single-site selection is just the one-element case.

Two isolated perforator sites had to be added before this cohort could be
expressed at all — `lsa` (lenticulostriate / lacunar) and `thalamoperf`. They
account for **38 of 76** lesions; without them two-thirds of these patients were
unrepresentable, because the site list only had large-vessel occlusions.

### Overlay cost — measured

**~0.08 ms, about 1%.** Median over five alternating reps at 1.46 Mpx: 7.15 ms
overlay-off vs 7.23 ms on. Three extra label fetches per shaded pixel behind an
opacity branch, which is what that should cost.

Getting a stable number needed **batches of 60 frames per timing**, not 15. The
first attempt synced after every short batch, so readback overhead dominated and
the result came out non-monotonic — reporting the overlay as *faster* than no
overlay, which is impossible and therefore a measurement fault rather than a
shader one (#23 again).

Note the batched figure is **not comparable to the engine's rAF number**:
driving `renderOneFrame` in a loop skips present/vsync pacing. It is valid for
the off-vs-on comparison, which was the question. Absolute frame time in normal
operation is **16.7 ms**, confirmed against the production build.

## Synthetic radiological modalities

```js
__corticum.setModality('dwi')   // anatomic | t1 | t2 | flair | dwi | ct
__corticum.setSliceView('axial', 6)
```

Same field, five radiological contrasts. **Not a pulse-sequence simulation** —
TR/TE/TI, proton density and relaxation times are not modelled. It is a
hand-tuned mapping from tissue class and water content onto the appearance each
sequence is known to produce, tagged `plausible-approximation`.

It exists because **a single picture of one modality cannot teach any of the
facts that actually matter clinically**, all of which are about the same lesion
looking different depending on when and how you image it:

| | 2 h (hyperacute) | 48 h |
|---|---|---|
| DWI | **1.208** bright | 1.228 |
| FLAIR | **1.013** negative | **1.131** positive |
| CT | 1.005 invisible | **0.972** hypodense |
| T1 | 0.986 | 0.937 |
| T2 | 1.014 | 1.106 |

*(conspicuity = mean intensity of the infarcted hemisphere / the healthy one)*

**The DWI-FLAIR mismatch is reproduced quantitatively.** DWI is bright within
minutes; FLAIR stays negative below ~4.5 h. That difference is a real
thrombolysis decision rule (WAKE-UP), and it is the single best argument for
having modality synthesis at all. CT being blind early is the second: a normal
early CT does not exclude a stroke.

Note CT **inverts** the T1 relationship — grey matter is denser than white, so
GM is brighter, which is what makes "loss of grey-white differentiation" the
earliest CT sign.

Two implementation points worth keeping:

1. **Applied AFTER tone mapping.** A scan is a map of measured intensity;
   running it through a filmic curve would misrepresent the very contrast being
   taught. Same reasoning as the selection glow, opposite conclusion about why.
2. **Flat on a cut face, faintly shaded in 3D.** A slice has no lighting. The
   geometric term survives only on non-cut surfaces so a 3D view stays legible.

### Phase 8 modality gate

```
await window.__corticum.verifyModality()
```

| Gate | Result |
|---|---|
| DWI-FLAIR mismatch at 2 h | PASS — DWI 1.208 vs FLAIR 1.013 |
| FLAIR catches up by 48 h | PASS — 1.013 → 1.131 |
| CT blind early, hypodense later | PASS — 1.005 → 0.972 |
| T1 and T2 oppose at 48 h | PASS — 0.937 vs 1.106 |

Conspicuity averages a whole hemisphere, and the infarct is only a fraction of
it, so the absolute ratios are small. **The ordering and the sign changes are
the claim**, not the magnitudes.

## Clinical rating scales

Teaching tools show pictures; clinicians write scores. Nothing bridged the two,
so a student could see an infarct without knowing it would be called ASPECTS 6 —
the number that actually gates treatment.

```js
await __corticum.measureAspects()   // null unless a stroke is active
await __corticum.measureScales()    // MTA, GCA, Fazekas-like
```

ASPECTS appears live in the Stroke section; MTA/GCA/Fazekas ride on the volume
readout's existing readback, so they cost nothing extra and can never disagree
with the volume printed above them.

### ASPECTS

Ten MCA regions, one point lost each. **M1-M6 are derived by POSITION, not from
named parcels** — they are anterior/middle/posterior thirds of the lateral MCA
cortex at two axial levels, which is how the scale defines them. A gyrus-to-region
table would invent a correspondence the scale never claims. The subcortical
regions (caudate, lentiform, insula) do come from labels.

The **internal capsule has no FreeSurfer label**, so it is approximated by an
ellipsoid fitted between the lentiform and thalamic centroids, measured from the
subject's own anatomy rather than hard-coded. Flagged in the report.

The geometry is derived per subject and the numbers are not intuitive: on
`sample` the brain sits at Y ≈ −7…+99 mm because the tkrRAS origin is not the
vertical centre, so a basal-ganglia ceiling of 58.5 mm is correct, not a bug. I
briefly "fixed" a non-problem here before measuring where the structures actually
were.

| Occlusion | ASPECTS | Regions lost |
|---|---|---|
| none | 10 | — |
| lacunar (`lsa`) | **7** | C, L, IC — deep only, cortex untouched |
| M2 superior | 5 | cortical only, deep spared |
| M1 proximal | 0 | everything |

### Phase 8 ASPECTS gate

```
await window.__corticum.verifyAspects()
```

| Gate | Result |
|---|---|
| a normal brain scores 10 | PASS |
| M1 worse than an M2 branch | PASS — 0 vs 4 |
| M1 takes the deep structures, M2 spares them | PASS |
| contralateral hemisphere untouched | PASS — 10, 10 |
| rescue needs collaterals AND reperfusion | PASS |

**The last gate is the interesting one, and it was not what I set out to test.**
Collaterals alone leave ASPECTS at 0 (cortical involvement only falls 0.95 →
0.64); early reperfusion alone also leaves it at 0; **both together give 10.**
Collaterals slow the core's growth into the penumbra, reperfusion stops it, and
neither is sufficient — which is the fast-progressor / slow-progressor
distinction behind thrombectomy selection. Nothing encodes it: it falls out of
`growth = hours / (3 + 9·grade)` meeting the collateral rescue term.

### What the volume-derived scales are and are not

MTA, GCA and Fazekas are **visual** scales in practice — Scheltens MTA grades
hippocampal height and choroid-fissure width against reference figures on a
coronal slice. These map measured VOLUME LOSS onto those grades instead, because
volume is what the model knows. The cut points put grades in roughly the right
order of magnitude; they are `plausible-approximation` and would not agree with
a radiologist on any given brain.

Measured behaviour on a Braak sweep: MTA 0 → 0 → **2** (Braak IV, 24.4%
hippocampal loss) and GCA only reaches 1 at Braak VI (4.7% parenchymal loss) —
global atrophy as a late feature, which is right. MTA then *stops* rising from
IV to VI because the Braak weight table gives the hippocampus its full weight at
the limbic stage; real MTA keeps climbing. That is a limitation of the staging
table, not of the scale.

**Fazekas is the weakest of the four.** It grades small-vessel white matter
hyperintensities, and the only WM lesion here is the MS plaque field — a
different disease with a different distribution. Read it as "how much white
matter lesion is present", not as a small-vessel grade.

## Split comparison

```js
__corticum.setSplit(true, 0)     // divider in NDC x, -1..1
__corticum.setSplit(false)
```

Left of the divider is **the same brain with no disease applied**. Not a
different scan, not a prior study — a counterfactual, which is something no
viewer can offer because the healthy version of a diseased brain does not exist
as data. Here it does: the operators are a function of parameters, so switching
them off for half the pixels renders what that brain would have been.

**It costs nothing.** The obvious implementation marches twice; this switches
`gOpActive` per pixel at the top of the fragment shader, and everything
downstream — the march, `toMaterial`, every pathology lookup — reads it through
`marchCfg()`.

`gOpActive` is a module-scope **`var<private>`** in Babylon's WGSL dialect. That
works, but `render/` shaders are not standalone-valid so `npm run wgsl` never
sees it. The gate below is what would notice if it stopped working.

Drag the divider rather than leaving it centred: wiping it across a lesion is
what makes a subtle change visible, because the eye detects motion at an edge far
better than it compares two static images. Note also that with the divider at
screen centre and a lateralised lesion you end up comparing left hemisphere to
right, which is a different question — put the divider *through* the affected
side to get the counterfactual.

### Phase 8 split gate

```
await window.__corticum.verifySplit()
```

| Gate | Result |
|---|---|
| each half is a real render of its state | PASS — mean abs diff **0.000** vs the full render |
| the two states actually differ | PASS — 4.6 / 5.9 / 6.3 against the opposite state |

**The gate failed first for a reason worth recording.** The automatic quality
ladder reallocates the swapchain between frames, so the three captures came back
at DIFFERENT resolutions and the comparison indexed mismatched buffers — mean
differences of 20–35 and one `NaN`. That reads as "the split view is broken"
when the measurement was at fault. `verifySplit` now stops the render loop, pins
the scale, and reports `sameSize` so the two failure modes stay distinguishable.
Third time this ladder has corrupted a measurement (see #23).

## Ground-truth NIfTI export

```js
await __corticum.exportNifti(128)   // downloads three .nii files
```

Three files for whatever is on screen: a synthetic T1, the composed signed
distance field, and **the true displacement field**.

That last one is the point. Benchmarking a registration or segmentation method
needs images whose correct answer is known, which is exactly why Simul@atrophy
exists — and it runs offline in batch. Here the deformation is not estimated,
it **is** the operator, so a recovered warp can be scored against it exactly.
From a browser, with nothing installed.

| Grid | Readback | Files |
|---|---|---|
| 64³ | ~5 MB | quick check |
| 128³ | ~100 MB | default |
| 208³ | ~440 MB | native anatomy resolution |

### Orientation is the part that goes wrong

corticum's world axes are X=Right, **Y=Superior, Z=Anterior**. NIfTI's canonical
frame is RAS+ (Y=Anterior, Z=Superior). Those differ by a Y/Z swap, which is an
ODD permutation — encoding it in the affine alone gives a negative-determinant
matrix that is legal but reads as radiological convention and invites exactly
the silent left-right flip this project has already been bitten by. So the data
is **permuted into RAS on write** and the affine stays diagonal and positive.

Two related traps, both hit:

1. **`srow_z`'s translation is at byte 324, not 328.** Writing it to 328 puts it
   in `intent_name`; the file still loads, the affine just silently has a zero
   where a −102 mm shift belongs. nibabel printed the affine and the missing
   offset was obvious — from inside the browser it would never have surfaced.
2. **A vector field needs its COMPONENTS permuted too**, not just its grid.
   `worldVectorsToRas` does that; permuting the volume alone yields a field
   pointing in a plausible but wrong direction.

NIfTI also stores components as separate volumes (component-major), not
interleaved per voxel.

### Phase 8 export gates

```
await window.__corticum.verifyExport()
```

then, against an independent reader:

```bash
python tools/prep/verify_export.py
```

| Gate | Result |
|---|---|
| no disease ⇒ zero ground-truth displacement | PASS — 0.0000 mm |
| a 30 mm mass deforms | PASS — 7.09 mm |
| plausible brain occupancy | PASS — 13.7% |
| nibabel: affine, shape, intent 1006 | PASS |
| nibabel: lesion lands in the commanded octant | PASS |

**The browser cannot check its own orientation.** `verify_export.py` loads the
emitted bytes with nibabel, places a mass at a deliberately asymmetric world
point (right, superior, anterior), and requires the displacement to appear in
that octant after the RAS permutation. Any axis swap or flip moves it elsewhere.

One subtlety worth keeping: score the **magnitude-weighted centroid**, not the
argmax. Mass effect is a radial expansion, so displacement is zero at the lesion
centre and peaks on a shell at r ≈ R — the brightest voxel therefore sits ~R mm
away in an arbitrary direction and looks like a 30 mm orientation error that
isn't one. That cost a false failure.

**A first dispatch against freshly created storage buffers does not reliably
land** before the readback, and since these outputs can legitimately be zero
there is no sentinel that distinguishes "never written" from "genuinely empty"
(#36). Symptom: a healthy export reporting that NO voxel was inside the brain,
while the very next run reported 14%. `ExportProbe` now dispatches once and
discards it whenever it allocates, which is far cheaper than doubling a 100 MB
readback to compare.

### What this is not

The synthetic T1 is a tissue-class mapping: **no noise, no bias field, no
partial-volume model, no skull or scalp**. It is suitable for scoring a method
against a KNOWN deformation, not for judging how it behaves on real clinical
images.

## Viewing internal anatomy

```js
__corticum.setCutPlane('sagittal', 6)      // axis, offset mm, optional flip
__corticum.setClip(true, [1, 0, 0], 6)     // arbitrary plane
__corticum.setClip(false)
```

A cutaway costs almost nothing in a raymarcher: the ray simply starts at the
plane, so everything in front is never sampled. When a ray begins already inside
tissue, `MarchHit.cut` is set and the pixel is shaded as a **cross-section** —
flat, tissue-contrast-driven, no subsurface or gloss, because dressing a cut
face as a wet surface hides the boundaries it exists to show.

The picker honours the clip so clicking a section names visible tissue.
**Volumetry deliberately ignores it** — a cutaway is a viewing aid, and letting
it shrink measured volume would make the gates depend on the camera.

### Radiological slice view

```js
__corticum.setSliceView('axial', 8)   // sagittal | axial | coronal
__corticum.setSliceView(null)         // back to 3D
```

An orthographic camera looking straight down the cut normal, plus one extra
rule: discard wherever the ray did *not* start inside tissue (`uSliceOnly`).
Without that the ray keeps going where the plane misses tissue and shows 3D
surface behind the cut — a cutaway, not a cross-section. No new rendering path
was needed; it is the existing clip machinery plus a camera and a discard.

### Magic lens

```js
__corticum.setLens(true, { depthMm: 26, mag: 2.0, radius: 0.34 })
__corticum.setLens(false)
```

A circular region that magnifies **and digs into the tissue**. The penetration
is the point: a wide-angle projection changes how much you can see from a point,
it does not remove what is in the way.

The lens follows the cursor (in NDC, so it is independent of the render scale).

**How the peel works, and the mistake that preceded it.** The obvious approach
is to add a constant offset to the distance field inside the lens — adding a
positive scalar to an SDF is erosion, the same identity atrophy uses. But that
offset applies along the WHOLE ray, so it does not remove a layer, it globally
shrinks everything that ray can see: thin structures vanish and the lens bores
clean through the head, leaving background.

The fix is `MarchCfg.startT`: march normally to find the first surface, then
**restart the march a fixed distance past it**. That removes exactly a shell of
that thickness and leaves everything deeper intact. Starting inside tissue also
sets `MarchHit.cut`, so the exposed face is shaded as a cross-section rather
than as a pial surface.

The ventricle mesh needs no special handling — it keeps its true depth, so it
simply becomes visible once the raymarched surface retreats behind it.

Picking and volumetry both set `startT = 0`: the lens is a viewing aid, and
neither "what is this tissue" nor "how big is this region" should depend on it.

### Fisheye

```js
__corticum.setFisheye(true, 150 * Math.PI / 180)
```

Equidistant projection (angle proportional to screen radius), which is what
allows FOV beyond 180° — impossible with a projection matrix, where the tangent
diverges. Two things make it work:

1. **The volume mesh is scaled up 4×** when fisheye is on. That box is only a
   surface to generate fragments on — the march takes its bounds from
   `uHalfExtent`, not from the mesh — so enlarging it widens the screen area
   rays are cast over without touching the field. Otherwise rays that should
   leave the box's ordinary perspective footprint are never shaded.
2. **The ventricle mesh gets the identical projection and depth mapping.** Under
   fisheye the projection matrix no longer describes where anything is on
   screen, so its `z` is meaningless; both the raymarch and the mesh switch to
   normalised distance-from-camera. Skipping this floats the ventricles through
   the cortex — it would silently break the Phase 0 gate S5 property.

Fisheye and slice view are mutually exclusive and the panel enforces it: one is
an orthographic cross-section, the other a >180° projection.

## Subjects

`sample` is the default. It is a real individual; `fsaverage` is a template
*average*, and averaging smooths gyri away — measured with
`tools/prep/compare_subjects.py`, `sample` carries **+27% gyrification**
(A/V^⅔ 23.4 vs 18.4) and 494 vs 338 cm³ of cortical grey matter. fsaverage is
kept because it is the canonical space for the atlas parcellations (Yeo,
Brodmann, Destrieux) and for the EEG source model in Phase 7.

Switch with `#/?subject=fsaverage`.

Grid is **208³ @ 1 mm**, not the 192³ the plan assumed: a 192 mm cube centred on
the tkrRAS origin clips the occipital pole off fsaverage and the frontal pole off
`sample`. `build_fields.py` refuses to run rather than silently truncating.

## Shipping

```bash
npm run build          # -> dist/, 6.1 MB (2.2 MB of it the field payload)
```

`.github/workflows/pages.yml` builds and publishes `dist/` on every push to
`main`. `base: './'` means the bundle is servable from any subpath, so nothing
needs the repo name substituted in.

**The production build is verified, not assumed.** Serve `dist/` with
`vite preview` and load it: the dev server sets `Content-Encoding: gzip` on
`.gz` while a static host does not, and that difference has broken field loading
before. Confirmed working from `dist/`: 20 MB of fields transferred, 114 regions,
5543 vessel nodes, 50 EEG subjects, all five panel sections, **16.7 ms/frame**.

Two things that will bite:

- **Stop `vite preview` before rebuilding.** It holds `dist/assets/*.js` open and
  the build dies with `EPERM: operation not permitted, lstat`.
- The browser gates POST to `/__data` and `/__shot`, which are **dev-server
  middleware only**. They cannot run against a production build; run them on
  `npm run dev`.

## Known remaining issues

- **Residual blockiness in the curvature channel.** The ±3-voxel stencil fixed
  the speckle, but 8-bit curvature still shows faint patches in x-ray mode's
  darker regions. Storing curvature at higher precision, or deriving it from
  the unquantised tricubic field during the build, would clear it.
- **Procedural sub-voxel detail is not implemented yet.** `sulc.i8.gz` ships and
  is unused: the plan's `inflate_detail` pass (curl-noise micro-relief
  amplitude-modulated by *measured* sulcal depth) is still outstanding. The
  current surface is real anatomy at 1 mm with no invented detail — which is
  honest, just not as rich as it could be.
- The **G channel of the props field is a nearest-valued tissue class** and must
  not be relied on where filtering occurs; use the continuous membership
  channels instead (see gotcha #18).
