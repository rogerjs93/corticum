// Distance <-> unorm encoding.
//
// Why unorm and not r32float: in core WebGPU, r32float is NOT filterable
// (linear sampling needs the optional `float32-filterable` feature), and the
// 8-bit single-channel formats (r8unorm/r8snorm) are NOT storage-capable in
// core at all. rgba8unorm is both storage-capable and filterable, so it is the
// only format that lets a compute pass write the field and a raymarch pass
// linearly sample it without relying on optional features.
//
// A distance in [-range, +range] maps to [0, 1]. At range = 16 mm the
// quantisation step is 16 * 2 / 255 = 0.125 mm — far finer than the 1 mm voxel
// grid the anatomy is sampled on, so encoding is not the accuracy limit.

fn encodeDistance(d: f32, range: f32) -> f32 {
  return clamp(0.5 + d / (2.0 * range), 0.0, 1.0);
}

fn decodeDistance(e: f32, range: f32) -> f32 {
  return (e - 0.5) * 2.0 * range;
}
