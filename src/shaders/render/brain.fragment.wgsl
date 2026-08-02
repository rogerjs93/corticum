// BABYLON WGSL DIALECT �?" see CLAUDE.md "Shader dialects".
//
// Phase 2 raymarch. Reads the GPU-built working field rather than the shipped
// payload: distance is tricubically smoothed, and the normal and mean curvature
// were baked at load time, so shading a hit costs ONE filtered fetch instead of
// twelve central differences.
//
// Two art modes share the field:
//   specimen �?" photoreal wet tissue; curvature-driven translucency, distance
//              field AO, wavelength-dependent subsurface, pia specular.
//   x-ray    �?" translucent parenchyma with the interior emitting through it,
//              which is the mode that will make lesions and ventricles legible
//              once the disease operators land.
// uMode cross-fades between them so the transition itself is watchable.

#include<sceneUboDeclaration>

varying vWorld : vec3<f32>;
varying vClip : vec4<f32>;

// Marching field: the shipped payload, r8unorm. ONE byte per fetch, and a ray
// takes ~40 of them. Marching the 4-byte baked field instead cost 60x the frame
// time �?" see the note in fields/derived.ts.
var sdfTexSampler : sampler;
var sdfTex : texture_3d<f32>;
// Baked normal + curvature, sampled exactly once per shaded pixel.
var normTexSampler : sampler;
var normTex : texture_3d<f32>;
// Tissue properties, also once per shaded pixel.
var propTexSampler : sampler;
var propTex : texture_3d<f32>;
// Parametric disease operators, 64^3 each (2 MB) so they stay cache-resident
// despite being sampled on every march step.
var deformTexSampler : sampler;
var deformTex : texture_3d<f32>;
var offsetTexSampler : sampler;
var offsetTex : texture_3d<f32>;
// Region labels, fetched ONCE per shaded pixel (not per march step) so the
// selection highlight costs one byte from an already-resident 9 MB texture.
var labTexSampler : sampler;
var labTex : texture_3d<f32>;
// Stroke: perfusion deficit, core, penumbra, chronic. Once per shaded pixel.
var strokeTexSampler : sampler;
var strokeTex : texture_3d<f32>;

uniform uCamPos : vec3<f32>;
uniform uHalfExtent : f32;
uniform uRangeMm : f32;
uniform uVoxelMm : f32;
uniform uDim : f32;
uniform uNormDim : f32;
uniform uPropDim : f32;
uniform uStepScale : f32;
uniform uMode : f32;
uniform uMaxSteps : f32;
uniform uOpDim : f32;
uniform uOpActive : f32;
uniform uNigraCentre : vec3<f32>;
uniform uNigraRadius : f32;
uniform uNigralLoss : f32;
uniform uClipNormal : vec3<f32>;
uniform uClipOffset : f32;
uniform uClipEnabled : f32;
uniform uSliceOnly : f32;
uniform uLabelDim : f32;
// Fisheye: 0 = ordinary perspective, 1 = equidistant projection.
uniform uFisheye : f32;
uniform uFisheyeFov : f32;
uniform uAspect : f32;
uniform uCamRight : vec3<f32>;
uniform uCamUp : vec3<f32>;
uniform uCamFwd : vec3<f32>;
uniform uDepthScale : f32;
// Magic lens: a circular screen region that magnifies AND digs into the tissue.
uniform uLensActive : f32;
uniform uLensCentre : vec2<f32>;
uniform uLensRadius : f32;
uniform uLensDepth : f32;
uniform uLensMag : f32;
uniform uTanHalfFov : f32;
uniform uStrokeDim : f32;
uniform uSelectPulse : f32;
uniform uSelectColor : vec3<f32>;
// Selection strength per region index, four regions per vec4. Same packing
// trick as the atrophy LUT: 114 regions fit in 29 vec4s, and a uniform array
// beats a whole extra 3D texture for one scalar per region.
uniform uSelectLut : array<vec4<f32>, 64>;
// Per-region qEEG value, four per vec4. A uniform array rather than a texture
// for the same reason the selection lut is one: 114 regions would otherwise
// cost megabytes of 3D texture to carry a single scalar.
uniform uEegLut : array<vec4<f32>, 64>;
uniform uEegOpacity : f32;
// 0 = anatomic shading, 1 = T1, 2 = T2, 3 = FLAIR, 4 = DWI, 5 = CT.
uniform uModality : f32;
// Hours since stroke onset, which is what makes a lesion visible on one
// modality and invisible on another at the same instant.
uniform uOnsetHours : f32;
// Side-by-side comparison: 0 = off, 1 = split. uSplitX is the divider in NDC.
uniform uSplitMode : f32;
uniform uSplitX : f32;

/// Whether the disease operators apply to the pixel being shaded.
///
/// A module-level var rather than a uniform because the SPLIT view needs this
/// to vary per pixel: the same brain, the same camera, healthy on one side of
/// the divider and diseased on the other. Everything downstream — the march,
/// toMaterial, the pathology lookups — reads it through marchCfg(), so setting
/// it once at the top of main is enough and costs nothing.
var<private> gOpActive : f32 = 0.0;

