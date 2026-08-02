// Compliance: how readily each part of the head yields to a mass.
//
// This one field is what makes herniation and midline shift *emerge* rather
// than being animated. The dural folds are stiff sheets that tissue cannot
// cross, so encoding them buys three clinically correct behaviours at once:
//
//   * ventricles collapse first, because CSF spaces are the most compliant;
//   * the midline resists until the pressure is high, because the falx is stiff;
//   * the cingulate gyrus herniates UNDER the falx's free edge, because the
//     falx stops above the corpus callosum and leaves a gap there.
//
// The free edge is placed from the subject's own corpus callosum extent
// (manifest landmarks), not from a constant.
//
// Output (rgba8unorm):
//   R  compliance 0..1
//   G  falx membership (debug / rendering)
//   B  tentorium membership
//   A  unused

struct ComplianceParams {
  // x = dim, y = half extent mm, z = corpus callosum top mm,
  // w = cerebellum top mm
  cfg: vec4<f32>,
  // x = falx half-thickness mm, y = tentorium half-thickness mm
  dural: vec4<f32>,
};

@group(0) @binding(0) var propSampler: sampler;
@group(0) @binding(1) var propTex: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: ComplianceParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }

  let half = params.cfg.y;
  let n = f32(dim);
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / n;
  let p = uvw * 2.0 * half - vec3<f32>(half, half, half);

  let props = textureSampleLevel(propTex, propSampler, uvw, 0.0);
  let ventricle = props.b;
  let myelin = props.r;

  // --- falx cerebri ------------------------------------------------------
  // A midsagittal sheet running front to back, present only ABOVE the corpus
  // callosum. Below that height it stops: that gap is the free edge.
  let ccTop = params.cfg.z;
  let falxHalf = params.dural.x;
  let inPlane = 1.0 - smoothstep(falxHalf, falxHalf * 2.2, abs(p.x));
  // Fade in over a few millimetres above the callosal top rather than
  // switching abruptly, so the free edge is a rounded lip, not a step.
  let aboveCC = smoothstep(ccTop, ccTop + 8.0, p.y);
  let falx = inPlane * aboveCC;

  // --- tentorium cerebelli ----------------------------------------------
  // A near-horizontal sheet roofing the posterior fossa: only behind the
  // midbrain and only at the height of the cerebellar apex.
  let tentHalf = params.dural.y;
  let cbTop = params.cfg.w;
  let atHeight = 1.0 - smoothstep(tentHalf, tentHalf * 2.5, abs(p.y - cbTop));
  let posterior = smoothstep(-30.0, -5.0, -p.z);
  let tentorium = atHeight * posterior;

  // --- compliance --------------------------------------------------------
  // CSF spaces give way first; white matter is stiffer than grey; dura barely
  // yields at all.
  var c = 0.45;
  c = mix(c, 0.95, ventricle);
  c = mix(c, 0.35, myelin * 0.5);
  c = mix(c, 0.02, max(falx, tentorium));

  textureStore(dst, vec3<i32>(gid), vec4<f32>(clamp(c, 0.0, 1.0), falx, tentorium, 1.0));
}
