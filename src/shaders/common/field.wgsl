// Field sampling maths, shared by every shader that touches the SDF.
//
// This lives in one place on purpose. The raymarch and the verification probe
// MUST agree exactly: if the probe used its own copy of this arithmetic, it
// could certify a field that the renderer draws differently, which defeats the
// entire point of the gate.

// World position -> normalised texture coordinate.
//
// Voxel *centres* sit at (i + 0.5) / dim, not i / dim. Getting this wrong puts
// every sample exactly on a voxel boundary, where trilinear filtering averages
// two neighbours — the anatomy still looks broadly right, which is what makes
// the mistake easy to miss and expensive to find.
//
//   world p = i - half   (integer millimetres, 1 mm spacing)
//   uvw     = (i + 0.5) / dim = (p + half) / (2*half) + 0.5 / dim
fn sdfUvw(p: vec3<f32>, half: f32, dim: f32) -> vec3<f32> {
    return (p + vec3<f32>(half, half, half)) / (2.0 * half)
         + vec3<f32>(0.5 / dim, 0.5 / dim, 0.5 / dim);
}

// The field is quantised int8 over +-range, then stored as r8unorm:
//   byte = i8 + 128,  u = byte / 255,  i8 = u*255 - 128,  d = i8/127 * range
// The encoding is affine, so linear filtering of u equals linear filtering of d.
fn decodeSdf(u: f32, range: f32) -> f32 {
    return (u * 255.0 - 128.0) / 127.0 * range;
}
