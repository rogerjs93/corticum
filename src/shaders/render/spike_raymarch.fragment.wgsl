// BABYLON WGSL DIALECT — see the note in spike_raymarch.vertex.wgsl.
//
// Gates S4 and S5:
//   S4 — sample the 3D texture a ComputeShader wrote, and sphere-trace it.
//   S5 — write fragmentOutputs.fragDepth so the raymarched isosurface takes
//        part in ordinary depth testing against rasterized meshes. If this
//        works, the whole raymarch/raster compositing problem is solved with
//        no render targets, no manual depth plumbing, and no bilateral
//        upsample. It is the single highest-value gate in Phase 0.

#include<sceneUboDeclaration>

varying vWorld : vec3<f32>;

var fieldTexSampler : sampler;
var fieldTex : texture_3d<f32>;

uniform uCamPos : vec3<f32>;
uniform uHalfExtent : f32;
uniform uStepScale : f32;

const MAX_STEPS : i32 = 192;
const SURFACE_EPS : f32 = 0.0015;

fn sampleField(p : vec3<f32>) -> f32 {
    // world [-half, +half] -> uvw [0, 1]
    let uvw = p / (2.0 * uniforms.uHalfExtent) + vec3<f32>(0.5, 0.5, 0.5);
    let e = textureSampleLevel(fieldTex, fieldTexSampler, uvw, 0.0).r;
    return (e - 0.5) * 2.0 * uniforms.uHalfExtent;
}

fn fieldNormal(p : vec3<f32>, h : f32) -> vec3<f32> {
    let dx = sampleField(p + vec3<f32>(h, 0.0, 0.0)) - sampleField(p - vec3<f32>(h, 0.0, 0.0));
    let dy = sampleField(p + vec3<f32>(0.0, h, 0.0)) - sampleField(p - vec3<f32>(0.0, h, 0.0));
    let dz = sampleField(p + vec3<f32>(0.0, 0.0, h)) - sampleField(p - vec3<f32>(0.0, 0.0, h));
    return normalize(vec3<f32>(dx, dy, dz));
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let half = uniforms.uHalfExtent;
    let ro = uniforms.uCamPos;
    let rd = normalize(fragmentInputs.vWorld - ro);

    // Intersect the field's bounding cube analytically rather than relying on
    // which face of the box mesh we happen to be shading — that way the march
    // is correct whether the camera is outside or inside the volume.
    let inv = vec3<f32>(1.0, 1.0, 1.0) / rd;
    let lo = vec3<f32>(-half, -half, -half);
    let hi = vec3<f32>(half, half, half);
    let t0 = (lo - ro) * inv;
    let t1 = (hi - ro) * inv;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tNear = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    let tFar = min(min(tmax.x, tmax.y), tmax.z);

    if (tFar < tNear) {
        discard;
    }

    let voxel = 2.0 * half / 128.0;
    var t = tNear;
    var hit = false;
    var prev = 0.0;

    for (var i : i32 = 0; i < MAX_STEPS; i = i + 1) {
        if (t > tFar) { break; }
        let p = ro + rd * t;
        let d = sampleField(p);

        if (d < SURFACE_EPS * half) {
            hit = true;
            // The composed field is only approximately eikonal, so a step can
            // overshoot the surface. Bisect back to recover sub-voxel accuracy.
            if (i > 0) {
                var lo_t = t - max(prev * uniforms.uStepScale, voxel * 0.25);
                var hi_t = t;
                for (var k : i32 = 0; k < 4; k = k + 1) {
                    let mid = (lo_t + hi_t) * 0.5;
                    if (sampleField(ro + rd * mid) < 0.0) { hi_t = mid; } else { lo_t = mid; }
                }
                t = hi_t;
            }
            break;
        }

        prev = d;
        t = t + clamp(d * uniforms.uStepScale, voxel * 0.25, voxel * 4.0);
    }

    if (!hit) {
        discard;
    }

    let hitPos = ro + rd * t;
    let n = fieldNormal(hitPos, voxel * 0.5);

    let key = normalize(vec3<f32>(0.6, 0.8, 0.35));
    let diff = max(dot(n, key), 0.0);
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let base = vec3<f32>(0.72, 0.46, 0.44);
    let col = base * (0.18 + 0.82 * diff) + vec3<f32>(0.28, 0.34, 0.45) * rim;

    // The gate itself: hand the isosurface's true depth to the depth buffer.
    // WebGPU NDC z is already [0, 1], so clip.z / clip.w is the depth value.
    let clip = scene.viewProjection * vec4<f32>(hitPos, 1.0);
    fragmentOutputs.fragDepth = clip.z / clip.w;
    fragmentOutputs.color = vec4<f32>(col, 1.0);
}
