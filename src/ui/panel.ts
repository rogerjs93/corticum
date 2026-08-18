import type { BrainScene } from '../scene/brainScene';
import type { RegionMeta } from '../fields/loader';
import type { Evidence } from '../disease/types';
import { OCCLUSION_SITES } from '../disease/territories';
import { loadPresets, type PatientPreset } from '../eeg/presets';
import type { Modality } from '../scene/brainScene';

/**
 * What each synthetic modality is actually teaching. These are the facts that
 * make a multi-modality view worth having at all — a single picture of one
 * sequence cannot convey any of them.
 */
const MODALITY_NOTE: Record<Exclude<Modality, 'anatomic'>, string> = {
  t1: 'Myelin bright, water dark. Good anatomy, poor at acute pathology.',
  t2: 'Water bright. Old infarcts and oedema stand out; CSF is bright too, which hides periventricular disease.',
  flair:
    'T2 with CSF nulled — the sequence for periventricular MS plaques. Stays NEGATIVE for the first ~4.5 h of a stroke.',
  dwi: 'Restricted diffusion: bright within MINUTES of onset, fading around day 10. DWI positive + FLAIR negative dates a stroke to inside the thrombolysis window.',
  ct: 'Attenuation. Grey matter is denser than white, so the relationship inverts — and an infarct is INVISIBLE for hours, which is why a normal CT does not exclude stroke.',
  rcbf: 'Relative cerebral blood flow. Below 30% of the healthy side defines the irreversible CORE.',
  tmax: 'Bolus delay. Above 6 s defines the hypoperfused tissue — core plus the penumbra still worth saving.',
  mismatch:
    'RAPID convention: magenta core inside a green penumbra. The green rim IS the treatment target, and its size relative to the core is what selects for thrombectomy.',
};
import type { EegBand } from '../eeg/project';

/**
 * Control panel.
 *
 * Plain DOM, no framework: the panel is a few dozen controls and adding a
 * rendering library to a project whose whole point is hand-written GPU code
 * would be a poor trade.
 *
 * The design rule throughout: every parameter that is not straight from the
 * literature says so, in the interface, where someone using this to learn will
 * actually see it. A teaching tool that cannot distinguish "this is what the
 * evidence says" from "this looks about right" is worse than no teaching tool.
 */

const EVIDENCE_STYLE: Record<Evidence, { dot: string; label: string; title: string }> = {
  literature: {
    dot: '#6ee7a8',
    label: 'literature',
    title: 'Follows published findings.',
  },
  derived: {
    dot: '#7cc4ff',
    label: 'derived',
    title: 'Computed from the subject’s own anatomy rather than assumed.',
  },
  'plausible-approximation': {
    dot: '#e3b341',
    label: 'approximation',
    title:
      'Visual approximation, not a validated model. The sequence may follow the ' +
      'literature but the magnitudes and rates do not.',
  },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function evidenceTag(kind: Evidence): HTMLElement {
  const s = EVIDENCE_STYLE[kind];
  const span = el('span', 'cx-ev');
  span.title = s.title;
  const dot = el('span', 'cx-ev-dot');
  dot.style.background = s.dot;
  span.append(dot, document.createTextNode(s.label));
  return span;
}

/**
 * A collapsible section.
 *
 * The panel outgrew a flat list once modality, perfusion, scales, split and
 * export landed — nine features' worth of controls in one column, where the
 * thing you want is always below the fold. Grouping them by WORKFLOW rather
 * than by subsystem is what makes it navigable: you pick a scenario, place a
 * lesion, read the numbers, choose how to image it, then move the camera.
 *
 * `<details>` rather than a custom widget: it is keyboard accessible and
 * remembers nothing, which is correct — a panel that restores collapse state
 * across reloads hides controls from someone who has just changed something.
 */
/**
 * A workflow group heading.
 *
 * Nine collapsible sections in one column is a list, not an interface — the
 * numbering told you the order but not WHY one control sits next to another.
 * These four labels chunk them by what the user is doing: change the brain,
 * read what changed, choose how to look at it, get data in or out.
 */
function makeGroup(label: string): HTMLElement {
  const d = el('div', 'cx-group');
  d.textContent = label;
  return d;
}

function makeSection(title: string, open = false) {
  const root = el('details', 'cx-sec');
  root.open = open;
  const summary = el('summary', 'cx-h');
  summary.textContent = title;
  const body = el('div', 'cx-secbody');
  root.append(summary, body);
  return { root, body };
}

interface SliderOpts {
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

function slider(label: string, o: SliderOpts) {
  const wrap = el('div', 'cx-row');
  const head = el('div', 'cx-row-head');
  const name = el('span', 'cx-label', label);
  const val = el('span', 'cx-val');
  const fmt = o.format ?? ((v: number) => v.toFixed(2));
  val.textContent = fmt(o.value);
  head.append(name, val);

  const input = el('input', 'cx-slider');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    o.onInput(v);
  });

  wrap.append(head, input);
  return { root: wrap, input, set: (v: number) => { input.value = String(v); val.textContent = fmt(v); } };
}

