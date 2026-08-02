// Pure SDF helpers: no bindings, no entry points.
//
// Every file under shaders/common and shaders/compute is STANDALONE-VALID WGSL
// (a module of only functions is legal), which is what lets
// tests/node/wgsl_validate.mjs run real Tint validation on them without a
// browser. Babylon's ShaderMaterial dialect is NOT valid standalone WGSL, so
// nothing in here may use it — keep that dialect confined to shaders/render.

fn sdSphere(p: vec3<f32>, c: vec3<f32>, r: f32) -> f32 {
  return length(p - c) - r;
}

fn sdBox(p: vec3<f32>, b: vec3<f32>) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0, 0.0, 0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Polynomial smooth union (iq). k is the blend radius, same units as a and b.
fn opSmoothUnion(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Slab method. Returns (tNear, tFar); tFar < tNear means the ray misses.
fn rayBox(ro: vec3<f32>, rd: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> vec2<f32> {
  let inv = vec3<f32>(1.0, 1.0, 1.0) / rd;
  let t0 = (lo - ro) * inv;
  let t1 = (hi - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2<f32>(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
