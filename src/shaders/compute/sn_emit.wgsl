//!include common/surfacenets_core.wgsl

// Surface Nets pass 2: place each active cell's dual vertex, then stitch quads
// between neighbouring cells' vertices.

// Output bindings live here rather than in the shared core, because the
// classify pass does not use them and a declared-but-unused binding is stripped
// from the compiled layout.
@group(0) @binding(4) var<storage, read_write> verts: array<f32>;
@group(0) @binding(5) var<storage, read_write> indices: array<u32>;

fn snEmitQuad(a: u32, b: u32, c2: u32, d: u32, flip: bool) {
  if (a == INVALID || b == INVALID || c2 == INVALID || d == INVALID) {
    return;
  }
  let base = atomicAdd(&counters.indexCount, 6u);
  if (base + 6u > u32(params.limits.y)) {
    return;
  }
  if (flip) {
    indices[base + 0u] = a; indices[base + 1u] = b; indices[base + 2u] = c2;
    indices[base + 3u] = a; indices[base + 4u] = c2; indices[base + 5u] = d;
  } else {
    indices[base + 0u] = a; indices[base + 1u] = c2; indices[base + 2u] = b;
    indices[base + 3u] = a; indices[base + 4u] = d; indices[base + 5u] = c2;
  }
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = vec3<i32>(gid);
  if (!snInRange(c)) {
    return;
  }

  let slot = cellSlot[snCellIndex(c)];
  if (slot == INVALID) {
    return;
  }

  let frac = snDualVertex(c);
  let world = snToWorld(c, frac);
  let nrm = snGradient(c);

  let vo = slot * 6u;
  verts[vo + 0u] = world.x;
  verts[vo + 1u] = world.y;
  verts[vo + 2u] = world.z;
  verts[vo + 3u] = nrm.x;
  verts[vo + 4u] = nrm.y;
  verts[vo + 5u] = nrm.z;

  // For each of the three edges leaving corner 0 in a positive direction: if
  // the surface crosses it, the four cells sharing that edge each own a vertex
  // and those four form a quad.
  if (c.x < 1 || c.y < 1 || c.z < 1) {
    return;
  }
  let v0 = snSample(c);

  let vx = snSample(c + vec3<i32>(1, 0, 0));
  if ((v0 < 0.0) != (vx < 0.0)) {
    snEmitQuad(
      slot,
      cellSlot[snCellIndex(c - vec3<i32>(0, 1, 0))],
      cellSlot[snCellIndex(c - vec3<i32>(0, 1, 1))],
      cellSlot[snCellIndex(c - vec3<i32>(0, 0, 1))],
      v0 < 0.0
    );
  }

  let vy = snSample(c + vec3<i32>(0, 1, 0));
  if ((v0 < 0.0) != (vy < 0.0)) {
    snEmitQuad(
      slot,
      cellSlot[snCellIndex(c - vec3<i32>(0, 0, 1))],
      cellSlot[snCellIndex(c - vec3<i32>(1, 0, 1))],
      cellSlot[snCellIndex(c - vec3<i32>(1, 0, 0))],
      v0 < 0.0
    );
  }

  let vz = snSample(c + vec3<i32>(0, 0, 1));
  if ((v0 < 0.0) != (vz < 0.0)) {
    snEmitQuad(
      slot,
      cellSlot[snCellIndex(c - vec3<i32>(1, 0, 0))],
      cellSlot[snCellIndex(c - vec3<i32>(1, 1, 0))],
      cellSlot[snCellIndex(c - vec3<i32>(0, 1, 0))],
      v0 < 0.0
    );
  }
}
