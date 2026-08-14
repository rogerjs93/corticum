import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from './loader';
import type { DerivedFields } from './derived';
import { isNullState, type DiseaseState } from '../disease/types';
import { braakWeights, ftdWeights } from '../disease/braak';
import { occlusionById, territoryOf } from '../disease/territories';
import type { RegionModifiers } from '../disease/regions';

/**
 * Operator-field resolution.
 *
 * A compromise between two opposing pressures.
 *
 * Coarse is good for the DEFORMATION: it is smooth by construction (a warp with
 * high-frequency content would not be a diffeomorphism), the raymarch samples it
 * on every step, and cache footprint matters far more than resolution — the
 * 256^3 equivalent would be 134 MB and repeat the Phase 2 bandwidth mistake.
 *
 * But the OFFSET field carries per-region atrophy, which is not smooth at all:
 * region boundaries are sharp. At 64^3 (3.25 mm voxels) the hippocampus spans
 * about three cells, most of which sample a neighbouring label, so Braak-V
 * hippocampal loss measured 1.94% against a literature range of 15-30%. The
 * staging PATTERN was correct — primary cortex was properly spared — but small
 * structures simply could not be resolved.
 *
 * 128^3 gives 1.625 mm voxels and ~6 cells across the hippocampus, at 16.8 MB
 * per rgba16float field. Still an order of magnitude below the texture that
 * caused the Phase 2 collapse.
 */
export const OP_DIM = 128;

/**
 * Number of squarings in the exponential.
 *
 * The requirement is roughly ||w / 2^n|| * L < 0.5, where L is the Lipschitz
 * constant of the velocity field. n = 8 means the initial step is w/256; two
 * extra squarings over the theoretical minimum cost two dispatches at 64^3 and
 * buy a 4x margin on a bound we can only estimate.
 */
export const EXP_STEPS = 8;

/**
 * Blur passes applied to the velocity field before exponentiating.
 *
 * The kernel is a fixed 3x3x3 in VOXELS, so its physical radius scales with the
 * grid. Moving OP_DIM from 64 to 128 halved the smoothing distance, the
 * Lipschitz bound rose accordingly, and the diffeomorphism round-trip drifted
 * from 0.051 mm to 0.123 mm — through the 0.1 mm gate. Doubling the passes
 * restores the same physical smoothing scale.
 *
 * Keep this proportional to OP_DIM if the resolution changes again.
 */
export const VELOCITY_BLUR_PASSES = 4;

/** Resolution of the stroke field. Sampled once per hit, never per march step. */
export const STROKE_DIM = 128;

export interface OperatorFields {
  /** rgba8unorm: R perfusion deficit, G core, B penumbra, A chronic. */
  stroke: RawTexture3D;
  strokeDim: number;
  /** rgba16float: xyz = inverse displacement (world -> material), mm. */
  deformInv: RawTexture3D;
  /** rgba16float: xyz = forward displacement (material -> world), mm. */
  deformFwd: RawTexture3D;
  /** rgba16float: x = offset mm, y = lesion, z = edema. */
  offset: RawTexture3D;
  /** rgba8unorm: R = compliance, G = falx, B = tentorium. */
  compliance: RawTexture3D;
  dim: number;
  /** True when any pathology is active, so the shader can skip the warp. */
  active: boolean;
  lastEvalMs: number;
  evaluate: (state: DiseaseState, modifiers?: RegionModifiers) => Promise<void>;
  dispose: () => void;
}

function storage3D(
  scene: Scene,
  dim: number,
  name: string,
  type: number
): RawTexture3D {
  const t = new RawTexture3D(
    null,
    dim,
    dim,
    dim,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    type,
    Constants.TEXTURE_CREATIONFLAG_STORAGE
  );
  t.name = name;
  t.wrapU = Texture.CLAMP_ADDRESSMODE;
  t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.wrapR = Texture.CLAMP_ADDRESSMODE;
  return t;
}

