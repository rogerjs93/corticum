//!include common/field.wgsl

// The composed field and the sphere tracer, in ONE place.
//
// This chunk exists because the picking probe and the visible render must agree
// exactly. If picking had its own copy of the march, a click could report a
// region the renderer never drew there — and the divergence would be invisible
// until someone checked, which is the worst kind of bug in a teaching tool.
// Both callers include this file; neither reimplements it.
//
// WGSL allows textures and samplers as function parameters, which is what lets
// a fragment shader in Babylon's dialect and a plain-WGSL compute shader share
// the same body despite having completely different resource declarations.

struct MarchCfg {
  halfExtent: f32,
  rangeMm: f32,
  voxelMm: f32,
  sdfDim: f32,
  opDim: f32,
  opActive: f32,
  stepScale: f32,
  maxSteps: f32,
  // Cutaway plane: keep the half-space where dot(n, p) < offset.
  clipNormal: vec3<f32>,
  clipOffset: f32,
  clipEnabled: f32,
  // Extra erosion applied to this ray only, in mm. Unused by the lens now (see
  // startT) but kept for operators that genuinely want a uniform per-ray shift.
  extraOffsetMm: f32,
  // Begin the march at this distance instead of at the bounding box.
  //
  // This is how the lens peels tissue. The obvious approach — adding a constant
  // offset to the field — erodes it along the WHOLE ray, so it does not remove
  // a layer, it globally shrinks everything that ray can see: thin structures
  // vanish and the lens bores clean through the head. Starting the ray a fixed
  // distance past the first surface removes exactly a shell of that thickness
  // and leaves everything deeper intact.
  startT: f32,
};

struct MarchHit {
  hit: bool,
  t: f32,
  // Position in world space, i.e. where the surface appears.
  pos: vec3<f32>,
  // The same point pulled back into material space, which is where the
  // anatomy actually lives and therefore where labels must be sampled.
  material: vec3<f32>,
  // True when the ray entered already inside tissue, i.e. this pixel is the
  // exposed CUT FACE rather than the natural surface. A cross-section reads
  // completely differently from a pial surface and must be shaded as such.
  cut: bool,
};

/// Pull a world position back into material space through exp(-w).
///
/// Storing the inverse deformation directly is what makes this a plain fetch;
/// a forward displacement field would require solving X = x - u(X), which is
/// implicit.
fn marchToMaterial(
  defTex: texture_3d<f32>, defSmp: sampler,
  p: vec3<f32>, cfg: MarchCfg
) -> vec3<f32> {
  if (cfg.opActive < 0.5) {
    return p;
  }
  let uvw = sdfUvw(p, cfg.halfExtent, cfg.opDim);
  return p + textureSampleLevel(defTex, defSmp, uvw, 0.0).xyz;
}

/// Composed signed distance: base anatomy pulled back through the deformation,
/// plus the offset — the offset also evaluated in MATERIAL space, deliberately,
/// so tissue that has been pushed aside carries its own atrophy with it.
fn composedDist(
  sdfTex: texture_3d<f32>, sdfSmp: sampler,
  defTex: texture_3d<f32>, defSmp: sampler,
  offTex: texture_3d<f32>, offSmp: sampler,
  p: vec3<f32>, cfg: MarchCfg
) -> f32 {
  if (cfg.opActive < 0.5) {
    let u = textureSampleLevel(sdfTex, sdfSmp, sdfUvw(p, cfg.halfExtent, cfg.sdfDim), 0.0).r;
    return decodeSdf(u, cfg.rangeMm) + cfg.extraOffsetMm;
  }
  let X = marchToMaterial(defTex, defSmp, p, cfg);
  let u = textureSampleLevel(sdfTex, sdfSmp, sdfUvw(X, cfg.halfExtent, cfg.sdfDim), 0.0).r;
  let off = textureSampleLevel(offTex, offSmp, sdfUvw(X, cfg.halfExtent, cfg.opDim), 0.0).x;
  return decodeSdf(u, cfg.rangeMm) + off + cfg.extraOffsetMm;
}