// The composed field and the sphere tracer come from common/march.wgsl, shared
// verbatim with the picking probe so a click can never report a region the
// renderer did not draw.
//!include common/march.wgsl

fn marchCfg() -> MarchCfg {
    var c : MarchCfg;
    c.halfExtent = uniforms.uHalfExtent;
    c.rangeMm = uniforms.uRangeMm;
    c.voxelMm = uniforms.uVoxelMm;
    c.sdfDim = uniforms.uDim;
    c.opDim = uniforms.uOpDim;
    c.opActive = gOpActive;
    c.stepScale = uniforms.uStepScale;
    c.maxSteps = uniforms.uMaxSteps;
    c.clipNormal = normalize(uniforms.uClipNormal);
    c.clipOffset = uniforms.uClipOffset;
    c.clipEnabled = uniforms.uClipEnabled;
    c.extraOffsetMm = 0.0;
    c.startT = 0.0;
    return c;
}

/// How strongly this pixel is inside the lens, 0..1, with a soft rim.
fn lensWeight(ndc : vec2<f32>) -> f32 {
    if (uniforms.uLensActive < 0.5) {
        return 0.0;
    }
    let p = (ndc - uniforms.uLensCentre) * vec2<f32>(uniforms.uAspect, 1.0);
    let r = length(p) / max(uniforms.uLensRadius, 1e-4);
    return 1.0 - smoothstep(0.72, 1.0, r);
}

fn opUvw(p : vec3<f32>) -> vec3<f32> {
    return sdfUvw(p, uniforms.uHalfExtent, uniforms.uOpDim);
}

fn toMaterial(p : vec3<f32>) -> vec3<f32> {
    return marchToMaterial(deformTex, deformTexSampler, p, marchCfg());
}

fn distAt(p : vec3<f32>) -> f32 {
    return composedDist(
        sdfTex, sdfTexSampler,
        deformTex, deformTexSampler,
        offsetTex, offsetTexSampler,
        p, marchCfg()
    );
}

