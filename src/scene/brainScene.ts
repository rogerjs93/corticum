import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector2, Vector3, Color4 } from '@babylonjs/core/Maths/math';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import { loadField, type LoadedField, type FieldOverride } from '../fields/loader';
import { buildDerived, type DerivedFields } from '../fields/derived';
import { createOperators, type OperatorFields } from '../fields/operators';
import { defaultDiseaseState, type DiseaseState, type DiseasePatch } from '../disease/types';
import { Picker, type PickResult } from '../render/picking';
import { VolumeProbe } from '../verify/volumeProbe';
import { RegionModifiers } from '../disease/regions';
import {
  SCENARIOS,
  baselineForScenario,
  scenarioById,
  type Scenario,
} from '../disease/trajectories';
import { extractIsosurface, type ExtractedMesh } from '../render/meshExtract';
import { growVessels, type VesselTree } from '../fields/vessels/graph';
import { buildVesselMesh, type VesselMesh } from '../render/vessels';
import { Color3 } from '@babylonjs/core/Maths/math';
import { loadEeg, type EegProjector, type EegBand } from '../eeg/project';
import {
  mtaScale, gcaScale, fazekasScale, hippocampalVolume, parenchymalVolume,
  type ScaleResult,
} from '../disease/scales';
import { AspectsProbe, type AspectsResult } from '../verify/aspectsProbe';
import { ExportProbe, type ExportResult } from '../export/exportProbe';
import { PerfusionProbe, type PerfusionResult } from '../verify/perfusionProbe';

/** Synthetic radiological contrast modes. */
export type Modality =
  | 'anatomic' | 't1' | 't2' | 'flair' | 'dwi' | 'ct'
  // Perfusion maps: colour rather than intensity, and the basis of the
  // thrombectomy decision rather than of the diagnosis.
  | 'rcbf' | 'tmax' | 'mismatch';

export interface BrainScene {
  scene: Scene;
  camera: ArcRotateCamera;
  field: LoadedField;
  volume: Mesh;
  material: ShaderMaterial;
  derived: DerivedFields;
  operators: OperatorFields;
  picker: Picker;
  ventricles: ExtractedMesh;
  showVentricles: (on: boolean) => void;
  vessels: VesselMesh;
  vesselTree: VesselTree;
  showVessels: (on: boolean) => void;
  /** Synthetic radiological contrast. Not a real pulse sequence — see the shader. */
  setModality: (m: Modality) => void;
  /** Healthy on one side of the divider, diseased on the other. */
  setSplit: (on: boolean, x?: number) => void;
  splitState: () => { on: boolean; x: number };
  currentModality: () => Modality;
  /** Paint a patient's qEEG band power onto the cortex. Null clears it. */
  setEeg: (subject: string | null, band?: EegBand, opacity?: number) => boolean;
  eeg: () => EegProjector | null;
  eegCurrent: () => { subject: string; band: EegBand; opacity: number } | null;
  measureSelection: () => Promise<{
    baselineMm3: number;
    currentMm3: number;
    lossPct: number;
  } | null>;
  captureBaseline: () => Promise<void>;
  /** Clinical visual rating scales derived from measured volume. */
  measureScales: () => Promise<ScaleResult[] | null>;
  /** Centre of mass of a region in world mm, or null if absent in this subject. */
  regionCentroid: (regionIndex: number) => [number, number, number] | null;
  /** ASPECTS for the affected hemisphere; null when no stroke is active. */
  measureAspects: () => Promise<AspectsResult | null>;
  /** Emit ground-truth NIfTI volumes for the current state. */
  exportNifti: (gridDim?: number) => Promise<ExportResult>;
  /** Core / hypoperfusion volumes and DEFUSE-3 eligibility; null with no stroke. */
  measurePerfusion: () => Promise<PerfusionResult | null>;
  setScenario: (id: string | null) => Promise<void>;
  setTime: (t: number) => void;
  play: (on: boolean) => void;
  timeline: () => { scenario: Scenario | null; t: number; playing: boolean; scenarios: Scenario[] };
  setSelection: (regions: Array<{ index: number }>) => void;
  addSelection: (regions: Array<{ index: number }>) => void;
  clearSelection: () => void;
  selectionSize: () => number;
  setClip: (on: boolean, normal?: [number, number, number], offsetMm?: number) => void;
  setCutPlane: (axis: 'sagittal' | 'axial' | 'coronal', offsetMm: number, flip?: boolean) => void;
  setFisheye: (on: boolean, fovRad?: number) => void;
  setLens: (
    on: boolean,
    opts?: { depthMm?: number; mag?: number; radius?: number; follow?: boolean }
  ) => void;
  setSliceView: (axis: 'sagittal' | 'axial' | 'coronal' | null, offsetMm?: number) => void;
  pickAt: (x: number, y: number) => Promise<PickResult>;
  onPick: (fn: (p: PickResult) => void) => void;
  lastPick: () => PickResult | null;
  disease: DiseaseState;
  modifiers: RegionModifiers;
  applyDisease: (patch?: DiseasePatch) => Promise<number>;
  /** 0 = specimen, 1 = x-ray; cross-faded. */
  setMode: (m: number) => void;
  toggleMode: () => void;
  frameMs: () => number;
  quality: () => { tier: number; scale: number; auto: boolean };
  setQuality: (scale: number) => void;
  setAutoQuality: (on: boolean) => void;
}

