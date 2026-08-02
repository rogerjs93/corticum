// BABYLON WGSL DIALECT — see CLAUDE.md "Shader dialects".
//
// Vertices arrive in MATERIAL space from the Surface Nets extractor and are
// warped here by the FORWARD deformation, exp(w). This is what keeps the mesh
// and the raymarch consistent structurally rather than by discipline: both read
// the same deformation field, and both derive it from the same velocity field,
// so they cannot disagree. It also means a parameter change that only alters
// the deformation needs no re-extraction — the vertices simply move.

#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3<f32>;
attribute normal : vec3<f32>;

varying vNormal : vec3<f32>;
varying vViewDir : vec3<f32>;

var fwdTexSampler : sampler;
var fwdTex : texture_3d<f32>;

uniform uHalfExtent : f32;
uniform uOpDim : f32;
uniform uOpActive : f32;
uniform uCamPos : vec3<f32>;
uniform uFisheye : f32;
uniform uFisheyeFov : f32;
uniform uAspect : f32;
uniform uCamRight : vec3<f32>;
uniform uCamUp : vec3<f32>;
uniform uCamFwd : vec3<f32>;
uniform uDepthScale : f32;

fn opUvw(p : vec3<f32>) -> vec3<f32> {
    return (p + vec3<f32>(uniforms.uHalfExtent)) / (2.0 * uniforms.uHalfExtent)
         + vec3<f32>(0.5 / uniforms.uOpDim);
}

fn fwdAt(p : vec3<f32>) -> vec3<f32> {
    if (uniforms.uOpActive < 0.5) {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    return textureSampleLevel(fwdTex, fwdTexSampler, opUvw(p), 0.0).xyz;
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    let X = vertexInputs.position;
    let displaced = X + fwdAt(X);

    // Normals are covectors: under the deformation they transform by the
    // inverse transpose of the Jacobian, not the Jacobian. Skipping this makes
    // deformed ventricles look unlit and rubbery.
    var n = vertexInputs.normal;
    if (uniforms.uOpActive >= 0.5) {
        let h = 2.0;
        let dx = (fwdAt(X + vec3<f32>(h, 0.0, 0.0)) - fwdAt(X - vec3<f32>(h, 0.0, 0.0))) / (2.0 * h);
        let dy = (fwdAt(X + vec3<f32>(0.0, h, 0.0)) - fwdAt(X - vec3<f32>(0.0, h, 0.0))) / (2.0 * h);
        let dz = (fwdAt(X + vec3<f32>(0.0, 0.0, h)) - fwdAt(X - vec3<f32>(0.0, 0.0, h))) / (2.0 * h);
        n = normalize(vec3<f32>(
            n.x - dot(dx, n),
            n.y - dot(dy, n),
            n.z - dot(dz, n)
        ));
    }

    let world = mesh.world * vec4<f32>(displaced, 1.0);
    vertexOutputs.vNormal = n;
    vertexOutputs.vViewDir = normalize(uniforms.uCamPos - world.xyz);

    if (uniforms.uFisheye > 0.5) {
        // The mesh must be projected the SAME way the raymarch generates its
        // rays, or the two stop sharing a coordinate system and the ventricles
        // float through the cortex. Equidistant mapping, matching
        // brain.fragment.wgsl, plus the same normalised-distance depth.
        //
        // Straight edges become polylines under this mapping, but at ~13k
        // triangles the ventricular mesh is dense enough that it does not show.
        let toP = world.xyz - uniforms.uCamPos;
        let dist = length(toP);
        let dir = toP / max(dist, 1e-5);
        let cosT = clamp(dot(dir, uniforms.uCamFwd), -1.0, 1.0);
        let theta = acos(cosT);
        let r = theta / max(uniforms.uFisheyeFov * 0.5, 1e-4);
        let x = dot(dir, uniforms.uCamRight);
        let y = dot(dir, uniforms.uCamUp);
        var dirXY = vec2<f32>(1.0, 0.0);
        let lxy = length(vec2<f32>(x, y));
        if (lxy > 1e-5) {
            dirXY = vec2<f32>(x, y) / lxy;
        }
        let p = dirXY * r;
        let z = clamp(dist * uniforms.uDepthScale, 0.0, 1.0);
        vertexOutputs.position = vec4<f32>(p.x / uniforms.uAspect, p.y, z, 1.0);
    } else {
        vertexOutputs.position = scene.viewProjection * world;
    }
}