/// Pathology memberships at a world position, evaluated in material space:
/// (mass lesion, vasogenic edema, demyelinating plaque).
fn lesionAt(p : vec3<f32>) -> vec3<f32> {
    if (gOpActive < 0.5) {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    let s = textureSampleLevel(offsetTex, offsetTexSampler, opUvw(toMaterial(p)), 0.0);
    return vec3<f32>(s.y, s.z, s.w);
}

/// Substantia nigra membership.
///
/// Evaluated analytically rather than from a field because the SN is NOT a
/// FreeSurfer label �?" aseg has no such structure �?" so there is nothing to look
/// up. Two hand-placed ellipsoids inside the midbrain stand in for it. This is
/// explicitly a `plausible-approximation`, and the UI says so.
///
/// Parkinson's is rendered here as loss of neuromelanin PIGMENT rather than as
/// atrophy, which is both more faithful (structural MRI in PD is famously
/// subtle) and more informative than shrinking something.
fn nigraAt(p : vec3<f32>) -> f32 {
    let c = uniforms.uNigraCentre;
    let r = uniforms.uNigraRadius;
    let left = vec3<f32>(-abs(c.x), c.y, c.z);
    let right = vec3<f32>(abs(c.x), c.y, c.z);
    // Flattened in the vertical axis: the SN is a lamina, not a ball.
    let sq = vec3<f32>(1.0, 2.1, 1.0);
    let dl = length((p - left) * sq) / r;
    let dr = length((p - right) * sq) / r;
    return 1.0 - smoothstep(0.6, 1.0, min(dl, dr));
}

struct Surface {
    n : vec3<f32>,
    curv : f32,
};

fn deformAt(p : vec3<f32>) -> vec3<f32> {
    return textureSampleLevel(deformTex, deformTexSampler, opUvw(p), 0.0).xyz;
}

/// Transform a material-space normal into world space under the deformation.
///
/// Normals are covectors: they transform by the inverse transpose of the
/// deformation Jacobian, not by the Jacobian. With A = dX/dx = I + grad(u_inv)
/// (which is what the stored inverse field gives directly) and J = dx/dX =
/// A^-1, the rule J^-T reduces to simply A^T �?" so six fetches of the inverse
/// field are all that is needed, with no matrix inversion.
///
/// Skipping this makes deformed tissue look unlit and rubbery, which is the
/// classic tell of a warped volume shaded with its undeformed normals.
fn toWorldNormal(p : vec3<f32>, nMat : vec3<f32>) -> vec3<f32> {
    if (gOpActive < 0.5) {
        return nMat;
    }
    let h = 2.0;
    let dux = (deformAt(p + vec3<f32>(h, 0.0, 0.0)) - deformAt(p - vec3<f32>(h, 0.0, 0.0))) / (2.0 * h);
    let duy = (deformAt(p + vec3<f32>(0.0, h, 0.0)) - deformAt(p - vec3<f32>(0.0, h, 0.0))) / (2.0 * h);
    let duz = (deformAt(p + vec3<f32>(0.0, 0.0, h)) - deformAt(p - vec3<f32>(0.0, 0.0, h))) / (2.0 * h);
    let t = vec3<f32>(
        nMat.x + dot(dux, nMat),
        nMat.y + dot(duy, nMat),
        nMat.z + dot(duz, nMat)
    );
    return normalize(t);
}

fn surfaceAt(p : vec3<f32>) -> Surface {
    // The baked normal and curvature live in MATERIAL space, which is exactly
    // why baking them survives the disease operators instead of having to be
    // rebuilt whenever a parameter moves.
    let X = toMaterial(p);
    let s = textureSampleLevel(normTex, normTexSampler,
        sdfUvw(X, uniforms.uHalfExtent, uniforms.uNormDim), 0.0);
    var out : Surface;
    out.n = toWorldNormal(p, normalize(s.xyz * 2.0 - vec3<f32>(1.0, 1.0, 1.0)));
    out.curv = s.w * 2.0 - 1.0;
    return out;
}

fn selectLookup(probe : vec3<f32>) -> f32 {
    let uvw = sdfUvw(toMaterial(probe), uniforms.uHalfExtent, uniforms.uLabelDim);
    let idx = u32(round(textureSampleLevel(labTex, labTexSampler, uvw, 0.0).r * 255.0));
    let v = uniforms.uSelectLut[idx >> 2u];
    let lane = idx & 3u;
    if (lane == 1u) { return v.y; }
    if (lane == 2u) { return v.z; }
    if (lane == 3u) { return v.w; }
    return v.x;
}

/// Selection strength at a shaded point, 0 = unselected.
///
/// Sampled in MATERIAL space, with NEAREST filtering �?" a region index must
/// never be interpolated, since halfway between region 3 and region 7 is not
/// region 5.
///
/// And sampled a little way INSIDE the surface, along the inward normal. The
/// hit sits exactly on the parenchyma boundary, where neighbouring pixels land
/// on labelled tissue or on background more or less at random; reading the
/// surface point directly produces a dithered, stippled highlight rather than a
/// solid one. Taking the strongest of three depths fills it in. (Same failure,
/// and same fix, as the picker reporting "Unknown".)
fn selectionAt(p : vec3<f32>, n : vec3<f32>) -> f32 {
    var s = 0.0;
    for (var i : i32 = 1; i <= 3; i = i + 1) {
        s = max(s, selectLookup(p - n * (0.8 * f32(i))));
    }
    return s;
}

/// qEEG band power projected onto this region, 0..1. Negative means "no value".
fn eegLookup(probe : vec3<f32>) -> f32 {
    let uvw = sdfUvw(toMaterial(probe), uniforms.uHalfExtent, uniforms.uLabelDim);
    let idx = u32(round(textureSampleLevel(labTex, labTexSampler, uvw, 0.0).r * 255.0));
    let v = uniforms.uEegLut[idx >> 2u];
    let lane = idx & 3u;
    if (lane == 1u) { return v.y; }
    if (lane == 2u) { return v.z; }
    if (lane == 3u) { return v.w; }
    return v.x;
}

/// Averaged a little way inside the surface, for the same reason selection is:
/// reading the label exactly ON the boundary makes neighbouring pixels land on
/// tissue or background more or less at random, and the overlay stipples.
fn eegAt(p : vec3<f32>, n : vec3<f32>) -> f32 {
    var s = 0.0;
    for (var i : i32 = 1; i <= 3; i = i + 1) {
        s = max(s, eegLookup(p - n * (0.8 * f32(i))));
    }
    return s;
}

/// Synthetic radiological contrast.
///
/// NOT a pulse-sequence simulation. MR signal depends on TR/TE/TI, proton
/// density and relaxation times that this project does not model; what follows
/// is a hand-tuned mapping from tissue class and water content onto the
/// intensity each sequence is KNOWN to produce. It is tagged
/// `plausible-approximation` in the UI and must not be read as a real scan.
///
/// What it does capture, and the reason it exists, is that the SAME lesion
/// looks completely different across modalities and across time:
///
///   CT     an infarct is invisible for hours, then subtly hypodense. This is
///          why a normal CT does not exclude a stroke.
///   DWI    bright within minutes, and pseudonormalises around day 10.
///   FLAIR  still negative below ~4.5 h. DWI-positive with FLAIR-negative dates
///          a stroke to inside the thrombolysis window, which is a real
///          decision rule (WAKE-UP trial) and cannot be taught from a picture
///          of one modality.
///   T1/T2  chronic cavitation follows CSF: dark on T1, bright on T2.
///
/// Note CT inverts the T1 relationship: grey matter is DENSER than white, so
/// GM is brighter, which is what makes "loss of grey-white differentiation" the
/// earliest CT sign of infarction.
fn modalityIntensity(p : vec3<f32>, mode : f32, hours : f32) -> f32 {
    let props = propsAt(p);
    let path = lesionAt(p);
    let sk = strokeAt(p);

    let wm = smoothstep(0.15, 0.75, props.r);
    let csf = clamp(props.b, 0.0, 1.0);
    let deep = clamp(props.a, 0.0, 1.0);
    let edema = clamp(path.y, 0.0, 1.0);
    let plaque = clamp(path.z, 0.0, 1.0);
    let mass = clamp(path.x, 0.0, 1.0);
    let core = clamp(sk.y, 0.0, 1.0);
    let cavity = clamp(sk.w, 0.0, 1.0);

    // Conspicuity of an infarct over time, per modality.
    let dwiBright = 1.0 - smoothstep(240.0, 480.0, hours);   // fades ~day 10-20
    let flairPos = smoothstep(3.0, 6.0, hours);              // negative early
    let ctPos = smoothstep(3.0, 12.0, hours);                // later still

    var i = 0.0;
    if (mode < 1.5) {
        // T1: fat/myelin bright, water dark.
        i = mix(0.45, 0.78, wm);
        i = mix(i, 0.52, deep);
        i = mix(i, 0.04, csf);
        i = i - 0.18 * edema - 0.10 * plaque;
        i = mix(i, 0.30, core * flairPos * 0.6);
        i = mix(i, 0.05, cavity);
    } else if (mode < 2.5) {
        // T2: water bright — broadly the inverse of T1.
        i = mix(0.58, 0.34, wm);
        i = mix(i, 0.46, deep);
        i = mix(i, 0.97, csf);
        i = i + 0.30 * edema + 0.34 * plaque;
        i = i + 0.30 * core * flairPos;
        i = mix(i, 0.97, cavity);
    } else if (mode < 3.5) {
        // FLAIR: T2 weighting with the CSF signal nulled, which is what makes
        // periventricular plaques and cortical oedema visible at all.
        i = mix(0.55, 0.33, wm);
        i = mix(i, 0.45, deep);
        i = mix(i, 0.06, csf);
        i = i + 0.34 * edema + 0.48 * plaque;
        i = i + 0.38 * core * flairPos;
        // A chronic cavity nulls like CSF, leaving only a bright gliotic rim.
        i = mix(i, 0.08, cavity);
    } else if (mode < 4.5) {
        // DWI: restricted diffusion. Low intrinsic tissue contrast, which is
        // why an acute infarct stands out so violently.
        i = mix(0.34, 0.30, wm);
        i = mix(i, 0.10, csf);
        i = i + 0.62 * core * dwiBright;
        i = i + 0.18 * edema * dwiBright;
        i = mix(i, 0.10, cavity);
    } else {
        // CT: attenuation. GM is denser than WM, so the relationship inverts.
        i = mix(0.50, 0.41, wm);
        i = mix(i, 0.53, deep);
        i = mix(i, 0.10, csf);
        i = i - 0.10 * edema;
        i = i - 0.09 * core * ctPos;
        i = mix(i, 0.10, cavity);
        // A mass lesion reads as a hyperdense mass; blood is the classic case.
        i = i + 0.35 * mass;
    }
    return clamp(i, 0.0, 1.0);
}

/// Sequential blue -> cyan -> yellow -> red ramp.
///
/// Deliberately NOT a rainbow: rainbow maps invent boundaries where the data is
/// smooth and hide real steps elsewhere, which for a quantity this approximate
/// would manufacture structure that the method cannot resolve. This ramp is
/// monotonic in luminance, so it also survives being read in greyscale.
fn eegColormap(t : f32) -> vec3<f32> {
    let x = clamp(t, 0.0, 1.0);
    let c0 = vec3<f32>(0.10, 0.15, 0.45);
    let c1 = vec3<f32>(0.13, 0.63, 0.72);
    let c2 = vec3<f32>(0.92, 0.80, 0.28);
    let c3 = vec3<f32>(0.85, 0.18, 0.15);
    if (x < 0.34) { return mix(c0, c1, x / 0.34); }
    if (x < 0.67) { return mix(c1, c2, (x - 0.34) / 0.33); }
    return mix(c2, c3, (x - 0.67) / 0.33);
}

/// Stroke state at a world position, in material space:
/// (deficit, core, penumbra, chronic).
fn strokeAt(p : vec3<f32>) -> vec4<f32> {
    if (gOpActive < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    let uvw = sdfUvw(toMaterial(p), uniforms.uHalfExtent, uniforms.uStrokeDim);
    return textureSampleLevel(strokeTex, strokeTexSampler, uvw, 0.0);
}

fn propsAt(p : vec3<f32>) -> vec4<f32> {
    return textureSampleLevel(propTex, propTexSampler,
        sdfUvw(toMaterial(p), uniforms.uHalfExtent, uniforms.uPropDim), 0.0);
}

// Ambient occlusion from the distance field: step along the normal and compare
// the distance found against the distance travelled. In a sulcus the field
// stays small because the opposite bank is close, so sulci darken and the
// folding reads as depth. Still the single highest-value shading term.
fn sdfAO(p : vec3<f32>, n : vec3<f32>) -> f32 {
    var occ = 0.0;
    var norm = 0.0;
    var scale = 1.0;
    for (var i : i32 = 1; i <= 5; i = i + 1) {
        let h = uniforms.uVoxelMm * (1.0 + 2.4 * f32(i));
        let d = distAt(p + n * h);
        occ = occ + max(h - d, 0.0) * scale;
        norm = norm + h * scale;
        scale = scale * 0.76;
    }
    return clamp(1.0 - 1.4 * occ / max(norm, 1e-4), 0.0, 1.0);
}

// Cheap single-scatter estimate: march a short ray toward the light and see how
// much tissue is in the way. Extinction is per-channel with red lowest, which
// is why living tissue glows red at the edges rather than grey �?" that
// wavelength dependence IS the look, and it costs four taps.
fn subsurface(p : vec3<f32>, l : vec3<f32>) -> vec3<f32> {
    var depth = 0.0;
    for (var i : i32 = 1; i <= 4; i = i + 1) {
        let h = uniforms.uVoxelMm * 2.2 * f32(i);
        depth = depth + max(-distAt(p + l * h), 0.0);
    }
    let sigma = vec3<f32>(0.055, 0.17, 0.30); // mm^-1, red scatters furthest
    return exp(-depth * sigma);
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let half = uniforms.uHalfExtent;
    let ro = uniforms.uCamPos;

    // Split comparison. Radiology is taught by comparison — prior against
    // current — and no viewer can show a COUNTERFACTUAL, because the healthy
    // version of a diseased brain does not exist as data. Here it does: the
    // operators are a function of parameters, so switching them off for half
    // the pixels renders the same brain, from the same camera, as it would have
    // been. Two marches would be the obvious implementation and would cost
    // double; this costs nothing.
    let splitNdcX = fragmentInputs.vClip.x / fragmentInputs.vClip.w;
    gOpActive = uniforms.uOpActive;
    if (uniforms.uSplitMode > 0.5 && splitNdcX < uniforms.uSplitX) {
        gOpActive = 0.0;
    }

    // Ray direction. Ordinary perspective just points at the interpolated world
    // position; the fisheye instead builds the direction from the pixel's screen
    // position using an EQUIDISTANT mapping (angle proportional to radius),
    // which is what lets the field of view exceed 180° �?" impossible with a
    // projection matrix, where the tangent blows up at 180°. Being able to see
    // sideways is the whole point once the camera is inside a ventricle.
    var rd = normalize(fragmentInputs.vWorld - ro);

    // ---- magic lens ---------------------------------------------------------
    // Two effects in one circular region:
    //
    //   MAGNIFY �?" compress the sampled screen coordinate toward the lens centre,
    //   so a smaller angular range fills the same pixels.
    //
    //   PENETRATE �?" erode the surface locally by uLensDepth. Because adding a
    //   positive scalar to a signed distance field is exactly erosion, the
    //   cortex retreats inside the lens and whatever is underneath �?" white
    //   matter, deep nuclei, and the rasterized ventricle mesh, which keeps its
    //   true depth �?" is revealed. This is the part a wide-angle projection
    //   cannot do: a fisheye changes how much you see from a point, not what is
    //   in the way.
    let ndcNow = fragmentInputs.vClip.xy / fragmentInputs.vClip.w;
    let lens = lensWeight(ndcNow);
    if (lens > 0.001) {
        let k = mix(1.0, 1.0 / max(uniforms.uLensMag, 1.0), lens);
        let ndc2 = uniforms.uLensCentre + (ndcNow - uniforms.uLensCentre) * k;
        rd = normalize(
            uniforms.uCamFwd
            + uniforms.uCamRight * ndc2.x * uniforms.uAspect * uniforms.uTanHalfFov
            + uniforms.uCamUp * ndc2.y * uniforms.uTanHalfFov
        );
    }

    if (uniforms.uFisheye > 0.5) {
        let ndc = fragmentInputs.vClip.xy / fragmentInputs.vClip.w;
        let p = vec2<f32>(ndc.x * uniforms.uAspect, ndc.y);
        let r = length(p);
        if (r > 1.0) {
            discard;
        }
        let theta = r * uniforms.uFisheyeFov * 0.5;
        var dirXY = vec2<f32>(1.0, 0.0);
        if (r > 1e-5) {
            dirXY = p / r;
        }
        rd = normalize(
            uniforms.uCamFwd * cos(theta)
            + (uniforms.uCamRight * dirXY.x + uniforms.uCamUp * dirXY.y) * sin(theta)
        );
    }

    let bounds = marchBounds(ro, rd, half);
    let tNear = bounds.x;
    let tFar = bounds.y;
    if (tFar < tNear) {
        discard;
    }

    let cfg = marchCfg();
    var march = marchComposed(
        sdfTex, sdfTexSampler,
        deformTex, deformTexSampler,
        offsetTex, offsetTexSampler,
        ro, rd, cfg
    );

    // Lens penetration: find the surface, then restart the march a fixed
    // distance past it. That removes a SHELL of known thickness rather than
    // shrinking the whole field along this ray, so structures deeper than the
    // peel survive intact and the lens cannot bore through the head.
    if (lens > 0.001 && march.hit) {
        var deep = cfg;
        deep.startT = march.t + uniforms.uLensDepth * lens;
        let m2 = marchComposed(
            sdfTex, sdfTexSampler,
            deformTex, deformTexSampler,
            offsetTex, offsetTexSampler,
            ro, rd, deep
        );
        if (m2.hit) {
            march = m2;
        } else {
            // Peeled past everything: there is genuinely nothing left on this
            // ray, so show through rather than inventing a surface.
            discard;
        }
    }

    if (!march.hit) {
        discard;
    }

    // Slice view: show ONLY the plane itself. Without this the ray keeps going
    // wherever the plane misses tissue and reveals 3D surface behind the cut,
    // which is a cutaway rather than the flat cross-section a radiological
    // slice is.
    if (uniforms.uSliceOnly > 0.5 && !march.cut) {
        discard;
    }

    let hitPos = march.pos;
    let surf = surfaceAt(hitPos);
    // On a cut face the field's own normal is meaningless �?" the surface we are
    // looking at is the plane, not the anatomy �?" so use the plane's normal.
    let n = select(surf.n, -normalize(uniforms.uClipNormal), march.cut);
    let myelin = propsAt(hitPos).r;
    let path = lesionAt(hitPos);
    let lesion = path.x;
    let edema = path.y;
    let plaque = path.z;
    let v = -rd;

    let key = normalize(vec3<f32>(0.42, 0.78, 0.46));
    let fill = normalize(vec3<f32>(-0.65, 0.10, -0.35));
    let ndl = max(dot(n, key), 0.0);
    let ao = sdfAO(hitPos, n);

    // ---- specimen -----------------------------------------------------------
    // Curvature drives translucency: negative curvature means a convex gyral
    // crown, which is thin, so light leaks through it. Concave sulcal fundi are
    // thick and stay opaque. This term does more for "reads as brain" than any
    // amount of extra lighting.
    let thin = clamp(-surf.curv, 0.0, 1.0);
    let sss = subsurface(hitPos, key) * (0.35 + 0.65 * thin);

    // White matter is paler and less vascular than cortex.
    var tissue = mix(vec3<f32>(0.60, 0.38, 0.355), vec3<f32>(0.80, 0.74, 0.68), myelin);
    if (march.cut) {
        // A cross-section is read by tissue contrast, not by shading. Push the
        // grey/white distinction hard so the cortical ribbon, the white-matter
        // core and the deep nuclei separate the way they do on a cut specimen.
        let props = propsAt(hitPos);
        let deep = props.a;
        tissue = mix(vec3<f32>(0.52, 0.44, 0.44), vec3<f32>(0.93, 0.91, 0.86),
                     smoothstep(0.15, 0.75, myelin));
        tissue = mix(tissue, vec3<f32>(0.68, 0.55, 0.50), deep);
        tissue = mix(tissue, vec3<f32>(0.20, 0.26, 0.34), props.b);
    }
    // Edematous white matter is waterlogged and pale; the lesion body itself is
    // greyer and duller than the tissue it replaced.
    tissue = mix(tissue, vec3<f32>(0.66, 0.70, 0.72), edema * 0.55);
    tissue = mix(tissue, vec3<f32>(0.42, 0.40, 0.44), lesion);
    tissue = mix(tissue, vec3<f32>(0.74, 0.76, 0.72), plaque * 0.5);

    // Infarcted cortex loses its grey/white distinction and goes dusky — the
    // "loss of grey-white differentiation" that is the earliest CT sign. The
    // penumbra is only subtly duskier, because that is the whole diagnostic
    // problem: tissue at risk looks almost normal.
    let sk = strokeAt(hitPos);
    tissue = mix(tissue, vec3<f32>(0.46, 0.42, 0.44), sk.y * 0.75);
    tissue = mix(tissue, vec3<f32>(0.56, 0.46, 0.46), sk.z * 0.35);

    let wrap = max((dot(n, fill) + 0.5) / 1.5, 0.0);
    var spec_col = tissue * mix(0.02, 0.15, ao);
    spec_col = spec_col + tissue * wrap * 0.24 * mix(0.15, 1.0, ao);
    spec_col = spec_col + tissue * ndl * 0.85;
    spec_col = spec_col + vec3<f32>(0.52, 0.13, 0.11) * sss * (0.30 + 0.55 * thin) * mix(0.35, 1.0, ao);

    // Pia mater: a thin wet layer, so a tight specular plus a little Fresnel.
    let hv = normalize(key + v);
    let gloss = pow(max(dot(n, hv), 0.0), 70.0) * mix(0.25, 1.0, ao);
    let fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    spec_col = spec_col + vec3<f32>(1.0, 0.96, 0.90) * gloss * 0.32;
    spec_col = spec_col + vec3<f32>(0.40, 0.46, 0.55) * fres * 0.10;

    // ---- x-ray --------------------------------------------------------------
    // A genuine volumetric integral, not a recolour of the surface. The ray
    // keeps going past the first hit, accumulating Beer-Lambert absorption and
    // emission, so the ventricular system and the deep grey nuclei are visible
    // THROUGH the cortex. That is the whole point of the mode: from Phase 3 on,
    // this is how a lesion buried in white matter becomes legible.
    var xray_col = vec3<f32>(0.0, 0.0, 0.0);
    if (uniforms.uMode > 0.01) {
        let stepMm = 1.5;
        var trans = 1.0;
        var acc = vec3<f32>(0.0, 0.0, 0.0);
        var tv = tNear;
        for (var i : i32 = 0; i < 220; i = i + 1) {
            if (tv > tFar || trans < 0.02) { break; }
            let p = ro + rd * tv;
            let d = distAt(p);
            // Inside the head's extent: either parenchyma (d < 0) or a fluid
            // space enclosed by it. Ventricles are holes in the parenchyma
            // mask, so they read as d > 0 �?" hence the explicit membership
            // channel rather than a distance test.
            let pr = propsAt(p);
            let ventricle = pr.b;
            let deepGm = pr.a;
            let solid = select(0.0, 1.0, d < 0.0);
            let path2 = lesionAt(p);

            // Extinction per mm. Parenchyma is a light haze so the interior
            // stays visible; the structures we care about emit.
            var sigma = 0.011 * solid * (0.6 + 0.8 * pr.r);
            var emit = vec3<f32>(0.10, 0.30, 0.52) * solid * 0.30;

            emit = emit + vec3<f32>(0.30, 0.88, 1.00) * ventricle * 2.6;
            sigma = sigma + 0.020 * ventricle;

            emit = emit + vec3<f32>(1.00, 0.62, 0.22) * deepGm * 1.5;
            sigma = sigma + 0.030 * deepGm;

            // The mode earns its keep here: a lesion buried in white matter is
            // invisible from outside in specimen mode, but glows through the
            // cortex once the ray integrates rather than stopping at the first
            // surface. Edema is the dimmer halo around it.
            emit = emit + vec3<f32>(1.00, 0.28, 0.30) * path2.x * 3.0;
            sigma = sigma + 0.055 * path2.x;
            emit = emit + vec3<f32>(0.95, 0.85, 0.35) * path2.y * 0.9;
            sigma = sigma + 0.012 * path2.y;

            // Demyelinating plaques: bright periventricular ovoids elongated
            // along the medullary veins �?" Dawson's fingers. Only legible in
            // this mode, since they sit deep in white matter.
            emit = emit + vec3<f32>(0.98, 0.98, 0.72) * path2.z * 2.6;
            sigma = sigma + 0.045 * path2.z;

            // Stroke. Core and penumbra get deliberately different colours
            // because distinguishing them is the entire clinical question:
            // the penumbra is what reperfusion can still save.
            // Kept deliberately dimmer than the mass lesion: an infarct occupies
            // a whole territory rather than a compact ball, so the same emission
            // integrates over a far longer path and saturates the image.
            let sv = strokeAt(p);
            emit = emit + vec3<f32>(1.00, 0.20, 0.16) * sv.y * 0.85;
            sigma = sigma + 0.022 * sv.y;
            emit = emit + vec3<f32>(1.00, 0.74, 0.18) * sv.z * 0.55;
            sigma = sigma + 0.010 * sv.z;

            // Substantia nigra. Healthy nigra is densely pigmented and reads as
            // a dark band; depigmentation makes it fade, so the SIGN of the
            // contribution flips with uNigralLoss.
            let nig = nigraAt(p) * solid;
            let pigment = 1.0 - uniforms.uNigralLoss;
            sigma = sigma + 0.16 * nig * pigment;
            emit = emit + vec3<f32>(0.55, 0.42, 0.30) * nig * pigment * 0.9;
            emit = emit + vec3<f32>(0.30, 0.85, 0.95) * nig * uniforms.uNigralLoss * 1.2;

            acc = acc + trans * emit * sigma * stepMm;
            trans = trans * exp(-sigma * stepMm);
            tv = tv + stepMm;
        }
        // Rim light keeps the silhouette and the folding legible on top of the
        // integral; smoothstepped so residual curvature noise stays below the
        // threshold rather than speckling the surface.
        let rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
        xray_col = acc;
        xray_col = xray_col + vec3<f32>(0.35, 0.75, 1.00) * rim * 0.55;
        xray_col = xray_col + vec3<f32>(0.55, 0.90, 1.00)
            * smoothstep(0.25, 0.85, surf.curv) * 0.16;
        xray_col = xray_col + vec3<f32>(0.22, 0.50, 0.80) * ndl * 0.10 * mix(0.6, 1.0, ao);
    }

    var col = mix(spec_col, xray_col, clamp(uniforms.uMode, 0.0, 1.0));
    if (march.cut) {
        // Flat, evenly lit, no subsurface or gloss: a cut face is a slice
        // through the material, and dressing it up as a wet surface would
        // actively obscure the tissue boundaries it exists to show.
        col = tissue * (0.55 + 0.45 * max(dot(n, key), 0.0));
    }

    // Reinhard shoulder, then a gain that keeps midtones off the ceiling.
    col = col / (col + vec3<f32>(1.0, 1.0, 1.0));
    col = clamp(col * 1.9, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));

    // Radiological modality replaces the shading outright, and does so AFTER
    // tone mapping: a scan is a map of measured intensity, and running it
    // through a filmic curve would misrepresent the very contrast being taught.
    // A faint geometric term survives on non-cut surfaces only so a 3D view
    // stays legible; on a cut face the intensity is left completely flat, which
    // is what a slice actually looks like.
    if (uniforms.uModality > 0.5) {
        let mi = modalityIntensity(hitPos, uniforms.uModality, uniforms.uOnsetHours);
        let shade = select(0.82 + 0.18 * max(dot(n, key), 0.0), 1.0, march.cut);
        col = vec3<f32>(mi * shade);
    }

    // Split divider, after tone mapping for the same reason as the lens rim: it
    // is interface. Without a visible line the two halves read as one image and
    // the comparison silently becomes a claim about anatomy.
    if (uniforms.uSplitMode > 0.5) {
        let dx = abs(splitNdcX - uniforms.uSplitX) * uniforms.uAspect;
        col = mix(col, vec3<f32>(0.35, 0.72, 0.96), 1.0 - smoothstep(0.0, 0.004, dx));
    }

    // Lens rim, drawn after tone mapping like the selection glow: it is
    // interface, and a ring that reads as anatomy would be worse than none.
    if (uniforms.uLensActive > 0.5) {
        let lp = (ndcNow - uniforms.uLensCentre) * vec2<f32>(uniforms.uAspect, 1.0);
        let lr = length(lp) / max(uniforms.uLensRadius, 1e-4);
        let ring = smoothstep(0.88, 0.97, lr) * (1.0 - smoothstep(0.99, 1.08, lr));
        col = col + vec3<f32>(0.35, 0.72, 0.96) * ring * 0.6;
        // Slightly cool the exposed interior so the boundary is unmistakable.
        col = mix(col, col * vec3<f32>(0.92, 0.98, 1.05), lens * 0.5);
    }

    // ---- qEEG overlay -------------------------------------------------------
    // Before the selection glow, so selecting a region still reads on top of
    // it, and after tone mapping for the same reason: this is data painted onto
    // the anatomy, not a property of the tissue.
    if (uniforms.uEegOpacity > 0.001) {
        // Exactly 0 means "no projection for this region" — subcortex, white
        // matter and cerebellum, which an EEG inverse says nothing about.
        // Values carry a small floor so the lowest parcel is still painted.
        let e = eegAt(hitPos, n);
        if (e > 0.001) {
            // Keep the shading's own luminance so gyral folding stays legible
            // underneath the colour — a flat wash would hide the anatomy the
            // value is supposed to be attached to.
            let lum = clamp(dot(col, vec3<f32>(0.299, 0.587, 0.114)), 0.25, 1.0);
            col = mix(col, eegColormap(e) * (0.55 + 0.75 * lum),
                      uniforms.uEegOpacity);
        }
    }

    // ---- selection highlight ------------------------------------------------
    // Applied AFTER tone mapping, deliberately. The glow is interface, not
    // tissue: if it went through the tonemapper it would be compressed along
    // with the shading and would read as a material property �?" a suspiciously
    // luminous gyrus �?" instead of as "this is what you selected".
    let sel = selectionAt(hitPos, n);
    if (sel > 0.001) {
        let g = uniforms.uSelectColor;
        // Rim term so the selected region reads as an outlined solid rather
        // than a flat wash, which keeps the underlying folding legible.
        let rimSel = pow(1.0 - max(dot(n, v), 0.0), 2.0);
        let pulse = 0.82 + 0.18 * uniforms.uSelectPulse;
        col = mix(col, mix(col, g, 0.55), sel * 0.75);
        col = col + g * rimSel * sel * 0.85 * pulse;
        col = col + g * sel * 0.10 * pulse;
        col = clamp(col, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
    }

    // Depth. Under ordinary perspective this is the projection matrix's own z,
    // so rasterized meshes composite for free (Phase 0 gate S5).
    //
    // Under fisheye the projection matrix no longer describes where anything is
    // on screen, so its z is meaningless here. Both this shader and the
    // ventricle mesh switch to the SAME simple monotonic mapping �?" distance
    // from the camera, normalised �?" which keeps the shared depth buffer valid.
    // Getting this wrong would silently float the ventricles through the cortex.
    if (uniforms.uFisheye > 0.5) {
        fragmentOutputs.fragDepth = clamp(march.t * uniforms.uDepthScale, 0.0, 1.0);
    } else {
        let clip = scene.viewProjection * vec4<f32>(hitPos, 1.0);
        fragmentOutputs.fragDepth = clip.z / clip.w;
    }
    fragmentOutputs.color = vec4<f32>(pow(col, vec3<f32>(0.4545, 0.4545, 0.4545)), 1.0);
}
