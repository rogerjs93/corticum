// BABYLON WGSL DIALECT. Renders the ring whose vertex buffer was filled by
// spike_genverts.wgsl on the GPU (gate S6).

#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec3<f32>;

varying vLocal : vec3<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    vertexOutputs.vLocal = vertexInputs.position;
    vertexOutputs.position = scene.viewProjection * mesh.world * vec4<f32>(vertexInputs.position, 1.0);
}
