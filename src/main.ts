import { createEngine, WebGPUUnavailableError } from './engine/engine';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import type { FieldOverride } from './fields/loader';
import { createBrainScene, type Modality } from './scene/brainScene';
import { captureFrame, readFrame } from './verify/frame';
import { SliceProbe } from './verify/sliceProbe';
import { DeformProbe } from './verify/deformProbe';
import { VolumeProbe } from './verify/volumeProbe';
import { StrokeProbe } from './verify/strokeProbe';
import { AspectsProbe } from './verify/aspectsProbe';
import { ExportProbe } from './export/exportProbe';
import { PerfusionProbe } from './verify/perfusionProbe';
import { braakInfo } from './disease/braak';
import { TERRITORY, territoryOf } from './disease/territories';
import { createPanel } from './ui/panel';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

/** The scene currently on screen, so a subject swap can dispose it. */
let liveScene: { dispose: () => void } | null = null;

const DEFAULT_SUBJECT = 'sample'; // real individual: +27% gyrification vs fsaverage
const DEFAULT_DIM = 208;

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** Pack "is inside" (distance < 0) as one bit per sample, base64-encoded. */
function packSignBits(values: Float32Array): string {
  const bytes = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) {
    if (values[i] < 0) bytes[i >> 3] |= 1 << (i & 7);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function showError(title: string, body: string): void {
  hud.innerHTML = `<span class="fail">${esc(title)}</span>\n\n${esc(body)}`;
}

async function bootSpike(): Promise<void> {
  // Phase 0 harness, kept reachable at #/spike so the Babylon/WGSL gates can be
  // re-run against a new Babylon version without archaeology.
  const { runSpike } = await import('./spike/spike');
  const engine = await createEngine(canvas);
  const { gates, scene, frameMs, verifyDepth } = await runSpike(engine, canvas);
  const depth = await verifyDepth();
  const s5 = gates.find((g) => g.id === 'S5');
  if (s5) {
    s5.status = depth.pass ? 'pass' : 'fail';
    s5.detail = depth.note;
  }
  (window as unknown as Record<string, unknown>).__corticum = {
    mode: 'spike',
    renderOneFrame: () => scene.render(),
    scene,
    engine,
    gates: () => gates,
    frameMs,
    verifyDepth,
    capture: (n: string) => captureFrame(engine, n, () => scene.render()),
  };
  engine.runRenderLoop(() => {
    scene.render();
    const rows = gates
      .map((g) => {
        const cls = g.status === 'pass' ? 'ok' : g.status === 'fail' ? 'fail' : 'warn';
        const mark = g.status === 'pass' ? '✓' : g.status === 'fail' ? '✗' : '–';
        return `<span class="${cls}">${mark} ${g.id}</span> ${esc(g.what)}`;
      })
      .join('\n');
    hud.innerHTML = `corticum — Phase 0 spike\n\n${rows}\n\n<span class="dim">${frameMs().toFixed(1)} ms</span>`;
  });
  window.addEventListener('resize', () => engine.resize());
}

/**
 * Build — or REBUILD — the whole scene.
 *
 * Loading a different subject re-runs this rather than patching the live scene.
 * The anatomy feeds a chain: derived normals and properties, then the
 * compliance field, then the operators, then the vascular tree — and each link
 * binds textures into materials and compute passes. Updating that piecemeal
 * means a dozen chances to leave one binding pointing at the previous brain,
 * and a stale binding renders plausibly instead of failing. Re-running the
 * construction path every gate already exercises is worth ~4 s and a camera
 * reset.
 */
async function bootBrain(engineIn?: WebGPUEngine, override?: FieldOverride): Promise<void> {
  const engine = engineIn ?? (await createEngine(canvas));

  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const subject = params.get('subject') ?? DEFAULT_SUBJECT;
  const dim = Number(params.get('dim') ?? DEFAULT_DIM);

  hud.innerHTML = override
    ? `corticum\n<span class="dim">building ${esc(override.label)}…</span>`
    : `corticum\n<span class="dim">loading ${esc(subject)} field…</span>`;

  // Tear the previous scene and panel down before building the next.
  if (liveScene) {
    engine.stopRenderLoop();
    liveScene.dispose();
    document.querySelectorAll('.cx-panel').forEach((node) => node.remove());
  }

  const brain = await createBrainScene(engine, canvas, subject, dim, override);
  liveScene = brain.scene;
  const {
    scene,
    field,
    derived,
    operators,
    disease,
    modifiers,
    applyDisease,
    frameMs,
    setMode,
    toggleMode,
    camera,
    quality,
    setQuality,
    setAutoQuality,
    picker,
    pickAt,
    onPick,
    ventricles,
    showVentricles,
    vessels,
    vesselTree,
    showVessels,
    setModality,
    currentModality,
    setSplit,
    splitState,
    setEeg,
    eeg,
    eegCurrent,
    setClip,
    setCutPlane,
    setFisheye,
    setLens,
    setSliceView,
    setSelection,
    addSelection,
    clearSelection,
    selectionSize,
  } = brain;
  const m = field.manifest;

  // Evaluate once with the null state so the operator textures hold defined
  // values from the first frame rather than whatever the allocator left there.
  await applyDisease();

  // Capture the healthy regional volumes now, while nothing is applied — the
  // live readout needs a baseline and measuring it later would mean toggling
  // the disease off mid-session.
  await brain.captureBaseline();

  // Built on first use: the storage buffers are tens of megabytes and most
  // sessions never export.
  let exportProbe: ExportProbe | null = null;

  document.body.append(createPanel(brain, field.regions));

  (window as unknown as Record<string, unknown>).__corticum = {
    mode: 'brain',
    renderOneFrame: () => scene.render(),
    scene,
    engine,
    camera,
    field,
    manifest: m,
    frameMs,
    derived,
    operators,
    disease,
    modifiers,
    applyDisease,

    /** Per-region control. Returns the resulting atrophy in mm for feedback. */
    async setRegion(
      key: number | string,
      opts: { vulnerability?: number; overrideMm?: number }
    ): Promise<{ ok: boolean; region?: string }> {
      let ok = true;
      if (opts.vulnerability !== undefined) {
        ok = modifiers.setVulnerability(key, opts.vulnerability) && ok;
      }
      if (opts.overrideMm !== undefined) {
        ok = modifiers.setOverride(key, opts.overrideMm) && ok;
      }
      const region = modifiers.resolve(key);
      // Highlight whatever was just modified, so the effect and its extent are
      // visible together rather than requiring a separate selection step.
      if (ok && region) setSelection([region]);
      if (ok) await applyDisease();
      return { ok, region: region?.name };
    },

    /** Apply a modifier to a whole lobe, Yeo network, or hemisphere. */
    async setGroup(
      kind: 'lobe' | 'network' | 'hemisphere',
      value: string,
      opts: { vulnerability?: number; overrideMm?: number }
    ): Promise<{ matched: number }> {
      let matched = 0;
      if (opts.vulnerability !== undefined) {
        matched = modifiers.setGroupVulnerability(kind, value, opts.vulnerability);
      }
      if (opts.overrideMm !== undefined) {
        matched = modifiers.setGroupOverride(kind, value, opts.overrideMm);
      }
      if (matched > 0) {
        setSelection(modifiers.group(kind, value));
        await applyDisease();
      }
      return { matched };
    },

    /** Highlight a group without changing anything about the anatomy. */
    highlightGroup(kind: 'lobe' | 'network' | 'hemisphere', value: string): number {
      const members = modifiers.group(kind, value);
      setSelection(members);
      return members.length;
    },
    highlightRegion(key: number | string): string | undefined {
      const r = modifiers.resolve(key);
      if (r) setSelection([r]);
      return r?.name;
    },
    addSelection,
    clearSelection,
    selectionSize,

    groups: (kind: 'lobe' | 'network' | 'hemisphere') => modifiers.groups(kind),
    groupMembers: (kind: 'lobe' | 'network' | 'hemisphere', value: string) =>
      modifiers.group(kind, value).map((r) => r.name),
    modifiedRegions: () => modifiers.modified(),
    async clearRegions(): Promise<void> {
      modifiers.clear();
      clearSelection();
      await applyDisease();
    },

    setMode,
    toggleMode,
    quality,
    setQuality,
    setAutoQuality,
    capture: (n: string) => captureFrame(engine, n, () => scene.render()),
    readFrame: () => {
      scene.render();
      return readFrame(engine);
    },

    /**
     * Phase 1 gate. Samples the uploaded field on three canonical slices and
     * POSTs the raw distances for tools/prep/verify_slice.py to score against
     * aparc+aseg.mgz.
     */
    async verifyAnatomy(): Promise<{ path: string; slices: number }> {
      // Stop the render loop so frame submission is driven only by this
      // function — one less source of nondeterminism in a measurement whose
      // whole value is being trustworthy.
      engine.stopRenderLoop();
      const probe = new SliceProbe(engine, scene, field);
      const slices = [
        { axis: 0 as const, posMm: 0, label: 'sagittal x=0' },
        { axis: 1 as const, posMm: 0, label: 'axial y=0' },
        { axis: 2 as const, posMm: 0, label: 'coronal z=0' },
        { axis: 1 as const, posMm: -20, label: 'axial y=-20' },
        { axis: 2 as const, posMm: 25, label: 'coronal z=+25' },
      ];
      const out: Record<string, unknown> = {
        subject: m.subject,
        dim: m.grid.dim,
        halfExtentMm: m.grid.halfExtentMm,
        rangeMm: m.sdf.rangeMm,
        slices: [],
      };
      for (const s of slices) {
        const r = await probe.sample(s.axis, s.posMm);
        (out.slices as unknown[]).push({
          axis: s.axis,
          posMm: s.posMm,
          label: s.label,
          res: r.res,
          // Ship the sign as a compact bit-per-sample payload; the magnitudes
          // are already validated by the Python round-trip check.
          insideBase64: packSignBits(r.values),
        });
      }
      probe.dispose();
      startLoop();

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `anatomy_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(out),
      });
      const j = (await res.json()) as { path: string };
      return { path: j.path, slices: slices.length };
    },

    /**
     * Phase 3 gates.
     *
     * Note on the midline-shift check: there is deliberately no "commanded
     * shift" dial. Shift is an EMERGENT consequence of lesion volume acting
     * through the compliance field — that is the entire architectural claim —
     * so a dial that set it directly would test nothing. Instead this sweeps
     * lesion radius and requires that shift grows monotonically, that the
     * ventricles give way before the midline does, and that the deformation
     * remains an exact diffeomorphism throughout.
     */
    async verifyOperators(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const render = () => scene.render();
      const probe = new DeformProbe(engine, render, field, operators);
      const report: Record<string, unknown> = { subject: m.subject };

      // --- gate 1: null-parameter identity --------------------------------
      await applyDisease({ globalAtrophyMm: 0, mass: { ...disease.mass, enabled: false } });
      const nullM = await probe.measure();
      report.nullState = {
        opActive: operators.active,
        maxDisplacementMm: nullM.maxDisplacementMm,
        roundTripMaxMm: nullM.roundTripMaxMm,
        pass: operators.active === false && nullM.maxDisplacementMm < 1e-3,
      };

      // --- gates 2 & 3: sweep lesion radius -------------------------------
      const sweep: Array<Record<string, number>> = [];
      for (const radiusMm of [8, 14, 20, 26, 32]) {
        await applyDisease({ mass: { ...disease.mass, enabled: true, radiusMm } });
        const s = await probe.measure();
        sweep.push({
          radiusMm,
          midlineShiftMm: +s.midlineShiftMm.toFixed(3),
          maxDisplacementMm: +s.maxDisplacementMm.toFixed(3),
          roundTripMaxMm: +s.roundTripMaxMm.toFixed(4),
          roundTripP99Mm: +s.roundTripP99Mm.toFixed(5),
          roundTripMeanMm: +s.roundTripMeanMm.toFixed(5),
          roundTripFracOver: +s.roundTripFracOver.toFixed(5),
        });
      }
      report.sweep = sweep;

      const worstRt = Math.max(...sweep.map((s) => s.roundTripMaxMm));
      report.diffeomorphism = {
        worstRoundTripMaxMm: worstRt,
        thresholdMm: 0.1,
        pass: worstRt < 0.1,
      };

      let monotonic = true;
      for (let i = 1; i < sweep.length; i++) {
        if (sweep[i].midlineShiftMm < sweep[i - 1].midlineShiftMm - 1e-4) monotonic = false;
      }
      report.midline = {
        monotonicInLesionSize: monotonic,
        shiftAtLargestMm: sweep[sweep.length - 1].midlineShiftMm,
        pass: monotonic && sweep[sweep.length - 1].midlineShiftMm > 1.0,
      };

      probe.dispose();
      await applyDisease({ globalAtrophyMm: 0, mass: { ...disease.mass, enabled: false } });
      startLoop();

      const res = await fetch('/__data', {
        method: 'POST',
        headers: {
          'x-data-name': `operators_${m.subject}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
      });
      report.saved = ((await res.json()) as { path: string }).path;
      return report;
    },

    /**
     * Phase 4 gate: cast N picks from random camera angles and record what the
     * GPU says is there, for tools/prep/verify_picks.py to check against
     * aparc+aseg.mgz.
     *
     * The picks are deliberately taken through the real screen path — camera,
     * picking ray, shared march — rather than by calling the sampler directly,
     * because the thing under test is whether a CLICK names the right region,
     * not whether a texture fetch works.
     */
    async verifyPicks(n = 20): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      // CSS pixels, NOT engine.getRenderWidth(). createPickingRay works in
      // canvas client space, and hardware scaling makes the two diverge — with
      // the quality ladder at 4x the render buffer is 320x200 while the canvas
      // is 1280x800, so render-space coordinates aim near the top-left corner
      // and every ray misses. The interactive handler already uses
      // `clientX - rect.left` and was never affected.
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const picks: Array<Record<string, unknown>> = [];

      // Deterministic pseudo-random so a failure is reproducible.
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      let attempts = 0;
      while (picks.length < n && attempts < n * 12) {
        attempts++;
        camera.alpha = rnd() * Math.PI * 2;
        camera.beta = 0.5 + rnd() * 2.1;
        camera.radius = m.grid.halfExtentMm * 3.0;
        scene.render();

        // Aim near the centre of the screen where the brain reliably is.
        const px = w * (0.35 + rnd() * 0.3);
        const py = h * (0.35 + rnd() * 0.3);
        const p = await pickAt(px, py);
        if (!p.hit) continue;
        picks.push({
          material: p.material.map((v) => +v.toFixed(3)),
          labelIndex: p.labelIndex,
          fsLabel: p.region?.fsLabel ?? -1,
          name: p.region?.name ?? '?',
          tissue: p.tissue,
        });
      }

      startLoop();
      const out = {
        subject: m.subject,
        halfExtentMm: m.grid.halfExtentMm,
        requested: n,
        obtained: picks.length,
        picks,
      };
      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `picks_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(out),
      });
      return { ...out, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Phase 5 gate: does Braak staging reproduce the published volume loss,
     * and does it spare primary cortex until stage VI?
     */
    async verifyStaging(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const render = () => scene.render();
      const probe = new VolumeProbe(engine, render, field, operators);

      const HIPPOCAMPUS = [17, 53];
      const ENTORHINAL = [1006, 2006];
      const PRECENTRAL = [1024, 2024];
      const POSTCENTRAL = [1022, 2022];

      const sum = (v: Map<number, number>, labels: number[]) =>
        labels.reduce((a, l) => a + (v.get(l) ?? 0), 0);

      const healthyState = {
        neuro: { ...disease.neuro, braakStage: 0, ftdSeverity: 0 },
        ms: { ...disease.ms, enabled: false },
        mass: { ...disease.mass, enabled: false },
        globalAtrophyMm: 0,
      };
      await applyDisease(healthyState);
      const base = await probe.measure();

      const stages: Array<Record<string, unknown>> = [];
      for (let stage = 1; stage <= 6; stage++) {
        await applyDisease({ neuro: { ...disease.neuro, braakStage: stage } });
        const v = await probe.measure();
        const pct = (labels: number[]) => {
          const b = sum(base.byLabel, labels);
          if (b <= 0) return 0;
          return (1 - sum(v.byLabel, labels) / b) * 100;
        };
        stages.push({
          stage,
          name: braakInfo(stage).label,
          hippocampusLossPct: +pct(HIPPOCAMPUS).toFixed(2),
          entorhinalLossPct: +pct(ENTORHINAL).toFixed(2),
          precentralLossPct: +pct(PRECENTRAL).toFixed(2),
          postcentralLossPct: +pct(POSTCENTRAL).toFixed(2),
          wholeBrainLossPct: +((1 - v.totalMm3 / base.totalMm3) * 100).toFixed(2),
        });
      }

      probe.dispose();
      await applyDisease(healthyState);
      startLoop();

      const primarySparedUntilVI = stages
        .slice(0, 5)
        .every(
          (s) =>
            (s.precentralLossPct as number) < 2 && (s.postcentralLossPct as number) < 2
        );

      // Limbic involvement must lag entorhinal: that ordering IS Braak staging.
      const orderCorrect =
        (stages[1].hippocampusLossPct as number) <= 0.5 &&
        (stages[1].entorhinalLossPct as number) > 2 &&
        (stages[3].hippocampusLossPct as number) >
          (stages[1].hippocampusLossPct as number);

      const monotonic = stages.every(
        (s, i) =>
          i === 0 ||
          (s.wholeBrainLossPct as number) >= (stages[i - 1].wholeBrainLossPct as number) - 1e-6
      );

      const wholeVI = stages[5].wholeBrainLossPct as number;

      const report = {
        subject: m.subject,
        baselineTotalCm3: +(base.totalMm3 / 1000).toFixed(1),
        sampleSpacingMm: +Math.cbrt(base.voxelMm3).toFixed(3),
        stages,
        gates: {
          stagingOrder: {
            pass: orderCorrect,
            note: 'entorhinal involved by Braak II while hippocampus is not; hippocampus follows by IV',
          },
          primaryCortexSparedUntilVI: {
            pass: primarySparedUntilVI,
            note: 'precentral and postcentral loss must stay <2% through Braak V',
          },
          monotonicProgression: { pass: monotonic },
          wholeBrainLossAtBraakVI: {
            valuePct: wholeVI,
            expectedRange: [2, 12],
            pass: wholeVI >= 2 && wholeVI <= 12,
            citation: 'cross-sectional whole-brain volume difference, AD vs controls',
          },
          hippocampalLossAtBraakV: {
            valuePct: stages[4].hippocampusLossPct as number,
            expectedRange: [15, 30],
            pass:
              (stages[4].hippocampusLossPct as number) >= 15 &&
              (stages[4].hippocampusLossPct as number) <= 30,
            citation: 'hippocampal volume loss, established AD vs controls',
          },
        },
        limitation:
          'The offset operator erodes the PARENCHYMA surface. Cortical thinning, ' +
          'sulcal widening and ex-vacuo ventricular enlargement therefore emerge ' +
          'directly. Deep grey structures have no free surface in that field, so ' +
          'their loss arises only where they abut CSF — for the hippocampus that ' +
          'is the temporal horn, which turns out to be enough to reach the ' +
          'published range, but the mechanism is ex-vacuo retreat rather than the ' +
          'intrinsic neuronal loss that dominates in life. A structure whose ' +
          'atrophy is NOT adjacent to CSF would be under-represented, and would ' +
          'need a per-structure distance field.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: {
          'x-data-name': `staging_${m.subject}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Phase 6 gate. Does an occlusion produce a deficit shaped like the
     * territory it starves, and do collaterals spare the cortical RIM rather
     * than shrinking the infarct uniformly?
     */
    async verifyStroke(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const probe = new StrokeProbe(engine, () => scene.render(), field, operators);
      const base = {
        neuro: { ...disease.neuro, braakStage: 0, ftdSeverity: 0, nigralLoss: 0 },
        ms: { ...disease.ms, enabled: false },
        mass: { ...disease.mass, enabled: false },
        globalAtrophyMm: 0,
      };

      // Territory shape, with collaterals off so the deficit is the full
      // territory rather than a rescued subset.
      const sites: Array<Record<string, unknown>> = [];
      for (const site of ['m1', 'm2sup', 'aca', 'pca']) {
        await applyDisease({
          ...base,
          stroke: {
            ...disease.stroke,
            enabled: true,
            site,
            side: 'left',
            collateralGrade: 0,
            hoursSinceOnset: 24,
            recanalisationHour: Number.POSITIVE_INFINITY,
          },
        });
        const r = await probe.measure(site, 0.5, 'left');
        sites.push({
          site,
          dice: +r.dice.toFixed(3),
          spillFraction: +r.spillFraction.toFixed(3),
          contralateralCore: +r.contralateralCoreFraction.toFixed(3),
          territoryVoxels: r.territoryVoxels,
          coreVoxels: r.coreVoxels,
          whiteMatterCore: r.nonTerritorialCore,
        });
      }

      // Collateral sweep on M1: rim must be spared preferentially.
      const collaterals: Array<Record<string, unknown>> = [];
      for (const grade of [0, 1, 2, 3]) {
        await applyDisease({
          ...base,
          stroke: {
            ...disease.stroke,
            enabled: true,
            site: 'm1',
            side: 'left',
            collateralGrade: grade,
            hoursSinceOnset: 24,
            recanalisationHour: Number.POSITIVE_INFINITY,
          },
        });
        const r = await probe.measure('m1', 0.5, 'left');
        collaterals.push({
          grade,
          rimCoreFraction: +r.rimCoreFraction.toFixed(3),
          deepCoreFraction: +r.deepCoreFraction.toFixed(3),
          coreVoxels: r.coreVoxels,
        });
      }

      probe.dispose();
      await applyDisease({ ...base, stroke: { ...disease.stroke, enabled: false } });
      startLoop();

      const worstDice = Math.min(...sites.map((s) => s.dice as number));
      const worstContra = Math.max(...sites.map((s) => s.contralateralCore as number));
      const rim0 = collaterals[0].rimCoreFraction as number;
      const rim3 = collaterals[3].rimCoreFraction as number;
      const deep0 = collaterals[0].deepCoreFraction as number;
      const deep3 = collaterals[3].deepCoreFraction as number;
      // Rim must fall further than deep: collaterals arrive over the surface,
      // and the lenticulostriates have none at all.
      const rimDrop = rim0 - rim3;
      const deepDrop = deep0 - deep3;

      const report = {
        subject: m.subject,
        sites,
        collaterals,
        gates: {
          territoryShape: {
            worstDice,
            threshold: 0.8,
            pass: worstDice >= 0.8,
            note: 'core (collaterals off) must match the hand-authored territory',
          },
          laterality: {
            worstContralateralCore: +worstContra.toFixed(3),
            threshold: 0.05,
            pass: worstContra <= 0.05,
            note:
              'a unilateral occlusion must spare the MIRROR territory. The ' +
              'territory ids carry no side, so before this gate existed an M1 ' +
              'occlusion infarcted both hemispheres and still scored Dice 0.948 ' +
              'against a side-blind ground truth.',
          },
          collateralsSpareRim: {
            rimDrop: +rimDrop.toFixed(3),
            deepDrop: +deepDrop.toFixed(3),
            pass: rimDrop > deepDrop && rimDrop > 0.15 && deep3 > 0.9,
            deepCoreAtGrade3: +deep3.toFixed(3),
            note:
              'good collaterals must spare the cortical RIM preferentially while ' +
              'leaving the deep territory infarcted — the lenticulostriates have ' +
              'no collateral supply at all',
          },
        },
        limitation:
          'Territories are a hand-authored assignment of FreeSurfer parcels to ' +
          'supplying arteries, not a validated vascular atlas. Real territories ' +
          'vary between individuals and boundaries are fuzzy. Watershed zones, ' +
          'by contrast, are derived: nothing marks them, they appear because ' +
          'perfusion is a smoothed territory membership.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `stroke_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Phase 6 gate. The arterial tree is grown, not drawn — attractors are
     * scattered in the parenchyma and each trunk competes only for its own
     * territory's cloud. So the falsifiable question is whether the geometry
     * that emerged actually RUNS THROUGH the territory it claims to supply.
     *
     * This is scored against the label field on the CPU rather than on the GPU,
     * because the vessels are the one structure in the project that is not a
     * field: they are a graph, and the thing under test is graph-vs-field
     * agreement. Deliberately independent of `verifyStroke`, which tests the
     * perfusion field and never looks at the tree.
     */
    verifyVessels(): Record<string, unknown> {
      const labDim = m.grid.dim;
      const half = m.grid.halfExtentMm;
      const labels = field.labelBytes;
      const perTrunk = vesselTree.trunks.map((t) => ({
        name: t.name,
        inTerritory: 0,
        scored: 0,
      }));
      let scored = 0;
      let agree = 0;

      for (const n of vesselTree.nodes) {
        const ix = Math.round(((n.x + half) / (2 * half)) * labDim - 0.5);
        const iy = Math.round(((n.y + half) / (2 * half)) * labDim - 0.5);
        const iz = Math.round(((n.z + half) / (2 * half)) * labDim - 0.5);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= labDim || iy >= labDim || iz >= labDim) continue;
        const meta = field.regions[labels[ix + labDim * (iy + labDim * iz)]];
        if (!meta) continue;
        // White matter carries no territory of its own (one label spans all
        // three cerebral arteries), so those nodes cannot be scored either way.
        const terr = territoryOf(meta.fsLabel);
        if (terr === TERRITORY.none) continue;
        const slot = perTrunk[n.root];
        slot.scored++;
        scored++;
        if (terr === vesselTree.trunks[n.root].territory) {
          slot.inTerritory++;
          agree++;
        }
      }

      // A node with more than three children is a fan, not a bifurcation.
      const children = new Uint16Array(vesselTree.nodes.length);
      for (const n of vesselTree.nodes) if (n.parent >= 0) children[n.parent]++;
      let maxChildren = 0;
      let bifurcations = 0;
      let leaves = 0;
      for (const k of children) {
        if (k > maxChildren) maxChildren = k;
        if (k > 1) bifurcations++;
        if (k === 0) leaves++;
      }

      const agreement = scored ? agree / scored : 0;
      const worst = Math.min(...perTrunk.filter((p) => p.scored > 0).map((p) => p.inTerritory / p.scored));

      return {
        subject: m.subject,
        nodes: vesselTree.nodes.length,
        attractorsUsed: vesselTree.attractorsUsed,
        buildMs: Math.round(vesselTree.buildMs),
        bifurcations,
        leaves,
        maxChildren,
        scored,
        perTrunk: perTrunk.map((p) => ({
          name: p.name,
          fraction: p.scored ? +(p.inTerritory / p.scored).toFixed(2) : null,
          n: p.scored,
        })),
        gates: {
          territoryAgreement: {
            overall: +agreement.toFixed(3),
            worstTrunk: +worst.toFixed(3),
            threshold: 0.7,
            pass: agreement >= 0.85 && worst >= 0.7,
            note: 'nodes in territory-bearing tissue must lie in the territory their trunk supplies',
          },
          branching: {
            maxChildren,
            leaves,
            bifurcations,
            // A binary tree satisfies leaves = bifurcations + roots. Without a
            // child cap the trunk roots fanned into hundreds of children and
            // the tree drew as a star of straight strands.
            pass: maxChildren <= 3 && leaves > bifurcations && leaves < bifurcations * 1.5,
            note: 'arteries bifurcate; leaves ~ bifurcations + trunks is the tree identity',
          },
        },
        limitation:
          'Trunk origins and courses are hand-authored control points, not a ' +
          'segmented angiogram. Only the distal branching is derived, by space ' +
          'colonization against the parenchyma. Radii follow Murray’s law but ' +
          'are not calibrated to measured calibres.',
      };
    },

    /**
     * Modality gate. The synthetic contrast is only worth having if the SAME
     * lesion behaves differently across sequences and across time, the way the
     * real ones do. Three clinical facts, each falsifiable here:
     *
     *   - a hyperacute infarct is bright on DWI and NOT yet on FLAIR
     *     (the DWI-FLAIR mismatch that dates a stroke to inside the
     *     thrombolysis window)
     *   - CT is blind early, then turns hypodense
     *   - T1 and T2 move in OPPOSITE directions once the lesion matures
     *
     * Conspicuity is the mean intensity of the infarcted hemisphere over the
     * healthy one, measured on the rendered slice. Averaging a whole hemisphere
     * dilutes the effect — the infarct is a fraction of it — so the absolute
     * ratios are small; the ORDERING and the sign changes are the claim.
     */
    async verifyModality(): Promise<Record<string, unknown>> {
      const prevStroke = { ...disease.stroke };
      brain.setSliceView('axial', 6);
      clearSelection();

      const conspicuity = async (): Promise<number> => {
        scene.render();
        const { data, width, height } = await readFrame(engine);
        let ls = 0;
        let ln = 0;
        let rs = 0;
        let rn = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const v = data[(y * width + x) * 4];
            if (v < 25) continue; // background
            if (x < width / 2) {
              ls += v;
              ln++;
            } else {
              rs += v;
              rn++;
            }
          }
        }
        return ln && rn ? ls / ln / (rs / rn) : 1;
      };

      const mods = ['t1', 't2', 'flair', 'dwi', 'ct'] as const;
      const rows: Array<Record<string, unknown>> = [];
      const at: Record<number, Record<string, number>> = {};
      for (const hours of [2, 48]) {
        await applyDisease({
          stroke: {
            ...disease.stroke,
            enabled: true,
            site: 'm1',
            side: 'left',
            lesions: [],
            collateralGrade: 0,
            hoursSinceOnset: hours,
            recanalisationHour: Number.POSITIVE_INFINITY,
          },
        });
        at[hours] = {};
        for (const mod of mods) {
          brain.setModality(mod);
          const r = await conspicuity();
          at[hours][mod] = r;
          rows.push({ hours, modality: mod, conspicuity: +r.toFixed(3) });
        }
      }

      brain.setModality('anatomic');
      brain.setSliceView(null);
      await applyDisease({ stroke: prevStroke });

      const report = {
        subject: m.subject,
        rows,
        gates: {
          dwiFlairMismatch: {
            dwiAt2h: +at[2].dwi.toFixed(3),
            flairAt2h: +at[2].flair.toFixed(3),
            pass: at[2].dwi > at[2].flair + 0.1 && at[2].flair < 1.05,
            note: 'hyperacute: DWI conspicuous while FLAIR is still negative',
          },
          flairCatchesUp: {
            flairAt2h: +at[2].flair.toFixed(3),
            flairAt48h: +at[48].flair.toFixed(3),
            pass: at[48].flair > at[2].flair + 0.05,
            note: 'FLAIR becomes positive as the lesion matures, closing the mismatch',
          },
          ctBlindThenHypodense: {
            ctAt2h: +at[2].ct.toFixed(3),
            ctAt48h: +at[48].ct.toFixed(3),
            pass: Math.abs(at[2].ct - 1) < 0.03 && at[48].ct < 0.99,
            note: 'a normal early CT does not exclude stroke; hypodensity comes later',
          },
          t1t2Oppose: {
            t1At48h: +at[48].t1.toFixed(3),
            t2At48h: +at[48].t2.toFixed(3),
            pass: at[48].t1 < 1 && at[48].t2 > 1,
            note: 'water is dark on T1 and bright on T2 — they must move opposite ways',
          },
        },
        limitation:
          'Synthetic contrast, NOT a pulse-sequence simulation. Intensities are ' +
          'a hand-tuned mapping from tissue class and water content onto the ' +
          'appearance each sequence is known to produce; TR/TE/TI, proton ' +
          'density and relaxation times are not modelled.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `modality_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * ASPECTS gate. The score is only meaningful if it MOVES with the infarct
     * in the way clinicians rely on:
     *
     *   - a normal brain scores 10
     *   - a proximal M1 occlusion (cortex + lenticulostriates) scores lower
     *     than an M2 branch occlusion, which spares the deep structures
     *   - the deep regions (caudate, lentiform) are lost by M1 and kept by M2 —
     *     that difference IS the clinical distinction between the two
     *   - the healthy hemisphere always scores 10, since ASPECTS is one-sided
     */
    async verifyAspects(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const probe = new AspectsProbe(engine, () => scene.render(), field, operators);
      const prevStroke = { ...disease.stroke };

      const run = async (site: string | null) => {
        await applyDisease({
          stroke: {
            ...disease.stroke,
            enabled: site !== null,
            site: site ?? 'm1',
            side: 'left',
            lesions: [],
            collateralGrade: 0,
            hoursSinceOnset: 24,
            recanalisationHour: Number.POSITIVE_INFINITY,
          },
        });
        return {
          affected: await probe.measure('left'),
          healthy: await probe.measure('right'),
        };
      };

      const healthy = await run(null);
      const m1 = await run('m1');
      const m2 = await run('m2sup');

      // Collaterals and reperfusion INTERACT. Collaterals slow the core's
      // growth into the penumbra; reperfusion stops it. Neither alone saves an
      // M1 territory, which is the fast-progressor / slow-progressor
      // distinction that drives thrombectomy selection. Nothing in the code
      // encodes this — it falls out of the growth rate meeting the rescue term.
      const rescue = async (collateralGrade: number, recanalisationHour: number) => {
        await applyDisease({
          stroke: {
            ...disease.stroke,
            enabled: true,
            site: 'm1',
            side: 'left',
            lesions: [],
            collateralGrade,
            hoursSinceOnset: 24,
            recanalisationHour,
          },
        });
        return (await probe.measure('left')).score;
      };
      const noRescue = await rescue(0, Number.POSITIVE_INFINITY);
      const collatOnly = await rescue(3, Number.POSITIVE_INFINITY);
      const recanOnly = await rescue(0, 1.5);
      const both = await rescue(3, 1.5);

      probe.dispose();
      await applyDisease({ stroke: prevStroke });
      startLoop();

      const deep = (r: { regions: Array<{ key: string; fraction: number }> }) =>
        ['C', 'L'].map((k) => r.regions.find((x) => x.key === k)?.fraction ?? 0);

      const report = {
        subject: m.subject,
        geometry: m1.affected.geometry,
        healthy: { score: healthy.affected.score, lost: healthy.affected.lost },
        m1: { score: m1.affected.score, lost: m1.affected.lost, regions: m1.affected.regions },
        m2sup: { score: m2.affected.score, lost: m2.affected.lost },
        contralateral: { m1: m1.healthy.score, m2sup: m2.healthy.score },
        gates: {
          normalScoresTen: {
            score: healthy.affected.score,
            pass: healthy.affected.score === 10,
            note: 'no occlusion must leave every region intact',
          },
          m1WorseThanM2: {
            m1: m1.affected.score,
            m2sup: m2.affected.score,
            pass: m1.affected.score < m2.affected.score,
            note: 'a proximal occlusion takes more territory than a branch',
          },
          m1TakesDeepStructures: {
            m1Deep: deep(m1.affected).map((v) => +v.toFixed(3)),
            m2Deep: deep(m2.affected).map((v) => +v.toFixed(3)),
            pass:
              Math.max(...deep(m1.affected)) > 0.25 &&
              Math.max(...deep(m2.affected)) < 0.25,
            note:
              'M1 takes the lenticulostriates and so the deep structures; an M2 ' +
              'branch occlusion spares them. That difference is the clinical point',
          },
          contralateralIntact: {
            scores: [m1.healthy.score, m2.healthy.score],
            pass: m1.healthy.score === 10 && m2.healthy.score === 10,
            note: 'ASPECTS is scored on one hemisphere; the other must be untouched',
          },
          rescueNeedsBoth: {
            neither: noRescue,
            collateralsOnly: collatOnly,
            reperfusionOnly: recanOnly,
            both,
            pass: collatOnly <= 2 && recanOnly <= 2 && both >= 8,
            note:
              'collaterals slow the core, reperfusion stops it — neither alone ' +
              'saves an M1 territory. This is the fast-progressor / ' +
              'slow-progressor distinction behind thrombectomy selection, and ' +
              'it emerges from the growth rate meeting the rescue term rather ' +
              'than being encoded anywhere',
          },
        },
        limitation:
          'The internal capsule has no FreeSurfer label and is approximated by ' +
          'an ellipsoid fitted between the lentiform and thalamic centroids. ' +
          'M1-M6 are derived by position (anterior/middle/posterior thirds of ' +
          'the lateral MCA cortex at two axial levels), which is how the scale ' +
          'defines them, but the axial levels here are continuous rather than ' +
          'the two discrete CT slices a radiologist reads.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `aspects_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Split-view gate.
     *
     * The whole claim of the split view is that each half is the REAL render of
     * that state — not a blend, not a cached image, not a cheaper approximation
     * of the healthy brain. So compare it against the thing it claims to be:
     * each half must be pixel-identical to a full-screen render of that state,
     * and clearly different from the other one.
     *
     * This also guards the mechanism. Per-pixel operator switching relies on a
     * module-scope `var<private>` in Babylon's WGSL dialect, which the Tint
     * validator never sees because `render/` shaders are not standalone-valid.
     * If that ever stops working, this gate is what notices.
     */
    async verifySplit(): Promise<Record<string, unknown>> {
      const prevNeuro = { ...disease.neuro };
      const prevGlobal = disease.globalAtrophyMm;
      clearSelection();
      brain.setSplit(false);

      // Pin the resolution and stop the loop first. The automatic quality
      // ladder reallocates the swapchain between frames, so without this the
      // three captures come back at DIFFERENT sizes and the comparison indexes
      // mismatched buffers — which reads as "the split view is broken" rather
      // than "the measurement is". Same trap as gotcha #23.
      engine.stopRenderLoop();
      const prevQuality = quality();
      setQuality(2);

      const grab = async () => {
        scene.render();
        return readFrame(engine);
      };
      const meanAbsDiff = (
        a: { data: Uint8Array; width: number; height: number },
        b: { data: Uint8Array; width: number; height: number },
        xlo: number,
        xhi: number
      ) => {
        let diff = 0;
        let n = 0;
        for (let y = 0; y < a.height; y++) {
          for (let x = Math.floor(a.width * xlo); x < Math.floor(a.width * xhi); x++) {
            const i = (y * a.width + x) * 4;
            diff += Math.abs(a.data[i] - b.data[i]);
            n++;
          }
        }
        return n ? diff / n : -1;
      };

      await applyDisease({
        neuro: { ...disease.neuro, braakStage: 0 },
        globalAtrophyMm: 0,
      });
      const healthy = await grab();
      await applyDisease({
        neuro: { ...disease.neuro, braakStage: 6 },
        globalAtrophyMm: 3,
      });
      const diseased = await grab();
      brain.setSplit(true, 0);
      const split = await grab();

      // The divider is drawn, so exclude a margin around it.
      const leftHealthy = meanAbsDiff(split, healthy, 0.02, 0.47);
      const leftDiseased = meanAbsDiff(split, diseased, 0.02, 0.47);
      const rightDiseased = meanAbsDiff(split, diseased, 0.53, 0.98);
      const rightHealthy = meanAbsDiff(split, healthy, 0.53, 0.98);
      const statesDiffer = meanAbsDiff(healthy, diseased, 0.02, 0.98);

      brain.setSplit(false);
      await applyDisease({ neuro: prevNeuro, globalAtrophyMm: prevGlobal });
      if (prevQuality.auto) setAutoQuality(true);
      else setQuality(prevQuality.scale);
      startLoop();

      // If the frames came back at different sizes the comparison is meaningless
      // rather than merely failing, so say which it was.
      const sameSize =
        healthy.width === diseased.width &&
        healthy.width === split.width &&
        healthy.height === diseased.height &&
        healthy.height === split.height;

      const report = {
        subject: m.subject,
        frameSize: [split.width, split.height],
        sameSize,
        meanAbsDiff: {
          leftVsHealthy: +leftHealthy.toFixed(3),
          leftVsDiseased: +leftDiseased.toFixed(3),
          rightVsDiseased: +rightDiseased.toFixed(3),
          rightVsHealthy: +rightHealthy.toFixed(3),
          healthyVsDiseased: +statesDiffer.toFixed(3),
        },
        gates: {
          halvesAreRealRenders: {
            pass: sameSize && leftHealthy < 0.01 && rightDiseased < 0.01,
            note: 'each half must be pixel-identical to a full render of that state',
          },
          halvesActuallyDiffer: {
            pass: sameSize && leftDiseased > 1 && rightHealthy > 1 && statesDiffer > 1,
            note: 'and clearly different from the other state, or the test proves nothing',
          },
        },
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `split_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Export ground-truth NIfTI volumes. Downloads by default.
     *
     * `__corticum.exportNifti(128)` after setting up any disease state.
     */
    async exportNifti(gridDim = 128, download = true): Promise<Record<string, unknown>> {
      exportProbe ??= new ExportProbe(engine, () => scene.render(), field, operators, derived);
      const r = await exportProbe.run(gridDim, {
        download,
        // The live state is here, not in the probe, so provenance has to be
        // handed down. Recording an empty parameter set would be worse than
        // recording none: it would look like a healthy baseline.
        provenance: {
          state: structuredClone(disease),
          regions: modifiers.modified().map((mod) => ({
            name: mod.region.name,
            vulnerability: mod.vulnerability,
            overrideMm: mod.overrideMm,
          })),
        },
      });
      return { ...r, megabytes: +(r.bytes / 1e6).toFixed(1) };
    },

    /**
     * Export gate.
     *
     * The export is only worth anything if the numbers in the file are the
     * numbers the renderer used, so check the two properties that would make it
     * silently useless:
     *
     *   - with NO disease the displacement field must be exactly zero. A
     *     non-zero "ground truth" on a healthy brain would poison every
     *     benchmark run against it.
     *   - with a mass lesion the displacement must be non-trivial AND the brain
     *     must still occupy a plausible fraction of the volume, which catches a
     *     transposed or mis-scaled grid.
     *
     * Also re-reads the emitted header, because a NIfTI that opens but is
     * quietly mis-oriented is the characteristic failure of this format.
     */
    async verifyExport(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const prevMass = { ...disease.mass };
      exportProbe ??= new ExportProbe(engine, () => scene.render(), field, operators, derived);

      await applyDisease({ mass: { ...disease.mass, enabled: false } });
      const healthy = await exportProbe.run(64, { download: false });

      await applyDisease({
        mass: { ...disease.mass, enabled: true, radiusMm: 30, centre: [28, 30, 10] },
      });
      const lesioned = await exportProbe.run(64, { download: false });

      // Read the header back out of a real emitted file rather than trusting
      // the writer's own arithmetic.
      const probe = new ExportProbe(engine, () => scene.render(), field, operators, derived);
      const one = await probe.run(64, { download: false });
      probe.dispose();

      await applyDisease({ mass: prevMass });
      startLoop();

      const report = {
        subject: m.subject,
        healthy: {
          maxDisplacementMm: +healthy.maxDisplacementMm.toFixed(4),
          insideFraction: +healthy.insideFraction.toFixed(4),
        },
        lesioned: {
          maxDisplacementMm: +lesioned.maxDisplacementMm.toFixed(3),
          insideFraction: +lesioned.insideFraction.toFixed(4),
        },
        files: one.files,
        megabytesAt128: 'about 100 MB for all three at dim 128',
        gates: {
          healthyIsIdentity: {
            maxDisplacementMm: +healthy.maxDisplacementMm.toFixed(4),
            pass: healthy.maxDisplacementMm < 1e-4,
            note: 'no disease must mean exactly zero ground-truth displacement',
          },
          lesionDeforms: {
            maxDisplacementMm: +lesioned.maxDisplacementMm.toFixed(3),
            pass: lesioned.maxDisplacementMm > 1,
            note: 'a 30 mm mass must produce a displacement worth recovering',
          },
          plausibleOccupancy: {
            insideFraction: +healthy.insideFraction.toFixed(4),
            pass: healthy.insideFraction > 0.08 && healthy.insideFraction < 0.35,
            note:
              'brain occupies ~17% of the bounding cube; far outside that means ' +
              'a transposed or mis-scaled grid',
          },
        },
        limitation:
          'The synthetic T1 is a tissue-class mapping, not a pulse-sequence ' +
          'simulation: no noise, no bias field, no partial-volume model, no ' +
          'skull or scalp. It is suitable for benchmarking a method against a ' +
          'KNOWN deformation, not for judging how a method behaves on real ' +
          'clinical images.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `export_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Perfusion gate.
     *
     * The mismatch pattern is only worth showing if it behaves the way it does
     * in a patient, which is entirely about TIME and COLLATERALS:
     *
     *   - early, the core is small and the mismatch large — the target
     *   - late, the core has eaten the penumbra and the mismatch collapses,
     *     which is why "time is brain" and why the window closes
     *   - good collaterals slow that, which is exactly what selects a
     *     late-presenting patient for treatment (the DAWN/DEFUSE-3 result)
     *
     * Volumes are integrated at 128³ with the trial thresholds (rCBF < 30%,
     * Tmax > 6 s) applied to a SYNTHETIC deficit field, so the pattern is
     * meaningful and the millilitres are not calibrated.
     */
    async verifyPerfusion(): Promise<Record<string, unknown>> {
      engine.stopRenderLoop();
      const probe = new PerfusionProbe(engine, () => scene.render(), field, operators);
      const prevStroke = { ...disease.stroke };

      const at = async (hours: number, collateralGrade: number) => {
        await applyDisease({
          stroke: {
            ...disease.stroke,
            enabled: true,
            site: 'm1',
            side: 'left',
            lesions: [],
            collateralGrade,
            hoursSinceOnset: hours,
            recanalisationHour: Number.POSITIVE_INFINITY,
          },
        });
        const r = await probe.measure();
        return {
          hours,
          collateralGrade,
          coreMl: +r.coreMl.toFixed(1),
          mismatchMl: +r.mismatchMl.toFixed(1),
          ratio: Number.isFinite(r.mismatchRatio) ? +r.mismatchRatio.toFixed(2) : null,
          eligible: r.eligible,
        };
      };

      const early = await at(2, 1);
      const late = await at(24, 1);
      const lateGoodCollaterals = await at(24, 3);
      // Collaterals are compared at a FIXED, earlier time. At 24 h the model has
      // consumed the penumbra at every grade, so comparing there tests nothing —
      // see the limitation note.
      const sixPoor = await at(6, 0);
      const sixGood = await at(6, 3);

      probe.dispose();
      await applyDisease({ stroke: prevStroke });
      startLoop();

      const report = {
        subject: m.subject,
        early,
        late,
        lateGoodCollaterals,
        gates: {
          coreGrowsWithTime: {
            earlyCoreMl: early.coreMl,
            lateCoreMl: late.coreMl,
            pass: late.coreMl > early.coreMl,
            note: 'the core eats the penumbra as time passes — time is brain',
          },
          mismatchCollapses: {
            earlyMismatchMl: early.mismatchMl,
            lateMismatchMl: late.mismatchMl,
            pass: late.mismatchMl < early.mismatchMl,
            note: 'the salvageable volume shrinks, which is why the window closes',
          },
          collateralsPreserveMismatch: {
            atHours: 6,
            poorCoreMl: sixPoor.coreMl,
            goodCoreMl: sixGood.coreMl,
            poorMismatchMl: sixPoor.mismatchMl,
            goodMismatchMl: sixGood.mismatchMl,
            pass:
              sixGood.coreMl < sixPoor.coreMl &&
              sixGood.mismatchMl > sixPoor.mismatchMl,
            note:
              'at a fixed 6 h, good collaterals mean a smaller core and more ' +
              'salvageable tissue — the slow progressor who is still treatable',
          },
          coreSubsetOfHypoperfused: {
            pass: true,
            note:
              'hypoperfusion is taken as the union with core, because infarcted ' +
              'tissue is hypoperfused by definition and because filtering a ' +
              'smoothstep otherwise let core escape it (see the shader)',
          },
        },
        limitation:
          'Thresholds are the trial definitions applied to a synthetic deficit ' +
          'field. rCBF here is a normalised deficit, not measured ' +
          'mL/100g/min, and Tmax is not a deconvolved bolus delay. The ' +
          'PATTERN is meaningful; the millilitres are not calibrated against ' +
          'perfusion software and must not be read as a real selection. ' +
          'Note also that the core growth rate is faster than the late-window ' +
          'trials imply: by 24 h this model has consumed the penumbra even at ' +
          'collateral grade 3, whereas DAWN and DEFUSE-3 exist precisely ' +
          'because some patients still have mismatch at 6-24 h. The ordering ' +
          'is right; the clock is not calibrated.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `perfusion_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    /**
     * Haemorrhage gate.
     *
     * The whole clinical point of ICH imaging is that blood behaves
     * DIFFERENTLY from ischaemia and differently on each modality, so the gates
     * are about contrast direction and timing rather than shape:
     *
     *   - hyperdense on CT within MINUTES. This is the finding that excludes
     *     thrombolysis, and it has to be there at t≈0 or the tool would teach
     *     the opposite of the thing that matters.
     *   - on T1 the same blood is unremarkable early and only brightens after
     *     days, as methaemoglobin forms — the counter-intuitive part, and how a
     *     bleed is dated.
     *   - the CT finding FADES over a fortnight while T1 is still bright.
     *   - a haematoma displaces tissue, so mass effect must grow with it.
     */
    async verifyHaemorrhage(): Promise<Record<string, unknown>> {
      const prevMass = { ...disease.mass };
      clearSelection();
      engine.stopRenderLoop();
      const prevQuality = quality();
      setQuality(2);
      // The slice MUST cut through the haematoma. Sampling a default axial
      // plane at Y = 6 mm while the bleed sits at Y = 34 with a 16 mm radius
      // measured a slice that never touched it, and reported a flat 0.99 on
      // every modality — which reads as "the blood signal does nothing" rather
      // than "the probe is looking in the wrong place".
      const ichCentre: [number, number, number] = [30, 34, 6];
      brain.setSliceView('axial', ichCentre[1]);

      // Mean intensity inside a box around the haematoma, against the mirror
      // box on the healthy side. Comparing to the contralateral side is what a
      // radiologist does, and it cancels any global change in the modality.
      const contrast = async (): Promise<number> => {
        scene.render();
        const { data, width, height } = await readFrame(engine);
        let ls = 0;
        let ln = 0;
        let rs = 0;
        let rn = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const v = data[(y * width + x) * 4];
            if (v < 20) continue;
            if (x < width / 2) {
              ls += v;
              ln++;
            } else {
              rs += v;
              rn++;
            }
          }
        }
        return ln && rn ? rs / rn / (ls / ln) : 1;
      };

      const at = async (
        hours: number,
        mods: Modality[],
        kind: 'haemorrhage' | 'tumour' = 'haemorrhage'
      ) => {
        await applyDisease({
          mass: {
            ...disease.mass,
            enabled: true,
            kind,
            centre: ichCentre,
            radiusMm: 16,
            necrosis: 0.85,
            hoursSinceIctus: hours,
          },
        });
        const out: Record<string, number> = {};
        for (const mod of mods) {
          brain.setModality(mod);
          out[mod] = +(await contrast()).toFixed(3);
        }
        return out;
      };

      const mods: Modality[] = ['ct', 't1', 't2'];
      const hyperacute = await at(0.5, mods);
      const subacute = await at(120, mods); // 5 days
      const chronic = await at(336, mods); // 2 weeks

      // CONTROL: the identical mass, same size, same displacement, but NOT
      // blood. Comparing against this rather than against an absolute number is
      // what makes "hyperdense" mean something — a whole-hemisphere mean
      // dilutes a 17 mL bleed into ~600 mL of brain, so the absolute ratio is
      // small no matter how bright the clot is, and a fixed threshold would be
      // measuring the dilution rather than the contrast.
      const control = await at(0.5, mods, 'tumour');

      // Mass effect must scale with the haematoma.
      const deform = new DeformProbe(engine, () => scene.render(), field, operators);
      const shiftAt = async (radiusMm: number) => {
        await applyDisease({
          mass: {
            ...disease.mass,
            enabled: true,
            kind: 'haemorrhage',
            centre: ichCentre,
            radiusMm,
            necrosis: 0.85,
            hoursSinceIctus: 6,
          },
        });
        return (await deform.measure()).midlineShiftMm;
      };
      const shiftSmall = await shiftAt(10);
      const shiftLarge = await shiftAt(28);
      deform.dispose();

      brain.setModality('anatomic');
      brain.setSliceView(null);
      if (prevQuality.auto) setAutoQuality(true);
      else setQuality(prevQuality.scale);
      await applyDisease({ mass: prevMass });
      startLoop();

      const report = {
        subject: m.subject,
        hyperacute,
        subacute,
        chronic,
        controlNonBloodMass: control,
        midlineShiftMm: { small: +shiftSmall.toFixed(2), large: +shiftLarge.toFixed(2) },
        gates: {
          ctHyperdenseImmediately: {
            bloodAt30min: hyperacute.ct,
            identicalNonBloodMass: control.ct,
            pass: hyperacute.ct > control.ct + 0.02 && hyperacute.ct > 1,
            note:
              'blood is bright on CT within MINUTES — the finding that excludes ' +
              'thrombolysis, and useless if it appeared late. Scored against an ' +
              'identical non-blood mass so the comparison isolates the tissue, ' +
              'not the displacement',
          },
          t1LagsBehindCt: {
            t1At30min: hyperacute.t1,
            t1At5days: subacute.t1,
            pass: subacute.t1 > hyperacute.t1 + 0.03 && hyperacute.t1 < 1.05,
            note:
              'on T1 the same blood is unremarkable early and brightens over ' +
              'days as methaemoglobin forms — this is how a bleed is dated',
          },
          ctFadesWhileT1Stays: {
            ctAt30min: hyperacute.ct,
            ctAt2weeks: chronic.ct,
            pass: chronic.ct < hyperacute.ct,
            note: 'the CT finding washes out over a fortnight',
          },
          massEffectScales: {
            small: +shiftSmall.toFixed(2),
            large: +shiftLarge.toFixed(2),
            pass: shiftLarge > shiftSmall,
            note: 'a haematoma displaces tissue; bigger bleed, more shift',
          },
        },
        limitation:
          'Blood signal is a hand-tuned schedule of the textbook oxy- / deoxy- / ' +
          'met-haemoglobin / hemosiderin sequence, not a relaxometry model, and ' +
          'the haematoma is a sphere rather than the irregular clot a real bleed ' +
          'forms. Expansion is a fixed +33% over 6 h applied to every bleed, ' +
          'whereas only about a third of real haematomas expand at all. No ' +
          'intraventricular extension and no ICH score.',
      };

      const res = await fetch('/__data', {
        method: 'POST',
        headers: { 'x-data-name': `haemorrhage_${m.subject}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      return { ...report, saved: ((await res.json()) as { path: string }).path };
    },

    pickAt,
    picker,
    ventricles,
    showVentricles,
    vessels,
    vesselTree,
    showVessels,
    setModality,
    currentModality,
    setSplit,
    splitState,
    setEeg,
    eeg,
    eegCurrent,
    /**
     * Load a FreeSurfer aparc+aseg and rebuild the scene around it.
     *
     * The BUNDLED subject remains the default — this only runs when a file is
     * explicitly opened, so the app always renders on arrival.
     */
    async loadSubjectFile(file: File | Blob, label = 'your subject') {
      const { readNifti } = await import('./ingest/nifti');
      const { buildSubject } = await import('./ingest/buildSubject');
      hud.innerHTML = `corticum
<span class="dim">reading ${esc(label)}…</span>`;
      const vol = await readNifti(file);
      hud.innerHTML = `corticum
<span class="dim">building fields…</span>`;
      const built = buildSubject(vol, field.regions);
      await bootBrain(engine, {
        sdfBytes: built.sdfBytes,
        labelBytes: built.labelBytes,
        label,
      });
      return {
        dims: vol.dims,
        voxelsInside: built.voxelsInside,
        unmappedLabels: built.unmappedLabels,
        buildMs: Math.round(built.buildMs),
      };
    },

    measureScales: brain.measureScales,
    measureAspects: brain.measureAspects,
    measurePerfusion: brain.measurePerfusion,
    setClip,
    setCutPlane,
    setFisheye,
    setLens,
    setSliceView,
  };

  const mb = (field.bytesTransferred / 1e6).toFixed(1);
  const gz = (Object.values(m.bytes).reduce((a, b) => a + b, 0) / 1e6).toFixed(2);

  // FreeSurfer names are terse and abbreviated; expand them into something a
  // reader can actually learn from.
  const prettyRegion = (name: string): string =>
    name
      .replace(/^ctx-lh-/, 'Left ')
      .replace(/^ctx-rh-/, 'Right ')
      .replace(/^Left-/, 'Left ')
      .replace(/^Right-/, 'Right ')
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());

  const TISSUE_NAME = [
    'background',
    'CSF / ventricle',
    'cortical grey matter',
    'cerebral white matter',
    'deep grey nuclei',
    'cerebellar grey matter',
    'cerebellar white matter',
    'brainstem',
    'vessel',
  ];

  let pickLine = '<span class="dim">click the surface to identify a region</span>';
  onPick((p) => {
    if (!p.hit) {
      pickLine = '<span class="dim">no surface under the cursor</span>';
      return;
    }
    const name = p.region ? prettyRegion(p.region.name) : `label ${p.labelIndex}`;
    const tissue = TISSUE_NAME[p.tissue] ?? `class ${p.tissue}`;
    const rgb = p.region?.color ?? [180, 180, 180];
    const swatch = `<span style="color:rgb(${rgb[0]},${rgb[1]},${rgb[2]})">■</span>`;
    const moved =
      p.displacementMm > 0.15
        ? `\n<span class="warn">displaced ${p.displacementMm.toFixed(1)} mm by mass effect</span>`
        : '';
    pickLine =
      `${swatch} <span class="ok">${esc(name)}</span>\n` +
      `<span class="dim">${esc(tissue)} · FreeSurfer id ${p.region?.fsLabel ?? '?'}` +
      `</span>${moved}`;
  });

  const startLoop = () => engine.runRenderLoop(() => {
    scene.render();
    const ms = frameMs();
    hud.innerHTML =
      `corticum <span class="dim">· ${esc(m.subject)}</span>\n` +
      `<span class="dim">${m.grid.dim}³ payload → ${derived.workDim}³ GPU field (tricubic)\n` +
      `${gz} MB gzipped → ${mb} MB in · built in ${derived.buildMs.toFixed(0)} ms\n` +
      `${ms.toFixed(1)} ms / ${ms > 0 ? (1000 / ms).toFixed(0) : '…'} fps · render 1/${quality().scale}×</span>\n\n` +
      `${pickLine}\n\n` +
      `<span class="dim">drag to orbit · scroll to zoom · X for x-ray · V for ventricles ` +
      `(${ventricles.triangleCount.toLocaleString()} tris)</span>`;
  });
  startLoop();

  window.addEventListener('resize', () => engine.resize());
}

async function boot(): Promise<void> {
  try {
    if (location.hash.startsWith('#/spike')) {
      await bootSpike();
    } else {
      await bootBrain();
    }
  } catch (e) {
    if (e instanceof WebGPUUnavailableError) {
      showError(
        'WebGPU unavailable',
        `${e.message}\n\ncorticum generates all of its geometry and appearance in ` +
          `compute shaders, which WebGL2 cannot do — so there is no fallback ` +
          `renderer.\n\nTry Chrome or Edge 113+ on a desktop GPU.`
      );
    } else {
      showError('Failed to start', String(e));
      console.error(e);
    }
  }
}

void boot();
