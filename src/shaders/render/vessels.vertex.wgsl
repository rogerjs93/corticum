// BABYLON WGSL DIALECT — see CLAUDE.md "Shader dialects".
//
// Arteries are grown in MATERIAL space and warped here by the forward
// deformation, exactly like the ventricle mesh. Vessels are dragged by mass
// effect along with the tissue they run through, which is precisely what makes
// vascular displacement a radiological sign.

#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3<f32>;
attribute normal : vec3<f32>;
attribute uv : vec2<f32>;

varying vNormal : vec3<f32>;
varying vViewDir : vec3<f32>;
varying vOccluded : f32;

var fwdTexSampler : sampler;
var fwdTex : texture_3d<f32>;

uniform uHalfExtent : f32;
uniform uOpDim : f32;
uniform uOpActive : f32;
uniform uCamPos : vec3<f32>;
// Trunk index -> occluded flag, four per vec4.
uniform uOccludedTrunks : array<vec4<f32>, 16>;

fn fwdAt(p : vec3<f32>) -> vec3<f32> {
    if (uniforms.uOpActive < 0.5) {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    let uvw = (p + vec3<f32>(uniforms.uHalfExtent)) / (2.0 * uniforms.uHalfExtent)
            + vec3<f32>(0.5 / uniforms.uOpDim);
    return textureSampleLevel(fwdTex, fwdTexSampler, uvw, 0.0).xyz;
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    let X = vertexInputs.position;
    let world = mesh.world * vec4<f32>(X + fwdAt(X), 1.0);

    let trunk = u32(round(vertexInputs.uv.x));
    let v = uniforms.uOccludedTrunks[trunk >> 2u];
    let laneIdx = trunk & 3u;
    var occ = v.x;
    if (laneIdx == 1u) { occ = v.y; }
    else if (laneIdx == 2u) { occ = v.z; }
    else if (laneIdx == 3u) { occ = v.w; }

    vertexOutputs.vNormal = vertexInputs.normal;
    vertexOutputs.vViewDir = normalize(uniforms.uCamPos - world.xyz);
    vertexOutputs.vOccluded = occ;
    vertexOutputs.position = scene.viewProjection * world;
}
