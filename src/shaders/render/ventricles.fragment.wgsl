// BABYLON WGSL DIALECT — see CLAUDE.md "Shader dialects".
//
// The ventricular system is the one structure that most wants a real mesh
// rather than a raymarched surface: its silhouette is the whole diagnostic
// signal in hydrocephalus, ex-vacuo dilatation and mass-effect compression, and
// a crisp rasterized edge reads better than a sphere-traced one at any
// achievable step size.

varying vNormal : vec3<f32>;
varying vViewDir : vec3<f32>;

uniform uTint : vec3<f32>;
uniform uOpacity : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let n = normalize(fragmentInputs.vNormal);
    let v = normalize(fragmentInputs.vViewDir);

    let key = normalize(vec3<f32>(0.42, 0.78, 0.46));
    let ndl = max(dot(n, key), 0.0);
    // Two-sided: the inside of a ventricle is as likely to face the camera as
    // the outside, and a one-sided term makes half the structure go black.
    let wrap = abs(dot(n, key));
    let fres = pow(1.0 - abs(dot(n, v)), 2.5);

    var col = uniforms.uTint * (0.25 + 0.55 * mix(ndl, wrap, 0.5));
    col = col + vec3<f32>(0.75, 0.92, 1.0) * fres * 0.55;

    col = col / (col + vec3<f32>(1.0, 1.0, 1.0));
    col = clamp(col * 1.9, vec3<f32>(0.0), vec3<f32>(1.0));

    fragmentOutputs.color = vec4<f32>(
        pow(col, vec3<f32>(0.4545, 0.4545, 0.4545)),
        uniforms.uOpacity
    );
}