/// Ray/box entry and exit against the field's bounding cube.
/// Returns (tNear, tFar); tFar < tNear means the ray misses.
fn marchBounds(ro: vec3<f32>, rd: vec3<f32>, half: f32) -> vec2<f32> {
  let inv = vec3<f32>(1.0, 1.0, 1.0) / rd;
  let t0 = (vec3<f32>(-half, -half, -half) - ro) * inv;
  let t1 = (vec3<f32>(half, half, half) - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2<f32>(
    max(max(max(tmin.x, tmin.y), tmin.z), 0.0),
    min(min(tmax.x, tmax.y), tmax.z)
  );
}

/// Trim the ray interval to the kept side of the cutaway plane.
///
/// A cutaway costs almost nothing in a raymarcher: rather than removing
/// geometry, simply start the ray later. Everything in front of the plane is
/// never sampled, so it cannot contribute.
fn marchClip(bounds: vec2<f32>, ro: vec3<f32>, rd: vec3<f32>, cfg: MarchCfg) -> vec2<f32> {
  if (cfg.clipEnabled < 0.5) {
    return bounds;
  }
  let n = cfg.clipNormal;
  let denom = dot(n, rd);
  let dist = dot(n, ro) - cfg.clipOffset;

  if (abs(denom) < 1e-6) {
    // Ray parallel to the plane: either wholly kept or wholly cut.
    if (dist > 0.0) {
      return vec2<f32>(1.0, -1.0);
    }
    return bounds;
  }

  let tPlane = -dist / denom;
  if (denom < 0.0) {
    // Heading into the kept half-space: enter no earlier than the plane.
    return vec2<f32>(max(bounds.x, tPlane), bounds.y);
  }
  // Heading out of it: leave no later than the plane.
  return vec2<f32>(bounds.x, min(bounds.y, tPlane));
}

fn marchComposed(
  sdfTex: texture_3d<f32>, sdfSmp: sampler,
  defTex: texture_3d<f32>, defSmp: sampler,
  offTex: texture_3d<f32>, offSmp: sampler,
  ro: vec3<f32>, rd: vec3<f32>, cfg: MarchCfg
) -> MarchHit {
  var out: MarchHit;
  out.hit = false;
  out.t = 0.0;
  out.pos = ro;
  out.material = ro;
  out.cut = false;

  let b = marchClip(marchBounds(ro, rd, cfg.halfExtent), ro, rd, cfg);
  if (b.y < b.x) {
    return out;
  }

  let voxel = cfg.voxelMm;
  let steps = i32(cfg.maxSteps);
  var t = max(b.x, cfg.startT);
  if (t > b.y) {
    return out;
  }

  // If the ray begins already inside tissue — because a cutaway plane sliced
  // through the brain, or because the lens peeled a shell off the front — then
  // this pixel shows an exposed CROSS-SECTION. Report it immediately: there is
  // no surface to search for, we are already past it, and it must be shaded as
  // a cut face rather than as a pial surface.
  if (cfg.clipEnabled >= 0.5 || cfg.startT > 0.0) {
    let d0 = composedDist(sdfTex, sdfSmp, defTex, defSmp, offTex, offSmp, ro + rd * t, cfg);
    if (d0 < 0.0) {
      out.hit = true;
      out.cut = true;
      out.t = t;
      out.pos = ro + rd * t;
      out.material = marchToMaterial(defTex, defSmp, out.pos, cfg);
      return out;
    }
  }

  for (var i: i32 = 0; i < steps; i = i + 1) {
    if (t > b.y) {
      break;
    }
    let d = composedDist(sdfTex, sdfSmp, defTex, defSmp, offTex, offSmp, ro + rd * t, cfg);
    if (d < 0.0) {
      // Bisect back onto the surface. The last step overshot by at most its
      // own length, and sub-voxel accuracy matters because the baked normal is
      // fetched at the hit position.
      var lo = t - max(voxel * 0.5, -d);
      var hi = t;
      for (var k: i32 = 0; k < 5; k = k + 1) {
        let mid = (lo + hi) * 0.5;
        let dm = composedDist(sdfTex, sdfSmp, defTex, defSmp, offTex, offSmp, ro + rd * mid, cfg);
        if (dm < 0.0) { hi = mid; } else { lo = mid; }
      }
      out.hit = true;
      out.t = hi;
      out.pos = ro + rd * hi;
      out.material = marchToMaterial(defTex, defSmp, out.pos, cfg);
      return out;
    }
    t = t + max(d * cfg.stepScale, voxel * 0.6);
  }

  return out;
}
