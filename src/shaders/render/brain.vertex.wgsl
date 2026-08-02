// BABYLON WGSL DIALECT — thin wrapper only, see CLAUDE.md "Shader dialects".

#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3<f32>;

varying vWorld : vec3<f32>;
// Clip-space position carried through so the fragment shader can recover exact
// screen NDC (vClip.xy / vClip.w). Needed for fisheye ray generation, where the
// ray direction comes from the pixel's screen position rather than from the
// interpolated world position.
varying vClip : vec4<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    let world = mesh.world * vec4<f32>(vertexInputs.position, 1.0);
    let clip = scene.viewProjection * world;
    vertexOutputs.vWorld = world.xyz;
    vertexOutputs.vClip = clip;
    vertexOutputs.position = clip;
}