export async function createBrainScene(
  engine: WebGPUEngine,
  canvas: HTMLCanvasElement,
  subject: string,
  dim: number,
  override?: FieldOverride
): Promise<BrainScene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.035, 0.04, 0.05, 1);

  // Depth is cleared between rendering groups by default, which would let any
  // rasterized mesh draw straight over the raymarched isosurface. See
  // CLAUDE.md gotcha #3 — this is what makes the hybrid pipeline possible.
  for (const group of [1, 2, 3]) {
    scene.setRenderingAutoClearDepthStencil(group, false);
  }

  const field = await loadField(scene, subject, dim, override);
  const half = field.manifest.grid.halfExtentMm;

  // Everything below this line is constructed on the GPU from the ~2 MB
  // payload: a tricubically smoothed 256^3 distance field, plus baked normals
  // and mean curvature.
  const derived = await buildDerived(engine, scene, field);
  const operators = await createOperators(engine, scene, field, derived);

  const camera = new ArcRotateCamera(
    'cam',
    -Math.PI / 2 - 0.6,
    Math.PI / 2.35,
    half * 3.4,
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = half * 1.05;
  camera.upperRadiusLimit = half * 9;
  camera.wheelDeltaPercentage = 0.02;
  camera.minZ = 1;
  camera.maxZ = half * 40;

  // Babylon's default FOV is vertical-fixed, so a portrait viewport narrows the
  // horizontal field and slices the brain off at the sides. Switch to
  // horizontal-fixed whenever the viewport is taller than it is wide.
  const applyFovMode = () => {
    const aspect = engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1);
    camera.fovMode = aspect < 1 ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
  };
  applyFovMode();
  engine.onResizeObservable.add(applyFovMode);

  const material = new ShaderMaterial(
    'brain',
    scene,
    {
      vertexSource: resolveWgsl('render/brain.vertex.wgsl'),
      fragmentSource: resolveWgsl('render/brain.fragment.wgsl'),
    },
    {
      attributes: ['position'],
      uniformBuffers: ['Scene', 'Mesh'],
      uniforms: [
        'uCamPos',
        'uHalfExtent',
        'uRangeMm',
        'uVoxelMm',
        'uDim',
        'uNormDim',
        'uPropDim',
        'uStepScale',
        'uMode',
        'uMaxSteps',
        'uOpDim',
        'uOpActive',
        'uNigraCentre',
        'uNigraRadius',
        'uNigralLoss',
        'uClipNormal',
        'uClipOffset',
        'uClipEnabled',
        'uLabelDim',
        'uSelectPulse',
        'uSelectColor',
        'uSelectLut',
        'uEegLut',
        'uEegOpacity',
        'uModality',
        'uOnsetHours',
        'uSplitMode',
        'uSplitX',
        'uLesionIsBlood',
        'uIctusHours',
        'uSliceOnly',
        'uFisheye',
        'uFisheyeFov',
        'uAspect',
        'uCamRight',
        'uCamUp',
        'uCamFwd',
        'uDepthScale',
        'uLensActive',
        'uLensCentre',
        'uLensRadius',
        'uLensDepth',
        'uLensMag',
        'uTanHalfFov',
        'uStrokeDim',
      ],
      samplers: [
        'sdfTex',
        'normTex',
        'propTex',
        'deformTex',
        'offsetTex',
        'labTex',
        'strokeTex',
      ],
      shaderLanguage: ShaderLanguage.WGSL,
    }
  );
  material.setTexture('sdfTex', field.sdf);
  material.setTexture('normTex', derived.normals);
  material.setTexture('propTex', derived.props);
  material.setTexture('deformTex', operators.deformInv);
  material.setTexture('offsetTex', operators.offset);
  material.setFloat('uOpDim', operators.dim);
  material.setFloat('uOpActive', 0);

  // Substantia nigra placement. There is no aseg label for it, so this is a
  // hand-placed pair of ellipsoids in the midbrain, anchored to the subject's
  // own landmarks rather than to constants. Tagged plausible-approximation.
  const lm = field.manifest.landmarks ?? {};
  material.setVector3(
    'uNigraCentre',
    new Vector3(9, (lm.cerebellumTopMm ?? -2) + 4, (lm.brainstemCentreZMm ?? -10) + 3)
  );
  material.setFloat('uNigraRadius', 7);
  material.setFloat('uNigralLoss', 0);
  material.setTexture('labTex', field.labels);
  material.setTexture('strokeTex', operators.stroke);
  material.setFloat('uStrokeDim', operators.strokeDim);
  material.setVector3('uClipNormal', new Vector3(1, 0, 0));
  material.setFloat('uClipOffset', 0);
  material.setFloat('uClipEnabled', 0);
  material.setFloat('uLabelDim', field.manifest.grid.dim);
  material.setFloat('uSelectPulse', 0);
  material.setColor3('uSelectColor', new Color3(0.25, 0.85, 1.0));
  material.setFloat('uSliceOnly', 0);
  material.setFloat('uFisheye', 0);
  material.setFloat('uFisheyeFov', 2.4);
  material.setFloat('uAspect', 1);
  material.setVector3('uCamRight', new Vector3(1, 0, 0));
  material.setVector3('uCamUp', new Vector3(0, 1, 0));
  material.setVector3('uCamFwd', new Vector3(0, 0, 1));
  material.setFloat('uDepthScale', 1 / (half * 8));
  material.setFloat('uLensActive', 0);
  material.setVector2('uLensCentre', new Vector2(0, 0));
  material.setFloat('uLensRadius', 0.32);
  material.setFloat('uLensDepth', 0);
  material.setFloat('uLensMag', 1.8);
  material.setFloat('uTanHalfFov', Math.tan(camera.fov * 0.5));
  material.setFloat('uHalfExtent', half);
  material.setFloat('uRangeMm', field.manifest.sdf.rangeMm);
  material.setFloat('uVoxelMm', field.manifest.grid.spacingMm);
  material.setFloat('uDim', field.manifest.grid.dim);
  material.setFloat('uNormDim', derived.workDim);
  material.setFloat('uPropDim', derived.propDim);
  material.setFloat('uStepScale', 0.9);
  material.setFloat('uMode', 0);
  material.setFloat('uMaxSteps', 256);
  // Draw both faces so the march survives the camera entering the cube.
  material.backFaceCulling = false;

  const volume = CreateBox('volume', { size: half * 2 }, scene);
  volume.material = material;
  volume.renderingGroupId = 0;

  // Camera basis, pushed every frame. The fisheye builds ray directions from
  // it rather than from the projection matrix, and the ventricle mesh needs the
  // identical basis or the two projections disagree.
  const depthScale = 1 / (half * 8);
  const pushCameraBasis = () => {
    const fwd = camera.getTarget().subtract(camera.position);
    if (fwd.lengthSquared() < 1e-8) fwd.set(0, 0, 1);
    fwd.normalize();
    const worldUp = new Vector3(0, 1, 0);
    let right = Vector3.Cross(worldUp, fwd);
    if (right.lengthSquared() < 1e-8) right = new Vector3(1, 0, 0);
    right.normalize();
    const up = Vector3.Cross(fwd, right).normalize();
    const aspect = engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1);

    for (const m of [material, ventMat]) {
      m.setVector3('uCamRight', right);
      m.setVector3('uCamUp', up);
      m.setVector3('uCamFwd', fwd);
      m.setFloat('uAspect', aspect);
      m.setFloat('uDepthScale', depthScale);
    }
  };

  scene.onBeforeRenderObservable.add(() => {
    material.setVector3('uCamPos', camera.position);
    pushCameraBasis();
  });

  // Art mode: 0 = specimen, 1 = x-ray. Animated rather than switched, because
  // the cross-fade is one of the more watchable things the renderer does.
  let mode = 0;
  let modeTarget = 0;
  scene.onBeforeRenderObservable.add(() => {
    if (Math.abs(mode - modeTarget) > 1e-3) {
      mode += (modeTarget - mode) * Math.min(1, engine.getDeltaTime() / 220);
      material.setFloat('uMode', mode);
    }
  });
  const setMode = (m: number) => {
    modeTarget = Math.max(0, Math.min(1, m));
  };
  const toggleMode = () => setMode(modeTarget > 0.5 ? 0 : 1);

  // ---- the mesh half of the hybrid ---------------------------------------
  const ventricles = await extractIsosurface(
    engine,
    scene,
    'ventricles',
    field.ventricles,
    field.ventricleDim,
    half,
    field.manifest.sdf.rangeMm
  );
  await ventricles.extract(0);

  const ventMat = new ShaderMaterial(
    'ventricles',
    scene,
    {
      vertexSource: resolveWgsl('render/ventricles.vertex.wgsl'),
      fragmentSource: resolveWgsl('render/ventricles.fragment.wgsl'),
    },
    {
      attributes: ['position', 'normal'],
      uniformBuffers: ['Scene', 'Mesh'],
      uniforms: [
        'uHalfExtent',
        'uOpDim',
        'uOpActive',
        'uCamPos',
        'uTint',
        'uOpacity',
        'uFisheye',
        'uFisheyeFov',
        'uAspect',
        'uCamRight',
        'uCamUp',
        'uCamFwd',
        'uDepthScale',
      ],
      samplers: ['fwdTex'],
      shaderLanguage: ShaderLanguage.WGSL,
    }
  );
  ventMat.setTexture('fwdTex', operators.deformFwd);
  ventMat.setFloat('uHalfExtent', half);
  ventMat.setFloat('uOpDim', operators.dim);
  ventMat.setFloat('uOpActive', 0);
  ventMat.setColor3('uTint', new Color3(0.25, 0.62, 0.92));
  ventMat.setFloat('uOpacity', 1);
  ventMat.setFloat('uFisheye', 0);
  ventMat.setFloat('uFisheyeFov', 2.4);
  ventMat.backFaceCulling = false;
  ventricles.mesh.material = ventMat;
  // Group 1: drawn after the raymarch, sharing its depth buffer. Phase 0 gate
  // S5 proved this composites correctly in both directions.
  ventricles.mesh.renderingGroupId = 1;
  ventricles.mesh.setEnabled(false);

  // ---- arterial tree -------------------------------------------------------
  const vesselTree = growVessels(field);
  const vessels = buildVesselMesh(
    scene,
    vesselTree,
    operators.deformFwd,
    half,
    operators.dim
  );
  vessels.mesh.setEnabled(false);
  scene.onBeforeRenderObservable.add(() => {
    vessels.material.setVector3('uCamPos', camera.position);
  });
  const showVessels = (on: boolean) => vessels.mesh.setEnabled(on);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'A') showVessels(!vessels.mesh.isEnabled());
  });

  // ---- selection highlight -------------------------------------------------
  //
  // One float per region index, uploaded as a uniform array rather than another
  // 3D texture: 114 regions is 8 MB of texture for a single scalar, versus
  // 29 vec4s in the existing UBO.
  const selectLut = new Float32Array(256);
  const selected = new Set<number>();

  const pushSelection = () => {
    selectLut.fill(0);
    for (const idx of selected) {
      if (idx >= 0 && idx < 256) selectLut[idx] = 1;
    }
    material.setArray4('uSelectLut', Array.from(selectLut));
  };
  pushSelection();

  // A slow pulse so the highlight reads as interface rather than as a
  // suspiciously luminous piece of anatomy.
  let pulseT = 0;
  scene.onBeforeRenderObservable.add(() => {
    if (selected.size === 0) return;
    pulseT += engine.getDeltaTime() / 1000;
    material.setFloat('uSelectPulse', 0.5 + 0.5 * Math.sin(pulseT * 2.4));
  });

  // ---- qEEG overlay ---------------------------------------------------------
  //
  // Same uniform-array trick as the selection lut, for the same reason. The
  // projector is optional: if the prep scripts have not been run the renderer
  // must still work rather than refuse to start.
  const eegLut = new Float32Array(256);
  let eegProjector: EegProjector | null = null;
  let eegState: { subject: string; band: EegBand; opacity: number } | null = null;
  const eegCurrent = () => eegState;

  material.setArray4('uEegLut', Array.from(eegLut));
  material.setFloat('uEegOpacity', 0);

  // ---- radiological modality ------------------------------------------------
  const MODALITIES = [
    'anatomic', 't1', 't2', 'flair', 'dwi', 'ct', 'rcbf', 'tmax', 'mismatch',
  ] as const;
  let modality: Modality = 'anatomic';
  material.setFloat('uModality', 0);
  material.setFloat('uOnsetHours', 0);

  // ---- split comparison -----------------------------------------------------
  let split = { on: false, x: 0 };
  material.setFloat('uSplitMode', 0);
  material.setFloat('uSplitX', 0);
  material.setFloat('uLesionIsBlood', 0);
  material.setFloat('uIctusHours', 0);

  /**
   * Show the same brain healthy on one side of a divider and diseased on the
   * other. Costs nothing: the operators are switched off per pixel rather than
   * marched twice.
   */
  const setSplit = (on: boolean, x = 0): void => {
    split = { on, x };
    material.setFloat('uSplitMode', on ? 1 : 0);
    material.setFloat('uSplitX', x);
  };

  const setModality = (m: Modality): void => {
    modality = m;
    material.setFloat('uModality', MODALITIES.indexOf(m));
    // Conspicuity is time-dependent, so the shader needs the clock even though
    // the stroke field itself already encodes the lesion.
    material.setFloat('uOnsetHours', disease.stroke.hoursSinceOnset);
    // Blood signal dates the bleed, so the shader needs the ictus clock too.
    material.setFloat('uLesionIsBlood', disease.mass.kind === 'haemorrhage' ? 1 : 0);
    material.setFloat('uIctusHours', disease.mass.hoursSinceIctus);
  };

  // Fire and forget: the qEEG payload is ~160 kB of JSON and nothing on screen
  // depends on it, so blocking first paint for it would be the wrong trade.
  void loadEeg(import.meta.env.BASE_URL, field.regions).then((p) => {
    eegProjector = p;
  });

  const setEeg = (
    patient: string | null,
    band: EegBand = 'alpha',
    opacity = 0.85
  ): boolean => {
    if (!eegProjector || !patient) {
      eegState = null;
      material.setFloat('uEegOpacity', 0);
      return false;
    }
    eegLut.set(eegProjector.project(patient, band));
    material.setArray4('uEegLut', Array.from(eegLut));
    material.setFloat('uEegOpacity', opacity);
    eegState = { subject: patient, band, opacity };
    return true;
  };

  const setSelection = (regions: Array<{ index: number }>) => {
    selected.clear();
    for (const r of regions) selected.add(r.index);
    pushSelection();
  };
  const addSelection = (regions: Array<{ index: number }>) => {
    for (const r of regions) selected.add(r.index);
    pushSelection();
  };
  const clearSelection = () => {
    selected.clear();
    pushSelection();
  };
  const selectionSize = () => selected.size;

  // ---- picking / teaching -------------------------------------------------
  const picker = new Picker(engine, scene, field, derived, operators);
  let lastPick: PickResult | null = null;
  const pickListeners: Array<(p: PickResult) => void> = [];

  const pickAt = async (x: number, y: number): Promise<PickResult> => {
    const p = await picker.pickScreen(x, y);
    lastPick = p;
    // Clicking a region selects it, so identification and highlighting are the
    // same gesture rather than two separate steps.
    if (p.hit && p.region) setSelection([p.region]);
    else clearSelection();
    for (const fn of pickListeners) fn(p);
    return p;
  };

  canvas.addEventListener('pointerdown', (e) => {
    // Left button only, and not while orbiting.
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const onUp = (up: PointerEvent) => {
      canvas.removeEventListener('pointerup', onUp);
      // A drag is a camera move, not a pick.
      if (Math.hypot(up.clientX - startX, up.clientY - startY) > 4) return;
      void pickAt(up.clientX - rect.left, up.clientY - rect.top);
    };
    canvas.addEventListener('pointerup', onUp);
  });

  // ---- disease parameters ------------------------------------------------
  const disease = defaultDiseaseState();
  const modifiers = new RegionModifiers(field.regions);

  /**
   * Re-evaluate the operator stack.
   *
   * Only called when a parameter changes, never per frame: the composed field
   * is what the raymarch reads, and rebuilding it is ~11 dispatches at 64^3.
   */
  const applyDisease = async (patch?: DiseasePatch): Promise<number> => {
    if (patch) {
      if (patch.globalAtrophyMm !== undefined) disease.globalAtrophyMm = patch.globalAtrophyMm;
      if (patch.mass) Object.assign(disease.mass, patch.mass);
      if (patch.neuro) Object.assign(disease.neuro, patch.neuro);
      if (patch.ms) Object.assign(disease.ms, patch.ms);
      if (patch.stroke) Object.assign(disease.stroke, patch.stroke);
    }
    await operators.evaluate(disease, modifiers);
    const active = operators.active ? 1 : 0;
    material.setFloat('uOpActive', active);
    ventMat.setFloat('uOpActive', active);
    vessels.material.setFloat('uOpActive', active);
    material.setFloat('uNigralLoss', disease.neuro.nigralLoss);
    // Modality conspicuity depends on lesion age, so it has to follow the
    // timeline rather than only being set when the modality changes.
    material.setFloat('uOnsetHours', disease.stroke.hoursSinceOnset);
    vessels.setOcclusion(
      disease.stroke.enabled ? disease.stroke.site : null,
      disease.stroke.side
    );
    ventMat.setFloat('uOpActive', operators.active ? 1 : 0);
    return operators.lastEvalMs;
  };

  scene.onBeforeRenderObservable.add(() => {
    ventMat.setVector3('uCamPos', camera.position);
  });

  // ---- timeline ------------------------------------------------------------
  let scenario: Scenario | null = null;
  let timeT = 0;
  let playing = false;

  // Evaluation is async (~2 ms). During playback a naive "evaluate every frame"
  // would queue requests faster than they complete and drift further behind the
  // scrubber the longer it ran. Coalesce instead: keep only the NEWEST pending
  // time, so the field always converges on where the slider actually is.
  let pendingT: number | null = null;
  let evalRunning = false;

  const applyAt = async (t: number) => {
    if (!scenario) return;
    Object.assign(disease, baselineForScenario());
    const patch = scenario.at(t);
    if (patch.globalAtrophyMm !== undefined) disease.globalAtrophyMm = patch.globalAtrophyMm;
    if (patch.neuro) Object.assign(disease.neuro, patch.neuro);
    if (patch.ms) Object.assign(disease.ms, patch.ms);
    if (patch.mass) Object.assign(disease.mass, patch.mass);
    if (patch.stroke) Object.assign(disease.stroke, patch.stroke);
    await applyDisease();
  };

  const requestEval = async (t: number) => {
    pendingT = t;
    if (evalRunning) return;
    evalRunning = true;
    while (pendingT !== null) {
      const target = pendingT;
      pendingT = null;
      await applyAt(target);
    }
    evalRunning = false;
  };

  const setTime = (t: number) => {
    if (!scenario) return;
    timeT = Math.max(0, Math.min(scenario.tMax, t));
    void requestEval(timeT);
  };

  const setScenario = async (id: string | null) => {
    playing = false;
    scenario = id ? (scenarioById(id) ?? null) : null;
    timeT = 0;
    if (!scenario) {
      Object.assign(disease, baselineForScenario());
      await applyDisease();
      return;
    }
    await applyAt(0);
  };

  const play = (on: boolean) => {
    if (!scenario) return;
    if (on && timeT >= scenario.tMax) timeT = 0;
    playing = on;
  };

  scene.onBeforeRenderObservable.add(() => {
    if (!playing || !scenario) return;
    timeT += (engine.getDeltaTime() / 1000) * scenario.playRate;
    if (timeT >= scenario.tMax) {
      timeT = scenario.tMax;
      playing = false;
    }
    void requestEval(timeT);
  });

  const timeline = () => ({
    scenario,
    t: timeT,
    playing,
    scenarios: SCENARIOS,
  });

  // ---- live volume readout -------------------------------------------------
  //
  // Coarser grid than the verification gate (128^3 vs 192^3): this runs on
  // every slider release, and a GPU readback is far heavier than the ~2 ms
  // operator evaluation. The number is therefore slightly less precise than the
  // figure verifyStaging reports, which is the right trade for a live readout.
  const liveVolume = new VolumeProbe(engine, () => scene.render(), field, operators, 128);
  let baselineVolumes: Map<number, number> | null = null;

  /** Volume of the currently selected regions, against the healthy baseline. */
  const measureSelection = async (): Promise<
    { baselineMm3: number; currentMm3: number; lossPct: number } | null
  > => {
    if (selected.size === 0) return null;
    if (!baselineVolumes) return null;

    const labels: number[] = [];
    for (const idx of selected) {
      const r = field.regions[idx];
      if (r) labels.push(r.fsLabel);
    }
    if (labels.length === 0) return null;

    const now = await liveVolume.measure();
    const sum = (m: Map<number, number>) => labels.reduce((a, l) => a + (m.get(l) ?? 0), 0);
    const baselineMm3 = sum(baselineVolumes);
    const currentMm3 = sum(now.byLabel);
    return {
      baselineMm3,
      currentMm3,
      lossPct: baselineMm3 > 0 ? (1 - currentMm3 / baselineMm3) * 100 : 0,
    };
  };

  /**
   * Capture the healthy baseline once, at load, while nothing is applied.
   * Measuring it lazily would mean toggling the disease off mid-session.
   */
  const captureBaseline = async () => {
    baselineVolumes = (await liveVolume.measure()).byLabel;
  };

  // ASPECTS needs its own compute probe and readback, so it is built lazily:
  // most sessions never enable a stroke, and there is no reason to pay for a
  // pipeline and a storage buffer that will not be used.
  // Region centroids, computed lazily from the CPU label copy and cached.
  //
  // One pass over 9 M voxels per structure, which is ~30 ms — fine on demand,
  // wasteful for all 114 up front when a session touches at most a handful.
  const centroidCache = new Map<number, [number, number, number] | null>();
  const regionCentroid = (regionIndex: number): [number, number, number] | null => {
    const hit = centroidCache.get(regionIndex);
    if (hit !== undefined) return hit;

    const gdim = field.manifest.grid.dim;
    const ghalf = field.manifest.grid.halfExtentMm;
    const labels = field.labelBytes;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let iz = 0; iz < gdim; iz++) {
      for (let iy = 0; iy < gdim; iy++) {
        const row = gdim * (iy + gdim * iz);
        for (let ix = 0; ix < gdim; ix++) {
          if (labels[ix + row] !== regionIndex) continue;
          n++;
          sx += ix;
          sy += iy;
          sz += iz;
        }
      }
    }
    const toMm = (i: number) => ((i / n + 0.5) / gdim) * 2 * ghalf - ghalf;
    const out: [number, number, number] | null =
      n > 0 ? [toMm(sx), toMm(sy), toMm(sz)] : null;
    centroidCache.set(regionIndex, out);
    return out;
  };

  let aspectsProbe: AspectsProbe | null = null;
  let perfusionProbe: PerfusionProbe | null = null;
  const measurePerfusion = async (): Promise<PerfusionResult | null> => {
    if (!disease.stroke.enabled) return null;
    perfusionProbe ??= new PerfusionProbe(engine, () => scene.render(), field, operators);
    return perfusionProbe.measure();
  };
  // Both probes are built on first use: their storage buffers are tens of
  // megabytes and most sessions never touch either.
  let exportProbeScene: ExportProbe | null = null;
  const exportNifti = async (gridDim = 128): Promise<ExportResult> => {
    exportProbeScene ??= new ExportProbe(
      engine, () => scene.render(), field, operators, derived);
    return exportProbeScene.run(gridDim, { download: true });
  };
  const measureAspects = async (): Promise<AspectsResult | null> => {
    if (!disease.stroke.enabled) return null;
    aspectsProbe ??= new AspectsProbe(engine, () => scene.render(), field, operators);
    const side = disease.stroke.lesions?.length
      ? disease.stroke.lesions[0].side
      : disease.stroke.side;
    return aspectsProbe.measure(side);
  };

  /**
   * Clinical visual rating scales, derived from measured volume.
   *
   * Shares the live volume probe rather than adding another readback: this is
   * the same integration the volume readout already performs, so asking for
   * scales costs one measure() and some arithmetic.
   */
  const measureScales = async (): Promise<ScaleResult[] | null> => {
    if (!baselineVolumes) return null;
    const now = (await liveVolume.measure()).byLabel;

    const hipNow = hippocampalVolume(now);
    const hipBase = hippocampalVolume(baselineVolumes);
    const parNow = parenchymalVolume(now, field.regions);
    const parBase = parenchymalVolume(baselineVolumes, field.regions);

    return [
      mtaScale(hipBase > 0 ? (1 - hipNow / hipBase) * 100 : 0),
      gcaScale(parBase > 0 ? (1 - parNow / parBase) * 100 : 0),
      fazekasScale(disease.ms.enabled ? disease.ms.load : 0),
    ];
  };

  const showVentricles = (on: boolean) => ventricles.mesh.setEnabled(on);

  /**
   * Cutaway plane.
   *
   * Keeps the half-space where dot(normal, p) < offset. Costs essentially
   * nothing: the raymarch simply starts the ray at the plane instead of the
   * bounding box, so everything in front is never sampled. The picker is kept
   * in step so clicking a cross-section names the tissue actually visible.
   */
  const clip = { enabled: false, normal: [1, 0, 0] as [number, number, number], offsetMm: 0 };
  const setClip = (
    on: boolean,
    normal?: [number, number, number],
    offsetMm?: number
  ) => {
    clip.enabled = on;
    if (normal) clip.normal = normal;
    if (offsetMm !== undefined) clip.offsetMm = offsetMm;
    const n = new Vector3(...clip.normal);
    if (n.length() < 1e-6) n.set(1, 0, 0);
    n.normalize();
    material.setVector3('uClipNormal', n);
    material.setFloat('uClipOffset', clip.offsetMm);
    material.setFloat('uClipEnabled', clip.enabled ? 1 : 0);
    picker.clip = { enabled: clip.enabled, normal: [n.x, n.y, n.z], offsetMm: clip.offsetMm };
  };

  /** Radiological cut orientations. */
  const CUT_AXES: Record<string, [number, number, number]> = {
    sagittal: [1, 0, 0], // cuts left/right
    axial: [0, 1, 0], // cuts superior/inferior
    coronal: [0, 0, 1], // cuts anterior/posterior
  };
  const setCutPlane = (axis: keyof typeof CUT_AXES, offsetMm: number, flip = false) => {
    const n = CUT_AXES[axis];
    setClip(true, flip ? [-n[0], -n[1], -n[2]] : n, flip ? -offsetMm : offsetMm);
  };

  /**
   * Fisheye / wide-angle projection.
   *
   * The volume mesh is scaled up when this is on. That box is only a surface to
   * generate fragments on — the march gets its bounds from uHalfExtent, not from
   * the mesh — so enlarging it widens the screen area rays are cast over without
   * touching the field. Without it, fisheye rays that should leave the box's
   * ordinary perspective footprint would simply never be shaded.
   */
  /**
   * Magic lens: a circular region that magnifies and digs into the tissue.
   *
   * The penetration is the point. A wide-angle projection changes how much you
   * can see from a point; it does not remove what is in the way. Eroding the
   * distance field locally does — the cortex retreats inside the lens and the
   * white matter, deep nuclei and the ventricle mesh underneath become visible,
   * with the mesh keeping its true depth so it composites correctly.
   */
  const lensState = { active: false, depthMm: 18, mag: 1.8, radius: 0.32, follow: true };
  const setLens = (
    on: boolean,
    opts: { depthMm?: number; mag?: number; radius?: number; follow?: boolean } = {}
  ) => {
    lensState.active = on;
    if (opts.depthMm !== undefined) lensState.depthMm = opts.depthMm;
    if (opts.mag !== undefined) lensState.mag = opts.mag;
    if (opts.radius !== undefined) lensState.radius = opts.radius;
    if (opts.follow !== undefined) lensState.follow = opts.follow;
    material.setFloat('uLensActive', on ? 1 : 0);
    material.setFloat('uLensDepth', on ? lensState.depthMm : 0);
    material.setFloat('uLensMag', lensState.mag);
    material.setFloat('uLensRadius', lensState.radius);
  };

  // The lens follows the cursor. NDC, so it is independent of the render scale
  // the quality ladder happens to be using.
  canvas.addEventListener('pointermove', (e) => {
    if (!lensState.active || !lensState.follow) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    material.setVector2('uLensCentre', new Vector2(x, y));
  });

  const setFisheye = (on: boolean, fovRad = 2.4) => {
    volume.scaling.setAll(on ? 4 : 1);
    for (const m of [material, ventMat]) {
      m.setFloat('uFisheye', on ? 1 : 0);
      m.setFloat('uFisheyeFov', fovRad);
    }
  };

  /**
   * Radiological slice view: orthographic camera looking straight down the cut
   * normal, with the ray discarded wherever the plane misses tissue. That
   * combination turns the existing cutaway into a flat cross-section without
   * any new rendering path.
   */
  const setSliceView = (
    axis: 'sagittal' | 'axial' | 'coronal' | null,
    offsetMm = 0
  ) => {
    material.setFloat('uSliceOnly', axis !== null ? 1 : 0);
    if (axis === null) {
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      setClip(false);
      return;
    }
    setFisheye(false);
    setCutPlane(axis, offsetMm);

    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const h = half * 1.05;
    const aspect = engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1);
    camera.orthoTop = h;
    camera.orthoBottom = -h;
    camera.orthoLeft = -h * aspect;
    camera.orthoRight = h * aspect;

    // Look along the cut normal, from the kept side.
    if (axis === 'sagittal') {
      camera.alpha = 0;
      camera.beta = Math.PI / 2;
    } else if (axis === 'axial') {
      camera.alpha = -Math.PI / 2;
      camera.beta = 0.0001;
    } else {
      camera.alpha = Math.PI / 2;
      camera.beta = Math.PI / 2;
    }
    camera.radius = half * 4;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'v' || e.key === 'V') {
      showVentricles(!ventricles.mesh.isEnabled());
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'x' || e.key === 'X') toggleMode();
  });

  const samples: number[] = [];
  scene.onAfterRenderObservable.add(() => {
    samples.push(engine.getDeltaTime());
    if (samples.length > 30) samples.shift();
  });
  const frameMs = () => {
    if (samples.length === 0) return 0;
    const s = [...samples].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  // Adaptive resolution ladder.
  //
  // The march is bandwidth-bound, so cost scales with pixel count and the only
  // dial that moves the needle by an order of magnitude is render resolution.
  // Babylon's hardware scaling level is a divisor: 2.0 renders at half linear
  // resolution (a quarter of the pixels) and upscales on present.
  //
  // Deliberately conservative about scaling back UP: oscillating between tiers
  // is more distracting than sitting one tier low, so we need a sustained run
  // of comfortable frames before improving quality.
  const LADDER = [1.0, 1.4, 2.0, 2.8, 4.0];
  let tier = 1;
  let good = 0;
  // Manual control switches the ladder off. Without this the ladder overrides
  // any explicit setQuality on the very next frame, and because each override
  // calls setHardwareScalingLevel — which reallocates the swapchain — the two
  // fight and produce ~1 s stalls that look exactly like a shader performance
  // collapse. Measured frame times were non-monotonic in pixel count before
  // this flag existed, which is what gave it away.
  let auto = true;
  engine.setHardwareScalingLevel(LADDER[tier]);

  const tuneQuality = () => {
    if (!auto || samples.length < 20) return;
    const ms = frameMs();
    if (ms > 26 && tier < LADDER.length - 1) {
      tier++;
      engine.setHardwareScalingLevel(LADDER[tier]);
      samples.length = 0;
      good = 0;
    } else if (ms < 12) {
      good++;
      if (good > 90 && tier > 0) {
        tier--;
        engine.setHardwareScalingLevel(LADDER[tier]);
        samples.length = 0;
        good = 0;
      }
    } else {
      good = 0;
    }
  };
  scene.onAfterRenderObservable.add(tuneQuality);

  return {
    scene,
    camera,
    field,
    derived,
    operators,
    picker,
    ventricles,
    showVentricles,
    vessels,
    vesselTree,
    showVessels,
    measureSelection,
    captureBaseline,
    regionCentroid,
    measureScales,
    measureAspects,
    measurePerfusion,
    exportNifti,
    setScenario,
    setTime,
    play,
    timeline,
    setSelection,
    addSelection,
    clearSelection,
    selectionSize,
    setClip,
    setCutPlane,
    setFisheye,
    setLens,
    setSliceView,
    pickAt,
    onPick: (fn) => pickListeners.push(fn),
    lastPick: () => lastPick,
    disease,
    modifiers,
    applyDisease,
    setModality,
    currentModality: () => modality,
    setSplit,
    splitState: () => split,
    setEeg,
    eeg: () => eegProjector,
    eegCurrent,
    volume,
    material,
    setMode,
    toggleMode,
    frameMs,
    quality: () => ({ tier, scale: engine.getHardwareScalingLevel(), auto }),
    /** Pin the render scale and stop the automatic ladder. */
    setQuality: (scale: number) => {
      auto = false;
      const i = LADDER.indexOf(scale);
      if (i >= 0) tier = i;
      engine.setHardwareScalingLevel(scale);
      samples.length = 0;
    },
    setAutoQuality: (on: boolean) => {
      auto = on;
      samples.length = 0;
    },
  };
}
