// BABYLON WGSL DIALECT — not standalone-valid WGSL, excluded from Tint
// validation. No @group/@binding here; Babylon's processor injects them.
// Keep this file thin: all real logic belongs in shaders/common where it can
// be validated. See CLAUDE.md "Shader dialects".

#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3<f32>;

varying vWorld : vec3<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    let world = mesh.world * vec4<f32>(vertexInputs.position, 1.0);
    vertexOutputs.vWorld = world.xyz;
    vertexOutputs.position = scene.viewProjection * world;
}
