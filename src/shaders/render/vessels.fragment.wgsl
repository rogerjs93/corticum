// BABYLON WGSL DIALECT — see CLAUDE.md "Shader dialects".

varying vNormal : vec3<f32>;
varying vViewDir : vec3<f32>;
varying vOccluded : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let n = normalize(fragmentInputs.vNormal);
    let v = normalize(fragmentInputs.vViewDir);

    let key = normalize(vec3<f32>(0.42, 0.78, 0.46));
    let ndl = max(dot(n, key), 0.0);
    let rim = pow(1.0 - abs(dot(n, v)), 2.0);

    // Perfused arteries are arterial red; an occluded trunk and everything
    // downstream of it goes dark and desaturated. Showing the vessel still
    // present but empty — rather than deleting it — is the honest depiction:
    // the artery does not disappear, it stops carrying blood.
    let perfused = vec3<f32>(0.82, 0.16, 0.14);
    let empty = vec3<f32>(0.24, 0.22, 0.26);
    let base = mix(perfused, empty, clamp(fragmentInputs.vOccluded, 0.0, 1.0));

    var col = base * (0.30 + 0.70 * ndl);
    col = col + vec3<f32>(1.0, 0.62, 0.55) * rim * 0.30 * (1.0 - fragmentInputs.vOccluded);

    col = col / (col + vec3<f32>(1.0, 1.0, 1.0));
    col = clamp(col * 1.9, vec3<f32>(0.0), vec3<f32>(1.0));

    fragmentOutputs.color = vec4<f32>(pow(col, vec3<f32>(0.4545, 0.4545, 0.4545)), 1.0);
}
