//!include common/surfacenets_core.wgsl

// Surface Nets pass 1: find cells the isosurface crosses and atomically
// allocate a vertex slot for each.

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = vec3<i32>(gid);
  if (!snInRange(c)) {
    return;
  }

  if (!snActive(c)) {
    cellSlot[snCellIndex(c)] = INVALID;
    return;
  }

  let slot = atomicAdd(&counters.vertexCount, 1u);
  if (slot >= u32(params.limits.x)) {
    cellSlot[snCellIndex(c)] = INVALID;
    return;
  }
  cellSlot[snCellIndex(c)] = slot;
}
