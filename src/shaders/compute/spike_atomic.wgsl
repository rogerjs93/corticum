// Gate S7: atomicAdd into a storage buffer plus CPU readback.
//
// This is not busywork — it is exactly the mechanism Surface Nets needs in
// Phase 4 (atomically allocate a vertex slot per active cell, then read the
// final count back to set indexCount). Proving it here means the mesh
// extractor has no unknowns left in its allocation path.

struct Counter {
  total: atomic<u32>,
};

@group(0) @binding(0) var<storage, read_write> counter: Counter;
@group(0) @binding(1) var<storage, read_write> outBuf: array<u32>;

const SPIKE_N: u32 = 1024u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= SPIKE_N) {
    return;
  }
  atomicAdd(&counter.total, 1u);
  outBuf[i] = i * 2u + 1u;
}