export function createPanel(brain: BrainScene, regions: RegionMeta[]): HTMLElement {
  const root = el('div', 'cx-panel');

  // Evidence key.
  //
  // The tags are the most important thing in this interface — they are what
  // separates "this is what the evidence says" from "this looks about right" —
  // and until now the only way to learn what a colour meant was to hover it.
  // Honesty that has to be discovered is not doing its job.
  const evidenceKey = el('div', 'cx-evkey');
  for (const kind of ['literature', 'derived', 'plausible-approximation'] as Evidence[]) {
    evidenceKey.append(evidenceTag(kind));
  }

  // ---- subject --------------------------------------------------------------
  //
  // First in the list but COLLAPSED and entirely optional. The bundled subject
  // is already loaded and every feature works on it; this exists for someone
  // who has their own FreeSurfer output. A panel that opens demanding a file
  // would turn a working demo into a dead end.
  const secSubject = makeSection('1 · Subject');
  const subjectNote = el(
    'div',
    'cx-note',
    'Showing the bundled subject — every control in this panel works right ' +
      'now, with no file needed. To use your own brain instead, open a ' +
      'FreeSurfer aparc+aseg as .nii or .nii.gz.'
  );
  const fileInput = el('input', 'cx-select');
  fileInput.type = 'file';
  fileInput.accept = '.nii,.nii.gz,.gz';
  const subjectStatus = el('div', 'cx-note');

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    subjectStatus.textContent = 'reading…';
    try {
      const api = (window as unknown as {
        __corticum?: {
          loadSubjectFile?: (
            file: File,
            label?: string
          ) => Promise<{ dims: number[]; voxelsInside: number; unmappedLabels: number[]; buildMs: number }>;
        };
      }).__corticum;
      if (!api?.loadSubjectFile) throw new Error('loader unavailable');
      const r = await api.loadSubjectFile(f, f.name);
      subjectStatus.textContent =
        `${f.name}: ${r.dims.join('x')} in ${(r.buildMs / 1000).toFixed(1)} s · ` +
        `${(r.voxelsInside / 1000).toFixed(0)}k parenchyma voxels` +
        (r.unmappedLabels.length
          ? ` · ${r.unmappedLabels.length} label(s) not in the region table`
          : '');
    } catch (e) {
      subjectStatus.textContent = `could not load: ${String(e)}`;
    }
  });

  secSubject.body.append(
    subjectNote,
    fileInput,
    subjectStatus,
    el(
      'div',
      'cx-cite',
      'Needs a completed FreeSurfer/FastSurfer recon — a raw T1 has no ' +
        'parcellation, and region names, ASPECTS, territories and staging all ' +
        'depend on one. The ventricular mesh still shows the bundled subject.'
    )
  );

  // ---- scenario + timeline -------------------------------------------------
  const secTime = makeSection('2 · Scenario & time', true);

  const select = el('select', 'cx-select');
  select.append(new Option('— none (healthy) —', ''));
  for (const s of brain.timeline().scenarios) {
    select.append(new Option(s.name, s.id));
  }

  const evRow = el('div', 'cx-evrow');
  const narrative = el('div', 'cx-note');
  const citation = el('div', 'cx-cite');

  const timeRow = slider('time', {
    min: 0,
    max: 15,
    step: 0.05,
    value: 0,
    format: (v) => {
      const s = brain.timeline().scenario;
      return s ? `${v.toFixed(1)} ${s.unit}` : '—';
    },
    onInput: (v) => {
      brain.play(false);
      playBtn.textContent = '▶';
      brain.setTime(v);
      refreshNarrative();
      scheduleVolume();
    },
  });

  const transport = el('div', 'cx-transport');
  const playBtn = el('button', 'cx-btn', '▶');
  const resetBtn = el('button', 'cx-btn', '⟲');
  transport.append(playBtn, resetBtn);

  playBtn.addEventListener('click', () => {
    const tl = brain.timeline();
    if (!tl.scenario) return;
    const next = !tl.playing;
    brain.play(next);
    playBtn.textContent = next ? '❚❚' : '▶';
  });
  resetBtn.addEventListener('click', () => {
    brain.play(false);
    playBtn.textContent = '▶';
    brain.setTime(0);
    timeRow.set(0);
    refreshNarrative();
  });

  function refreshNarrative() {
    const tl = brain.timeline();
    if (!tl.scenario) {
      narrative.textContent = 'No disease active — baseline anatomy.';
      citation.textContent = '';
      evRow.replaceChildren();
      return;
    }
    narrative.textContent = tl.scenario.narrative(tl.t);
    citation.textContent = tl.scenario.citation ?? '';
    evRow.replaceChildren(evidenceTag(tl.scenario.evidence));
  }

  select.addEventListener('change', async () => {
    brain.play(false);
    playBtn.textContent = '▶';
    await brain.setScenario(select.value || null);
    const tl = brain.timeline();
    timeRow.input.max = String(tl.scenario?.tMax ?? 15);
    timeRow.set(0);
    refreshNarrative();
    scheduleVolume();
  });

  secTime.body.append(select, evRow, timeRow.root, transport, narrative, citation);

  // ---- region / group control ---------------------------------------------
  // Everything the model MEASURES, in one place. These were scattered across
  // the sections that produced them, which meant the volume, the scales,
  // ASPECTS and the perfusion numbers — all answers to "how bad is it" — were
  // never visible together.
  const secMeasure = makeSection('5 · Measurements', true);
  const secExport = makeSection('9 · Export');

  const secRegion = makeSection('4 · Regional control');

  const groupKind = el('select', 'cx-select cx-inline');
  for (const k of ['network', 'lobe', 'hemisphere']) {
    groupKind.append(new Option(k, k));
  }
  const groupValue = el('select', 'cx-select cx-inline');

  const fillGroupValues = () => {
    const kind = groupKind.value as 'network' | 'lobe' | 'hemisphere';
    groupValue.replaceChildren();
    for (const g of brain.modifiers.groups(kind)) {
      if (g.value === 'none' || g.value === 'other') continue;
      groupValue.append(new Option(`${g.value} (${g.count})`, g.value));
    }
  };
  fillGroupValues();
  groupKind.addEventListener('change', () => {
    fillGroupValues();
    applyHighlight();
  });
  groupValue.addEventListener('change', () => applyHighlight());

  const groupRow = el('div', 'cx-inline-row');
  groupRow.append(groupKind, groupValue);

  const searchInput = el('input', 'cx-select');
  searchInput.type = 'search';
  searchInput.placeholder = 'or search a single region…';
  const searchHits = el('div', 'cx-hits');

  let target: { kind: 'group'; k: 'network' | 'lobe' | 'hemisphere'; v: string } |
    { kind: 'region'; region: RegionMeta } = {
    kind: 'group',
    k: 'network',
    v: 'default mode',
  };

  const targetLabel = el('div', 'cx-target');

  function applyHighlight() {
    const kind = groupKind.value as 'network' | 'lobe' | 'hemisphere';
    target = { kind: 'group', k: kind, v: groupValue.value };
    const n = brain.modifiers.group(kind, groupValue.value);
    brain.setSelection(n);
    targetLabel.textContent = `${groupValue.value} · ${n.length} regions`;
    syncModifierSliders();
    scheduleVolume();
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    searchHits.replaceChildren();
    if (q.length < 2) return;
    const hits = regions.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 8);
    for (const r of hits) {
      const b = el('button', 'cx-hit', r.name);
      b.addEventListener('click', () => {
        target = { kind: 'region', region: r };
        brain.setSelection([r]);
        targetLabel.textContent = `${r.name} · ${r.lobe}${r.network !== 'none' ? ` · ${r.network}` : ''}`;
        searchHits.replaceChildren();
        searchInput.value = '';
        syncModifierSliders();
        scheduleVolume();
      });
      searchHits.append(b);
    }
  });

  const vulnRow = slider('vulnerability', {
    min: 0,
    max: 3,
    step: 0.05,
    value: 1,
    format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => {
      void applyModifier({ vulnerability: v });
    },
  });

  const overrideRow = slider('extra atrophy', {
    min: 0,
    max: 5,
    step: 0.1,
    value: 0,
    format: (v) => `${v.toFixed(1)} mm`,
    onInput: (v) => {
      void applyModifier({ overrideMm: v });
    },
  });

  let modifierPending: { vulnerability?: number; overrideMm?: number } | null = null;
  let modifierRunning = false;
  async function applyModifier(opts: { vulnerability?: number; overrideMm?: number }) {
    modifierPending = { ...modifierPending, ...opts };
    if (modifierRunning) return;
    modifierRunning = true;
    while (modifierPending) {
      const o = modifierPending;
      modifierPending = null;
      if (target.kind === 'group') {
        if (o.vulnerability !== undefined) {
          brain.modifiers.setGroupVulnerability(target.k, target.v, o.vulnerability);
        }
        if (o.overrideMm !== undefined) {
          brain.modifiers.setGroupOverride(target.k, target.v, o.overrideMm);
        }
      } else {
        if (o.vulnerability !== undefined) {
          brain.modifiers.setVulnerability(target.region.fsLabel, o.vulnerability);
        }
        if (o.overrideMm !== undefined) {
          brain.modifiers.setOverride(target.region.fsLabel, o.overrideMm);
        }
      }
      await brain.applyDisease();
    }
    modifierRunning = false;
    scheduleVolume();
  }

  function syncModifierSliders() {
    const idx =
      target.kind === 'region'
        ? target.region.index
        : (brain.modifiers.group(target.k, target.v)[0]?.index ?? -1);
    if (idx < 0) return;
    vulnRow.set(brain.modifiers.getVulnerability(idx));
    overrideRow.set(brain.modifiers.getOverride(idx));
  }

  const clearBtn = el('button', 'cx-btn cx-wide', 'reset all regions');
  clearBtn.addEventListener('click', async () => {
    brain.modifiers.clear();
    brain.clearSelection();
    vulnRow.set(1);
    overrideRow.set(0);
    await brain.applyDisease();
    scheduleVolume();
  });

  const volumeOut = el('div', 'cx-vol');
  // What a radiologist would actually write in the report, next to the raw
  // volume that produced it.
  const scalesOut = el('div', 'cx-vol');

  secRegion.body.append(
    groupRow,
    searchInput,
    searchHits,
    targetLabel,
    vulnRow.root,
    overrideRow.root,
    clearBtn
  );

  // ---- stroke -------------------------------------------------------------
  //
  // Its own section rather than a scenario preset, because occlusion site,
  // side and collateral grade are the three things a stroke is actually
  // discussed in terms of, and the vascular tree exists so you can see which
  // branches a given site starves.
  const secStroke = makeSection('3 · Lesion', true);

  const siteSel = el('select', 'cx-select');
  siteSel.append(new Option('— no occlusion —', ''));
  for (const s of OCCLUSION_SITES) siteSel.append(new Option(s.name, s.id));

  const sideSel = el('select', 'cx-select cx-inline');
  sideSel.append(new Option('left', 'left'), new Option('right', 'right'));

  const vesselBtn = el('button', 'cx-btn cx-inline', 'arteries: off');
  let vesselsOn = false;
  vesselBtn.addEventListener('click', () => {
    vesselsOn = !vesselsOn;
    brain.showVessels(vesselsOn);
    vesselBtn.textContent = `arteries: ${vesselsOn ? 'on' : 'off'}`;
  });
  const strokeRow = el('div', 'cx-inline-row');
  strokeRow.append(sideSel, vesselBtn);

  const syndrome = el('div', 'cx-note');

  const applyStroke = async () => {
    const site = OCCLUSION_SITES.find((s) => s.id === siteSel.value);
    // A bilateral site has no side to choose, so say so rather than offering a
    // control that does nothing.
    sideSel.disabled = !site || !!site.bilateral;
    syndrome.textContent = site
      ? `${site.note}${site.bilateral ? '' : ` (${sideSel.value} hemisphere)`}`
      : '';
    await brain.applyDisease({
      stroke: {
        ...brain.disease.stroke,
        enabled: !!site,
        site: siteSel.value || brain.disease.stroke.site,
        side: sideSel.value as 'left' | 'right',
        collateralGrade: Number(collatRow.input.value),
        hoursSinceOnset: Number(onsetRow.input.value),
      },
    });
    scheduleVolume();
    scheduleAspects();
  };

  const collatRow = slider('collaterals', {
    min: 0,
    max: 3,
    step: 0.5,
    value: 1,
    format: (v) => `grade ${v}`,
    onInput: () => void applyStroke(),
  });
  const onsetRow = slider('time since onset', {
    min: 0,
    max: 720,
    step: 1,
    value: 24,
    format: (v) => (v < 48 ? `${v} h` : `${(v / 24).toFixed(1)} d`),
    onInput: () => void applyStroke(),
  });

  siteSel.addEventListener('change', () => void applyStroke());
  sideSel.addEventListener('change', () => void applyStroke());

  // ASPECTS is the number that actually gates treatment, so it belongs next to
  // the controls that change it rather than buried in a console gate.
  const aspectsOut = el('div', 'cx-vol');
  const perfusionOut = el('div', 'cx-vol');
  let aspectsTimer: number | undefined;
  let aspectsBusy = false;
  const scheduleAspects = () => {
    window.clearTimeout(aspectsTimer);
    aspectsOut.classList.add('cx-stale');
    perfusionOut.classList.add('cx-stale');
    aspectsTimer = window.setTimeout(() => void refreshAspects(), 500);
  };
  async function refreshAspects() {
    if (aspectsBusy) return;
    aspectsBusy = true;
    try {
      const r = await brain.measureAspects();
      if (!r) {
        aspectsOut.textContent = '';
      } else {
        const cls = r.score <= 5 ? 'cx-loss' : 'cx-dim';
        aspectsOut.innerHTML =
          `<span class="cx-label">ASPECTS</span> ` +
          `<span class="${cls}">${r.score}</span><span class="cx-dim">/10</span> ` +
          `<span class="cx-dim">${r.lost.length ? `lost ${esc(r.lost.join(' '))}` : 'all regions intact'}</span>`;
      }
      // Perfusion volumes ride on the same refresh: ASPECTS and the mismatch
      // are the two numbers that select for treatment, and showing one without
      // the other tells half the story.
      const pf = await brain.measurePerfusion();
      if (!pf) {
        perfusionOut.textContent = '';
      } else {
        const ratio = Number.isFinite(pf.mismatchRatio)
          ? pf.mismatchRatio.toFixed(1)
          : '∞';
        const verdict = pf.eligible
          ? '<span class="cx-ok">meets DEFUSE-3</span>'
          : `<span class="cx-loss">${esc(pf.reasons[0] ?? 'no target')}</span>`;
        perfusionOut.innerHTML =
          `<span class="cx-label">core</span> ${pf.coreMl.toFixed(0)} mL ` +
          `<span class="cx-dim">·</span> <span class="cx-label">mismatch</span> ` +
          `${pf.mismatchMl.toFixed(0)} mL (×${ratio}) ` +
          `<span class="cx-dim">·</span> ${verdict}`;
      }
      aspectsOut.classList.remove('cx-stale');
      perfusionOut.classList.remove('cx-stale');
    } finally {
      aspectsBusy = false;
    }
  }

  // ---- haemorrhage ----------------------------------------------------------
  //
  // Placed by STRUCTURE rather than by coordinates. Typing millimetres to put a
  // bleed in the putamen is not how anyone thinks about it, and the region
  // machinery for centroids and names already exists.
  const bleedSel = el('select', 'cx-select');
  bleedSel.append(new Option('— no haemorrhage —', '-1'));
  // Deep grey and lobar sites, which is where spontaneous ICH actually happens.
  const ICH_SITES = [
    'Left-Putamen', 'Right-Putamen',
    'Left-Thalamus', 'Right-Thalamus',
    'Left-Caudate', 'Right-Caudate',
    'Left-Cerebellum-Cortex', 'Right-Cerebellum-Cortex',
    'Brain-Stem',
    'ctx-lh-superiorfrontal', 'ctx-rh-superiorfrontal',
    'ctx-lh-superiortemporal', 'ctx-rh-superiortemporal',
  ];
  for (const name of ICH_SITES) {
    const r = regions.find((x) => x.name === name || x.name === `${name}-Proper`);
    // Keep the hemisphere: stripping the ctx-lh-/ctx-rh- prefix left two
    // entries both reading "superiorfrontal", which is unusable.
    if (r) {
      bleedSel.append(
        new Option(name.replace(/^ctx-lh-/, 'Left ').replace(/^ctx-rh-/, 'Right '), String(r.index))
      );
    }
  }

  const bleedNote = el('div', 'cx-note');

  const applyBleed = async () => {
    const idx = Number(bleedSel.value);
    if (idx < 0) {
      bleedNote.textContent = '';
      await brain.applyDisease({ mass: { enabled: false } });
      scheduleVolume();
      return;
    }
    const centre = brain.regionCentroid(idx);
    if (!centre) {
      bleedNote.textContent = 'that structure is not present in this subject';
      return;
    }
    const region = regions[idx];
    bleedNote.textContent =
      `${region?.name ?? idx} · centroid ${centre.map((v) => v.toFixed(0)).join(', ')} mm`;
    await brain.applyDisease({
      mass: {
        enabled: true,
        kind: 'haemorrhage',
        centre,
        radiusMm: Number(bleedSizeRow.input.value),
        density: Number(bleedDensityRow.input.value),
        irregularity: Number(bleedIrregRow.input.value),
        targetRegion: idx,
        hoursSinceIctus: Number(bleedHoursRow.input.value),
        necrosis: 0.85,
        edemaExtentMm: 6 + 14 * Number(bleedHoursRow.input.value) / 96,
        edemaStrength: 0.9,
      },
    });
    scheduleVolume();
    scheduleAspects();
  };

  const bleedSizeRow = slider('clot radius', {
    min: 4, max: 34, step: 1, value: 15,
    format: (v) => `${v} mm ≈ ${((4 / 3) * Math.PI * v ** 3 / 1000).toFixed(0)} mL`,
    onInput: () => void applyBleed(),
  });
  const bleedDensityRow = slider('density', {
    min: 0.2, max: 1, step: 0.05, value: 1,
    format: (v) => (v > 0.85 ? 'dense clot' : v > 0.5 ? 'mixed' : 'liquefying'),
    onInput: () => void applyBleed(),
  });
  const bleedIrregRow = slider('irregularity', {
    min: 0, max: 1, step: 0.05, value: 0.55,
    format: (v) => (v < 0.05 ? 'spherical' : v < 0.5 ? 'lobulated' : 'irregular'),
    onInput: () => void applyBleed(),
  });
  const bleedHoursRow = slider('hours since ictus', {
    min: 0, max: 336, step: 1, value: 6,
    format: (v) => (v < 48 ? `${v} h` : `${(v / 24).toFixed(1)} d`),
    onInput: () => void applyBleed(),
  });
  bleedSel.addEventListener('change', () => void applyBleed());

  secStroke.body.append(
    el('div', 'cx-label', 'Ischaemic'),
    siteSel,
    strokeRow,
    collatRow.root,
    onsetRow.root,
    syndrome,
    el('div', 'cx-label', 'Haemorrhagic'),
    bleedSel,
    bleedSizeRow.root,
    bleedDensityRow.root,
    bleedIrregRow.root,
    bleedHoursRow.root,
    bleedNote,
    evidenceTag('plausible-approximation')
  );

  // ---- patient (stroke_qeeg) ----------------------------------------------
  const secPatient = makeSection('8 · Patient data (stroke_qeeg)');

  const patientSel = el('select', 'cx-select');
  patientSel.append(new Option('— none —', ''));
  const bandSel = el('select', 'cx-select cx-inline');
  for (const b of ['delta', 'theta', 'alpha', 'beta', 'gamma', 'dar']) {
    bandSel.append(new Option(b === 'dar' ? 'delta/alpha' : b, b));
  }
  bandSel.value = 'alpha';
  const eegBtn = el('button', 'cx-btn cx-inline', 'qEEG: off');
  const eegRow = el('div', 'cx-inline-row');
  eegRow.append(bandSel, eegBtn);

  const clinical = el('div', 'cx-note');
  const caveat = el('div', 'cx-note');
  let eegOn = false;
  let presets: PatientPreset[] = [];

  const applyPatient = async () => {
    const p = presets.find((x) => x.id === patientSel.value);
    if (!p) {
      clinical.textContent = '';
      caveat.textContent = '';
      brain.setEeg(null);
      eegOn = false;
      eegBtn.textContent = 'qEEG: off';
      await brain.applyDisease({ stroke: { ...brain.disease.stroke, enabled: false, lesions: [] } });
      return;
    }
    clinical.textContent =
      `${p.age}y ${p.gender}, ${p.durationMonths} mo since onset · ` +
      `NIHSS ${p.nihss} · mRS ${p.mrs} · ${p.paralysisSide} paralysis — “${p.location}”`;
    const approx = p.lesions.filter((l) => l.approximate).length;
    caveat.textContent = approx
      ? `${p.lesions.length} lesion(s); ${approx} approximate — see tag`
      : `${p.lesions.length} lesion(s) mapped from the record`;

    await brain.applyDisease({
      stroke: {
        ...brain.disease.stroke,
        enabled: true,
        // Every lesion at once, each with its own side. A real record often
        // names several, sometimes in both hemispheres.
        lesions: p.lesions.map((l) => ({ site: l.site, side: l.side })),
        collateralGrade: 1,
        // Chronic: these recordings are months post-stroke, so show the
        // cavitated end state rather than an acute core.
        hoursSinceOnset: Math.min(720, Math.max(24, p.durationMonths * 720)),
      },
    });
    if (eegOn) brain.setEeg(p.id, bandSel.value as EegBand);
    scheduleVolume();
    scheduleAspects();
  };

  eegBtn.addEventListener('click', () => {
    const p = presets.find((x) => x.id === patientSel.value);
    eegOn = !eegOn && !!p;
    eegBtn.textContent = `qEEG: ${eegOn ? bandSel.value : 'off'}`;
    brain.setEeg(eegOn && p ? p.id : null, bandSel.value as EegBand);
  });
  bandSel.addEventListener('change', () => {
    const p = presets.find((x) => x.id === patientSel.value);
    if (eegOn && p) {
      brain.setEeg(p.id, bandSel.value as EegBand);
      eegBtn.textContent = `qEEG: ${bandSel.value}`;
    }
  });
  patientSel.addEventListener('change', () => void applyPatient());

  void loadPresets(import.meta.env.BASE_URL).then((doc) => {
    if (!doc) {
      secPatient.body.append(el('div', 'cx-note', 'presets.json not built'));
      return;
    }
    presets = doc.presets;
    for (const p of presets) {
      patientSel.append(new Option(`${p.id} — ${p.location}`, p.id));
    }
    secPatient.body.append(el('div', 'cx-note', doc.limitation));
  });

  secPatient.body.append(
    patientSel,
    clinical,
    caveat,
    eegRow,
    evidenceTag('plausible-approximation')
  );

  // ---- view ---------------------------------------------------------------
  // Split in two: choosing HOW to image the field is a different job from
  // moving the camera through it, and bundling them put the modality selector
  // below three lens sliders.
  const secView = makeSection('6 · Imaging', true);
  const secNav = makeSection('7 · Navigation');

  const modeRow = slider('x-ray', {
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    format: (v) => (v < 0.02 ? 'specimen' : v > 0.98 ? 'x-ray' : `${(v * 100) | 0}%`),
    onInput: (v) => brain.setMode(v),
  });

  // Radiological modality. Sits with the view controls because it changes how
  // the same field is displayed, not what the field contains.
  const modalitySel = el('select', 'cx-select');
  for (const [v, label] of [
    ['anatomic', 'anatomic (specimen)'],
    ['t1', 'MRI T1'],
    ['t2', 'MRI T2'],
    ['flair', 'MRI FLAIR'],
    ['dwi', 'MRI DWI'],
    ['ct', 'CT'],
    ['rcbf', 'Perfusion — rCBF'],
    ['tmax', 'Perfusion — Tmax'],
    ['mismatch', 'Perfusion — mismatch'],
  ] as const) {
    modalitySel.append(new Option(label, v));
  }
  const modalityNote = el('div', 'cx-note');
  modalitySel.addEventListener('change', () => {
    const m = modalitySel.value as Modality;
    brain.setModality(m);
    modalityNote.textContent = m === 'anatomic' ? '' : MODALITY_NOTE[m];
    // These are read as slices in practice, and a 3D surface tells you almost
    // nothing about internal contrast — so offer the slice view with it.
    if (m !== 'anatomic' && sliceAxis.value === '3D view') {
      sliceAxis.value = 'axial slice';
      sliceAxis.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  const cutAxis = el('select', 'cx-select cx-inline');
  for (const a of ['off', 'sagittal', 'axial', 'coronal']) cutAxis.append(new Option(a, a));
  const cutFlip = el('button', 'cx-btn', '⇄');
  const cutRowTop = el('div', 'cx-inline-row');
  cutRowTop.append(cutAxis, cutFlip);

  let flipped = false;
  const cutOffset = slider('cut position', {
    min: -90,
    max: 90,
    step: 1,
    value: 0,
    format: (v) => `${v} mm`,
    onInput: (v) => applyCut(v),
  });
  function applyCut(offset = Number(cutOffset.input.value)) {
    // In slice view the cut plane IS the slice, so move it rather than
    // switching back to a 3D cutaway.
    if (sliceAxis.value !== '3D view') {
      brain.setSliceView(
        sliceAxis.value.split(' ')[0] as 'sagittal' | 'axial' | 'coronal',
        offset
      );
      return;
    }
    if (cutAxis.value === 'off') {
      brain.setClip(false);
      return;
    }
    brain.setCutPlane(cutAxis.value as 'sagittal' | 'axial' | 'coronal', offset, flipped);
  }
  cutAxis.addEventListener('change', () => applyCut());
  cutFlip.addEventListener('click', () => {
    flipped = !flipped;
    applyCut();
  });

  // Split comparison. The divider is draggable rather than fixed at centre,
  // because wiping it across the lesion is what makes a subtle change visible —
  // the eye is far better at detecting motion at an edge than at comparing two
  // static images.
  const splitBtn = el('button', 'cx-btn cx-inline', 'compare: off');
  let splitOn = false;
  const splitPos = slider('divider', {
    min: -0.9,
    max: 0.9,
    step: 0.01,
    value: 0,
    format: (v) => (v < -0.02 ? 'left' : v > 0.02 ? 'right' : 'centre'),
    onInput: (v) => brain.setSplit(splitOn, v),
  });
  splitBtn.addEventListener('click', () => {
    splitOn = !splitOn;
    brain.setSplit(splitOn, Number(splitPos.input.value));
    splitBtn.textContent = `compare: ${splitOn ? 'on' : 'off'}`;
    splitNote.textContent = splitOn
      ? 'Left of the divider is the same brain with no disease applied — a counterfactual, not a different scan.'
      : '';
  });
  const splitNote = el('div', 'cx-note');
  const splitRow = el('div', 'cx-inline-row');
  splitRow.append(splitBtn);

  // Ground-truth export. Deliberately a plain button with no options: the
  // useful thing is that whatever is on screen right now can be dropped into a
  // registration benchmark with its true deformation attached.
  // Space choice. Subject space is the default because it is what the samples
  // actually sit on; MNI152 rewrites only the header, so a normative connectome
  // or a published atlas can read the coordinates without anything being
  // resampled and without the ground-truth displacement losing exactness.
  const spaceRow = el('div', 'cx-inline-row');
  const spaceSelect = el('select', 'cx-select cx-inline');
  for (const [value, label] of [
    ['native', 'subject space (RAS)'],
    ['mni', 'MNI152 — for atlases / connectomes'],
  ]) {
    const o = el('option', undefined, label);
    o.value = value;
    spaceSelect.append(o);
  }
  spaceRow.append(spaceSelect);
  const spaceNote = el('div', 'cx-cite');
  const setSpaceNote = () => {
    spaceNote.textContent =
      spaceSelect.value === 'mni'
        ? 'Affine only (sform code 4). The voxel grid stays the subject’s — ' +
          'resample downstream if your pipeline needs an MNI grid.'
        : 'The grid the samples were computed on.';
  };
  setSpaceNote();
  spaceSelect.addEventListener('change', setSpaceNote);

  const exportBtn = el('button', 'cx-btn cx-wide', 'export NIfTI (ground truth)');
  const exportNote = el('div', 'cx-note');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'exporting…';
    try {
      const wantMni = spaceSelect.value === 'mni';
      const r = await brain.exportNifti(128, { mni: wantMni });
      // Report the space that was WRITTEN, not the one requested — a payload
      // with no MNI transform falls back to subject space, and the UI must not
      // paper over that.
      const grid = (r.provenance as { grid?: { space?: string } }).grid;
      exportNote.textContent =
        `${r.files.length} files, ${(r.bytes / 1e6).toFixed(0)} MB at ${r.dim}³ · ` +
        `${grid?.space ?? 'unknown space'} · ` +
        `max ground-truth displacement ${r.maxDisplacementMm.toFixed(2)} mm`;
    } catch (e) {
      exportNote.textContent = `export failed: ${String(e)}`;
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'export NIfTI (ground truth)';
    }
  });

  const ventBtn = el('button', 'cx-btn cx-wide', 'ventricles: off');
  let ventOn = false;
  ventBtn.addEventListener('click', () => {
    ventOn = !ventOn;
    brain.showVentricles(ventOn);
    ventBtn.textContent = `ventricles: ${ventOn ? 'on' : 'off'}`;
  });

  // Radiological slice view. Mutually exclusive with fisheye — one is an
  // orthographic cross-section, the other a >180° projection, and combining
  // them means nothing.
  const sliceAxis = el('select', 'cx-select');
  for (const a of ['3D view', 'sagittal slice', 'axial slice', 'coronal slice']) {
    sliceAxis.append(new Option(a, a));
  }
  sliceAxis.addEventListener('change', () => {
    const v = sliceAxis.value;
    if (v === '3D view') {
      brain.setSliceView(null);
      cutAxis.value = 'off';
      applyCut();
    } else {
      fisheyeRow.set(0);
      brain.setFisheye(false);
      const ax = v.split(' ')[0] as 'sagittal' | 'axial' | 'coronal';
      brain.setSliceView(ax, Number(cutOffset.input.value));
      cutAxis.value = ax;
    }
  });

  // Magic lens. Depth is the meaningful control — it is how deep the lens digs
  // into the tissue — so it drives the on/off state directly.
  const lensRow = slider('lens depth', {
    min: 0,
    max: 45,
    step: 1,
    value: 0,
    format: (v) => (v < 1 ? 'off' : `${v} mm`),
    onInput: (v) => brain.setLens(v >= 1, { depthMm: v }),
  });
  const lensMagRow = slider('lens zoom', {
    min: 1,
    max: 4,
    step: 0.1,
    value: 1.8,
    format: (v) => `${v.toFixed(1)}×`,
    onInput: (v) => brain.setLens(Number(lensRow.input.value) >= 1, { mag: v }),
  });
  const lensSizeRow = slider('lens size', {
    min: 0.1,
    max: 0.7,
    step: 0.01,
    value: 0.32,
    format: (v) => `${(v * 100) | 0}%`,
    onInput: (v) => brain.setLens(Number(lensRow.input.value) >= 1, { radius: v }),
  });

  const fisheyeRow = slider('fisheye', {
    min: 0,
    max: 170,
    step: 1,
    value: 0,
    format: (v) => (v < 1 ? 'off' : `${v}°`),
    onInput: (v) => {
      if (v < 1) {
        brain.setFisheye(false);
        return;
      }
      if (sliceAxis.value !== '3D view') {
        sliceAxis.value = '3D view';
        brain.setSliceView(null);
      }
      brain.setFisheye(true, (v * Math.PI) / 180);
    },
  });

  secView.body.append(
    modalitySel,
    modalityNote,
    modeRow.root,
    sliceAxis,
    splitRow,
    splitPos.root,
    splitNote
  );

  // Keyboard shortcuts used to be advertised only in the HUD legend, which is
  // now collapsed by default — so they became undiscoverable. A shortcut nobody
  // can find is a feature that does not exist, and the panel is where someone
  // looks for what a control does.
  const keysNote = el('div', 'cx-cite');
  keysNote.innerHTML =
    '<b>X</b> specimen ⇄ x-ray &nbsp; <b>V</b> ventricles &nbsp; <b>A</b> arteries';

  secNav.body.append(
    cutRowTop,
    cutOffset.root,
    lensRow.root,
    lensMagRow.root,
    lensSizeRow.root,
    fisheyeRow.root,
    ventBtn,
    keysNote
  );

  // ---- live volume readout -------------------------------------------------
  //
  // Debounced hard. The volumetry probe integrates the composed field and reads
  // back from the GPU, which is far heavier than the operator evaluation that
  // drives the sliders. Running it per input event would stall the drag; a
  // trailing debounce keeps the number honest at the cost of arriving late.
  let volumeTimer: number | undefined;
  let volumeBusy = false;
  function scheduleVolume() {
    window.clearTimeout(volumeTimer);
    volumeOut.classList.add('cx-stale');
    volumeTimer = window.setTimeout(() => void refreshVolume(), 420);
  }

  async function refreshVolume() {
    if (volumeBusy || !brain.measureSelection) return;
    volumeBusy = true;
    try {
      const r = await brain.measureSelection();
      if (!r) {
        volumeOut.textContent = '';
      } else {
        const sign = r.lossPct >= 0 ? '−' : '+';
        volumeOut.innerHTML =
          `<span class="cx-label">volume</span> ` +
          `${(r.currentMm3 / 1000).toFixed(1)} cm³ ` +
          `<span class="cx-dim">of</span> ${(r.baselineMm3 / 1000).toFixed(1)} cm³ ` +
          `<span class="${r.lossPct > 0.5 ? 'cx-loss' : 'cx-dim'}">` +
          `${sign}${Math.abs(r.lossPct).toFixed(1)}%</span>`;
      }
      volumeOut.classList.remove('cx-stale');

      // Rating scales ride on the same readback the volume readout just did —
      // they are arithmetic on the identical measurement, so they cost nothing
      // extra and must never disagree with the number above them.
      const scales = await brain.measureScales();
      if (scales) {
        scalesOut.innerHTML = scales
          .map(
            (s) =>
              `<div class="cx-scale" title="${esc(s.basis)} — ${esc(s.interpretation)}">` +
              `<span class="cx-label">${esc(s.key)}</span> ` +
              `<span class="${s.grade > 0 ? 'cx-loss' : 'cx-dim'}">${s.grade}</span>` +
              `<span class="cx-dim">/${s.max}</span> ` +
              `<span class="cx-dim">${esc(s.interpretation)}</span></div>`
          )
          .join('');
      }
      scalesOut.classList.remove('cx-stale');
    } finally {
      volumeBusy = false;
    }
  }

  secMeasure.body.append(volumeOut, scalesOut, aspectsOut, perfusionOut);
  secExport.body.append(spaceRow, spaceNote, exportBtn, exportNote);

  // Panel toggle.
  //
  // 290px of a 1280px viewport, permanently — with no way to see the anatomy
  // full width, which is exactly what you want when showing this to someone.
  // The button stays visible when the panel is hidden, or the controls become
  // unreachable; `H` does the same thing from the keyboard.
  const hideBtn = el('button', 'cx-hide', '›');
  hideBtn.title = 'Hide panel (H)';
  hideBtn.setAttribute('aria-label', 'Hide panel');
  const setHidden = (hidden: boolean) => {
    root.classList.toggle('cx-hidden', hidden);
    hideBtn.textContent = hidden ? '‹' : '›';
    hideBtn.title = hidden ? 'Show panel (H)' : 'Hide panel (H)';
    hideBtn.setAttribute('aria-label', hidden ? 'Show panel' : 'Hide panel');
  };
  hideBtn.addEventListener('click', () => setHidden(!root.classList.contains('cx-hidden')));
  window.addEventListener('keydown', (e) => {
    // Ignore while typing in the region search, or H becomes unusable there.
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'h' || e.key === 'H') setHidden(!root.classList.contains('cx-hidden'));
  });

  // Entry to teaching mode. Deliberately a LINK and not a tenth section: cases
  // are a different mode, not another parameter, and putting them in the panel
  // is exactly the clutter the mode split exists to avoid.
  const teachLink = el('a', 'cx-teach');
  teachLink.href = '#/teach';
  teachLink.textContent = 'Teaching cases →';
  teachLink.title = 'Guided cases — the panel is hidden so it cannot give the answer away';

  root.append(
    hideBtn,
    teachLink,
    evidenceKey,
    makeGroup('Subject'),
    secSubject.root,
    makeGroup('Disease'),
    secTime.root,
    secStroke.root,
    secRegion.root,
    makeGroup('Measure'),
    secMeasure.root,
    makeGroup('View'),
    secView.root,
    secNav.root,
    makeGroup('Data'),
    secPatient.root,
    secExport.root
  );

  // Initial state.
  applyHighlight();
  refreshNarrative();

  // Keep the transport button in step when playback ends on its own.
  let wasPlaying = false;
  window.setInterval(() => {
    const tl = brain.timeline();
    if (!tl.scenario) return;
    timeRow.set(tl.t);
    if (tl.playing) {
      refreshNarrative();
      // The readout is debounced, so during playback it settles only when the
      // timeline pauses or reaches the end — which is the honest behaviour: a
      // GPU volume integration cannot keep up with a 60 fps scrub.
      volumeOut.classList.add('cx-stale');
    } else {
      if (playBtn.textContent === '❚❚') playBtn.textContent = '▶';
      if (wasPlaying) scheduleVolume();
    }
    wasPlaying = tl.playing;
  }, 120);

  return root;
}
