// BABYLON WGSL DIALECT. Flat-shaded so that a wrong vertex layout shows up as
// obviously broken geometry rather than as plausible-looking noise.

varying vLocal : vec3<f32>;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let r = length(fragmentInputs.vLocal.xy);
    let band = smoothstep(0.0, 1.0, fract(r * 3.0));
    let col = mix(vec3<f32>(0.22, 0.62, 0.78), vec3<f32>(0.42, 0.86, 0.62), band);
    fragmentOutputs.color = vec4<f32>(col, 1.0);
}