export async function createOperators(
  engine: WebGPUEngine,
  scene: Scene,
  field: LoadedField,
  derived: DerivedFields
): Promise<OperatorFields> {
  const half = field.manifest.grid.halfExtentMm;
  const dim = OP_DIM;
  const g = Math.ceil(dim / 4);

  const submit = () => {
    engine.beginFrame();
    engine.endFrame();
  };

  // Half float, not a unorm encoding. Scaling-and-squaring composes the field
  // six times and quantisation error roughly doubles per composition, so 8-bit
  // displacements would accumulate millimetres of error — larger than the
  // effect being measured.
  const HALF_FLOAT = Constants.TEXTURETYPE_HALF_FLOAT;

  const velocity = storage3D(scene, dim, 'velocity', HALF_FLOAT);
  const deformInv = storage3D(scene, dim, 'deformInv', HALF_FLOAT);
  const deformFwd = storage3D(scene, dim, 'deformFwd', HALF_FLOAT);
  const scratch = storage3D(scene, dim, 'expScratch', HALF_FLOAT);
  const offset = storage3D(scene, dim, 'offset', HALF_FLOAT);
  const compliance = storage3D(
    scene,
    dim,
    'compliance',
    Constants.TEXTURETYPE_UNSIGNED_BYTE
  );

  // ---- compliance: built once, it depends only on anatomy ----------------
  const lm = field.manifest.landmarks ?? {};
  const compParams = new UniformBuffer(engine, undefined, undefined, 'compParams');
  compParams.addUniform('cfg', 4);
  compParams.addUniform('dural', 4);
  compParams.updateFloat4(
    'cfg',
    dim,
    half,
    lm.corpusCallosumTopMm ?? 25,
    lm.cerebellumTopMm ?? -20
  );
  compParams.updateFloat4('dural', 2.5, 3.0, 0, 0);
  compParams.update();

  const compPass = new ComputeShader(
    'compliance',
    engine,
    { computeSource: resolveWgsl('compute/compliance.wgsl') },
    {
      bindingsMapping: {
        propTex: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
      },
    }
  );
  compPass.setTexture('propTex', derived.props);
  compPass.setStorageTexture('dst', compliance);
  compPass.setUniformBuffer('params', compParams);
  await compPass.dispatchWhenReady(g, g, g);
  submit();

  // ---- per-parameter-change passes ---------------------------------------
  const velParams = new UniformBuffer(engine, undefined, undefined, 'velParams');
  velParams.addUniform('cfg', 4);
  velParams.addUniform('massCentre', 4);
  velParams.addUniform('massShape', 4);
  velParams.addUniform('massClot', 4);

  const velPass = new ComputeShader(
    'opVelocity',
    engine,
    { computeSource: resolveWgsl('compute/op_velocity.wgsl') },
    {
      bindingsMapping: {
        compTex: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
      },
    }
  );
  velPass.setTexture('compTex', compliance);
  velPass.setStorageTexture('dst', velocity);
  velPass.setUniformBuffer('params', velParams);

  const offParams = new UniformBuffer(engine, undefined, undefined, 'offParams');
  offParams.addUniform('cfg', 4);
  offParams.addUniform('massCentre', 4);
  offParams.addUniform('massShape', 4);
  offParams.addUniform('massClot', 4);
  offParams.addUniform('ms', 4);
  offParams.addUniform('vent', 4);
  offParams.addUniform('atrophyLut', 4, 64);

  const offPass = new ComputeShader(
    'opOffset',
    engine,
    { computeSource: resolveWgsl('compute/op_offset.wgsl') },
    {
      bindingsMapping: {
        propTex: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
        labTex: { group: 0, binding: 6 },
        ventTex: { group: 0, binding: 8 },
      },
    }
  );
  offPass.setTexture('propTex', derived.props);
  offPass.setStorageTexture('dst', offset);
  offPass.setUniformBuffer('params', offParams);
  offPass.setTexture('labTex', field.labels);
  offPass.setTexture('ventTex', field.ventricles);

  // Region index -> atrophy in mm. Rebuilt on every parameter change from the
  // staging tables; several diseases sum into it, which is what makes
  // comorbidity work without special-casing.
  const atrophyLut = new Float32Array(256);
  const labelToIndex = new Map(field.regions.map((r) => [r.fsLabel, r.index]));

  // ---- stroke -------------------------------------------------------------
  const stroke = storage3D(
    scene,
    STROKE_DIM,
    'stroke',
    Constants.TEXTURETYPE_UNSIGNED_BYTE
  );

  // Region index -> arterial territory. Fixed for a given subject, so built
  // once; only the per-territory occlusion severity changes with parameters.
  const territoryLut = new Float32Array(256);
  for (const r of field.regions) {
    if (r.index < 256) territoryLut[r.index] = territoryOf(r.fsLabel);
  }
  const occludedLut = new Float32Array(16);
  const sideLut = new Float32Array(16);

  const strokeParams = new UniformBuffer(engine, undefined, undefined, 'strokeParams');
  strokeParams.addUniform('cfg', 4);
  strokeParams.addUniform('clin', 4);
  strokeParams.addUniform('thr', 4);
  strokeParams.addUniform('territoryLut', 4, 64);
  strokeParams.addUniform('occludedLut', 4, 4);
  strokeParams.addUniform('sideLut', 4, 4);

  const strokePass = new ComputeShader(
    'opStroke',
    engine,
    { computeSource: resolveWgsl('compute/op_stroke.wgsl') },
    {
      bindingsMapping: {
        labTex: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
        sdfTex: { group: 0, binding: 6 },
      },
    }
  );
  strokePass.setTexture('labTex', field.labels);
  strokePass.setStorageTexture('dst', stroke);
  strokePass.setUniformBuffer('params', strokeParams);
  strokePass.setTexture('sdfTex', field.sdf);

  // The exponential passes are re-bound per invocation (src/dst ping-pong), so
  // they are constructed once per (src, dst) pair on demand and cached.
  const initParams = new UniformBuffer(engine, undefined, undefined, 'expInitParams');
  initParams.addUniform('cfg', 4);
  const sqParams = new UniformBuffer(engine, undefined, undefined, 'expSqParams');
  sqParams.addUniform('cfg', 4);
  sqParams.updateFloat4('cfg', dim, half, 0, 0);
  sqParams.update();

  // ---- velocity blur ------------------------------------------------------
  const blurParams = new UniformBuffer(engine, undefined, undefined, 'blurParams');
  blurParams.addUniform('cfg', 4);
  blurParams.updateFloat4('cfg', dim, 4, 0, 0);
  blurParams.update();

  const makeBlur = (src: RawTexture3D, dst: RawTexture3D): ComputeShader => {
    const cs = new ComputeShader(
      `blur_${src.name}_${dst.name}`,
      engine,
      { computeSource: resolveWgsl('compute/blur3d.wgsl') },
      {
        bindingsMapping: {
          src: { group: 0, binding: 1 },
          dst: { group: 0, binding: 2 },
          params: { group: 0, binding: 3 },
        },
      }
    );
    cs.setTexture('src', src);
    cs.setStorageTexture('dst', dst);
    cs.setUniformBuffer('params', blurParams);
    return cs;
  };
  // Ping-pong through scratch; an even number of passes returns to `velocity`.
  const blurVtoS = makeBlur(velocity, scratch);
  const blurStoV = makeBlur(scratch, velocity);

  const initCache = new Map<string, ComputeShader>();
  const makeInit = (src: RawTexture3D, dst: RawTexture3D): ComputeShader => {
    const key = `${src.name}->${dst.name}`;
    let cs = initCache.get(key);
    if (!cs) {
      cs = new ComputeShader(
        `expInit_${key}`,
        engine,
        { computeSource: resolveWgsl('compute/exp_init.wgsl') },
        {
          bindingsMapping: {
            src: { group: 0, binding: 1 },
            dst: { group: 0, binding: 2 },
            params: { group: 0, binding: 3 },
          },
        }
      );
      cs.setTexture('src', src);
      cs.setStorageTexture('dst', dst);
      cs.setUniformBuffer('params', initParams);
      initCache.set(key, cs);
    }
    return cs;
  };

  const sqCache = new Map<string, ComputeShader>();
  const makeSquare = (src: RawTexture3D, dst: RawTexture3D): ComputeShader => {
    const key = `${src.name}->${dst.name}`;
    let cs = sqCache.get(key);
    if (!cs) {
      cs = new ComputeShader(
        `expSq_${key}`,
        engine,
        { computeSource: resolveWgsl('compute/exp_square.wgsl') },
        {
          bindingsMapping: {
            src: { group: 0, binding: 1 },
            dst: { group: 0, binding: 2 },
            params: { group: 0, binding: 3 },
          },
        }
      );
      cs.setTexture('src', src);
      cs.setStorageTexture('dst', dst);
      cs.setUniformBuffer('params', sqParams);
      sqCache.set(key, cs);
    }
    return cs;
  };

  /**
   * Exponentiate the velocity field into `target`.
   *
   * Ping-pongs between `target` and `scratch`. The initial u_0 is written into
   * `target` — not `scratch` — precisely because EXP_STEPS is even: writes then
   * alternate scratch, target, scratch, ... and the final one lands in
   * `target`, so no copy pass is needed. Starting in `scratch` leaves the
   * result in the wrong texture, which the assertion below catches.
   */
  const exponentiate = async (sign: number, target: RawTexture3D) => {
    initParams.updateFloat4('cfg', dim, 1 / 2 ** EXP_STEPS, sign, 0);
    initParams.update();
    await makeInit(velocity, target).dispatchWhenReady(g, g, g);

    let src = target;
    let dst = scratch;
    for (let i = 0; i < EXP_STEPS; i++) {
      await makeSquare(src, dst).dispatchWhenReady(g, g, g);
      const t = src;
      src = dst;
      dst = t;
    }
    // After an even number of swaps `src` holds the result.
    if (src !== target) {
      throw new Error('exponentiate: parity error, result is not in target');
    }
  };

  const result: OperatorFields = {
    stroke,
    strokeDim: STROKE_DIM,
    deformInv,
    deformFwd,
    offset,
    compliance,
    dim,
    active: false,
    lastEvalMs: 0,
    evaluate: async (state: DiseaseState, modifiers?: RegionModifiers) => {
      const t0 = performance.now();
      const m = state.mass;
      const enabled = m.enabled ? 1 : 0;

      // HAEMATOMA EXPANSION. Roughly a third of intracerebral haemorrhages grow
      // in the first hours, and early growth is the strongest modifiable
      // predictor of a bad outcome — it is why the "spot sign" and rapid blood
      // pressure control matter. Modelled as a saturating rise to +33% volume
      // over ~6 hours, which in RADIUS is the cube root of that.
      //
      // A tumour ignores this entirely: its timescale is the scenario's months.
      const expansionVol =
        m.kind === 'haemorrhage'
          ? 1 + 0.33 * Math.min(Math.max(m.hoursSinceIctus, 0) / 6, 1)
          : 1;
      const effectiveRadius = m.radiusMm * Math.cbrt(expansionVol);

      // Clot shape. Irregularity and region confinement are APPEARANCE and
      // space-claiming only — the velocity field keeps the analytic sphere,
      // because its divergence-free form and bounded Lipschitz constant are
      // what guarantee the deformation is a diffeomorphism. Perturbing that
      // would trade an invertibility proof for a prettier margin.
      const clot: [number, number, number, number] = [
        m.kind === 'haemorrhage' ? m.irregularity : 0,
        m.kind === 'haemorrhage' ? m.targetRegion : -1,
        m.kind === 'haemorrhage' ? m.density : 1,
        0,
      ];
      velParams.updateFloat4('cfg', dim, half, 0, 0);
      velParams.updateFloat4(
        'massCentre',
        m.centre[0],
        m.centre[1],
        m.centre[2],
        effectiveRadius
      );
      velParams.updateFloat4(
        'massShape',
        m.edemaExtentMm,
        m.edemaStrength,
        m.necrosis,
        enabled
      );
      velParams.updateFloat4('massClot', clot[0], clot[1], clot[2], clot[3]);
      velParams.update();
      await velPass.dispatchWhenReady(g, g, g);

      // Bound the Lipschitz constant before exponentiating. The compliance
      // field's dural sheets are near-discontinuous, and exp() of a
      // discontinuous velocity is not a diffeomorphism — see blur3d.wgsl.
      for (let i = 0; i < VELOCITY_BLUR_PASSES; i++) {
        await blurVtoS.dispatchWhenReady(g, g, g);
        await blurStoV.dispatchWhenReady(g, g, g);
      }

      // Sum every degenerative process into one per-region table, then apply
      // the user's per-region modifiers:
      //
      //   atrophy[r] = ( braak[r] + ftd[r] + ... ) * vulnerability[r]
      //              + override[r]
      //
      // The multiplier scales what a disease already assigns, so it composes
      // with staging and cannot invent atrophy where the disease does not
      // reach; the override adds millimetres directly for free exploration.
      atrophyLut.fill(0);
      const applyWeights = (w: Map<number, number>, peakMm: number) => {
        for (const [fsLabel, weight] of w) {
          const idx = labelToIndex.get(fsLabel);
          if (idx !== undefined && idx < 256) {
            atrophyLut[idx] += weight * peakMm;
          }
        }
      };
      const n = state.neuro;
      if (n.braakStage > 0) applyWeights(braakWeights(n.braakStage), n.peakThinningMm);
      if (n.ftdSeverity > 0) {
        applyWeights(ftdWeights(n.ftdSeverity, n.ftdAsymmetry), n.peakThinningMm);
      }

      if (modifiers && !modifiers.isEmpty) {
        for (let i = 0; i < 256; i++) {
          atrophyLut[i] = atrophyLut[i] * modifiers.getVulnerability(i) + modifiers.getOverride(i);
        }
      }

      offParams.updateFloat4('cfg', dim, half, state.globalAtrophyMm, field.manifest.grid.dim);
      offParams.updateFloat4(
        'massCentre',
        m.centre[0],
        m.centre[1],
        m.centre[2],
        effectiveRadius
      );
      offParams.updateFloat4(
        'massShape',
        m.edemaExtentMm,
        m.edemaStrength,
        m.necrosis,
        enabled
      );
      // The OFFSET pass is where the lesion membership is actually computed, so
      // omitting this left density at 0 and the clot rendered as nothing at all
      // — while the velocity pass, which does not use it, kept working.
      offParams.updateFloat4('massClot', clot[0], clot[1], clot[2], clot[3]);
      offParams.updateFloat4(
        'ms',
        state.ms.enabled ? 1 : 0,
        state.ms.load,
        state.ms.periventricularBias,
        state.ms.fingerAspect
      );
      offParams.updateFloat4(
        'vent',
        field.ventricleDim,
        field.manifest.sdf.rangeMm,
        0,
        0
      );
      offParams.updateFloatArray('atrophyLut', atrophyLut);
      offParams.update();
      await offPass.dispatchWhenReady(g, g, g);

      // ---- stroke ---------------------------------------------------------
      const st = state.stroke;
      occludedLut.fill(0);
      sideLut.fill(0);
      // `lesions` lets a patient preset name several occlusions at once, in
      // different hemispheres — which the stroke_qeeg cohort routinely does.
      // A plain single-site selection is just the one-element case.
      const lesions = st.lesions?.length
        ? st.lesions
        : st.enabled
          ? [{ site: st.site, side: st.side }]
          : [];
      for (const l of lesions) {
        const s = occlusionById(l.site);
        if (!s) continue;
        // World X is Right, so left = -1. A bilateral site passes 0, which the
        // shader reads as "no midline gate".
        const sign = s.bilateral ? 0 : l.side === 'right' ? 1 : -1;
        for (const a of s.affects) {
          // Two lesions can share a territory on opposite sides; that is
          // genuinely bilateral involvement of it.
          if (occludedLut[a.territory] > 0 && sideLut[a.territory] !== sign) {
            sideLut[a.territory] = 0;
          } else {
            sideLut[a.territory] = sign;
          }
          occludedLut[a.territory] = Math.max(occludedLut[a.territory], a.severity);
        }
      }
      const sg = Math.ceil(STROKE_DIM / 4);
      strokeParams.updateFloat4(
        'cfg',
        STROKE_DIM,
        half,
        field.manifest.grid.dim,
        field.manifest.grid.dim
      );
      strokeParams.updateFloat4(
        'clin',
        st.enabled ? 1 : 0,
        st.collateralGrade,
        st.hoursSinceOnset,
        field.manifest.sdf.rangeMm
      );
      // Core at rCBF < 30%, penumbra at Tmax > 6 s — the DEFUSE-3 / DAWN
      // framing, expressed here as thresholds on the deficit field.
      strokeParams.updateFloat4('thr', 0.7, 0.35, st.recanalisationHour, 0);
      strokeParams.updateFloatArray('territoryLut', territoryLut);
      strokeParams.updateFloatArray('occludedLut', occludedLut);
      strokeParams.updateFloatArray('sideLut', sideLut);
      strokeParams.update();
      await strokePass.dispatchWhenReady(sg, sg, sg);

      // The raymarch pulls back through the INVERSE, so that is the one it
      // needs; the forward field is for warping extracted mesh vertices in
      // Phase 4. Both come from the same velocity field, which is what
      // guarantees they are exact inverses of one another.
      await exponentiate(-1, deformInv);
      await exponentiate(+1, deformFwd);

      submit();
      result.active = !isNullState(state) || !!(modifiers && !modifiers.isEmpty);
      result.lastEvalMs = performance.now() - t0;
    },
    dispose: () => {
      velocity.dispose();
      deformInv.dispose();
      deformFwd.dispose();
      scratch.dispose();
      offset.dispose();
      compliance.dispose();
      stroke.dispose();
      strokeParams.dispose();
      compParams.dispose();
      blurParams.dispose();
      velParams.dispose();
      offParams.dispose();
      initParams.dispose();
      sqParams.dispose();
    },
  };

  return result;
}
