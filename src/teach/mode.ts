import type { BrainScene } from '../scene/brainScene';
import { OCCLUSION_SITES } from '../disease/territories';
import { scorePickRegion } from './score';
import type { Affordance, Case, Scored } from './types';

/**
 * Teaching mode shell. Design: `docs/teaching-mode.md`.
 *
 * This is a MODE, not a panel section, for one reason: the parameter panel is
 * the answer key. A case asking which vessel is occluded is already answered by
 * a dropdown reading "MCA — M1 (proximal)", and Measurements prints ASPECTS.
 * The caller must not build the panel when this is mounted.
 */

/** Keyboard shortcuts the renderer binds globally, and the affordance each needs. */
const KEY_AFFORDANCE: Record<string, Affordance> = {
  x: 'xray',
  v: 'xray', // ventricle mesh rides with the x-ray/inspection affordance
  a: 'arteries',
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

/**
 * Block the renderer's global shortcuts that this case does not grant.
 *
 * Capture phase with `stopImmediatePropagation`, because `brainScene` binds its
 * handlers on `window` too and we need to win before them. Without this a case
 * that withholds `arteries` still leaks: pressing A draws the occluded tree and
 * names the answer outright.
 */
function gateShortcuts(allow: Affordance[]): () => void {
  const granted = new Set(allow);
  const onKey = (e: KeyboardEvent) => {
    const need = KEY_AFFORDANCE[e.key.toLowerCase()];
    if (need && !granted.has(need)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

/**
 * Controls for the affordances a case GRANTS.
 *
 * `allow` used to only remove things — it blocked shortcuts — so a case could
 * grant `slice` or `modality` and the learner still had no way to use them,
 * because the panel that normally provides those controls is suppressed. That
 * made every deep case unanswerable: `pick-region` hits the first surface, so
 * reaching the lentiform means cutting into the brain first.
 *
 * Only granted affordances render. Nothing here may display the answer.
 */
function buildControls(brain: BrainScene, allow: Affordance[]): HTMLElement | null {
  const granted = new Set(allow);
  const bar = el('div', 'tm-controls');
  let any = false;

  if (granted.has('slice')) {
    any = true;
    const row = el('div', 'tm-crow');
    row.append(el('span', 'tm-clabel', 'cut'));

    // The offset only means something once a plane is chosen, so it stays
    // disabled in 3D rather than silently doing nothing.
    const offset = el('input', 'tm-slider');
    offset.type = 'range';
    offset.min = '-70';
    offset.max = '70';
    offset.step = '1';
    offset.value = '0';
    offset.disabled = true;

    let axis: 'sagittal' | 'axial' | 'coronal' | null = null;
    const buttons: HTMLButtonElement[] = [];
    const apply = () => {
      brain.setSliceView(axis, Number(offset.value));
      offset.disabled = axis === null;
      for (const b of buttons) b.classList.toggle('tm-on', b.dataset.axis === (axis ?? '3d'));
    };

    for (const [key, label] of [
      ['3d', '3D'],
      ['axial', 'axial'],
      ['coronal', 'coronal'],
      ['sagittal', 'sagittal'],
    ] as const) {
      const b = el('button', 'tm-btn', label);
      b.dataset.axis = key;
      b.addEventListener('click', () => {
        axis = key === '3d' ? null : (key as 'sagittal' | 'axial' | 'coronal');
        apply();
      });
      buttons.push(b);
      row.append(b);
    }
    offset.addEventListener('input', apply);
    bar.append(row, offset);
    apply();
  }

  if (granted.has('modality')) {
    any = true;
    const row = el('div', 'tm-crow');
    row.append(el('span', 'tm-clabel', 'sequence'));
    for (const [key, label] of [
      ['anatomic', 'anatomic'],
      ['t1', 'T1'],
      ['t2', 'T2'],
      ['flair', 'FLAIR'],
      ['dwi', 'DWI'],
      ['ct', 'CT'],
    ] as const) {
      const b = el('button', 'tm-btn', label);
      b.addEventListener('click', () => {
        brain.setModality(key as Parameters<BrainScene['setModality']>[0]);
        for (const other of row.querySelectorAll('.tm-btn')) other.classList.remove('tm-on');
        b.classList.add('tm-on');
      });
      if (key === 'anatomic') b.classList.add('tm-on');
      row.append(b);
    }
    bar.append(row);
  }

  return any ? bar : null;
}

export interface TeachHandle {
  root: HTMLElement;
  dispose: () => void;
  /** Exposed for the leak gate: every string this case puts on screen. */
  visibleText: () => string;
  /** Exposed for the leak gate and for tests: score a click without a mouse. */
  submitPick: (worldX: number, region: Parameters<typeof scorePickRegion>[1]) => Scored;
}

export function mountCase(brain: BrainScene, c: Case): TeachHandle {
  const root = el('div', 'tm-root');

  const stem = el('div', 'tm-stem');
  stem.textContent = c.stem;

  const prompt = el('div', 'tm-prompt');
  prompt.textContent = c.task.prompt;

  const feedback = el('div', 'tm-feedback');
  const reveal = el('div', 'tm-reveal');
  reveal.hidden = true;

  const controls = buildControls(brain, c.allow);
  root.append(stem, prompt, ...(controls ? [controls] : []), feedback, reveal);

  let answered = false;

  const showReveal = (s: Scored) => {
    // Ground truth is MEASURED from the running model, not read from the case.
    const site = OCCLUSION_SITES.find((x) => x.id === brain.disease.stroke.site);
    const truth = site
      ? `${site.name}, ${brain.disease.stroke.side} side — ${site.note}`
      : 'no occlusion';

    reveal.textContent = '';
    const head = el(
      'div',
      `tm-grade tm-${s.grade}`,
      s.grade === 'full' ? 'Correct' : s.grade === 'partial' ? 'Partly right' : 'Not this one'
    );
    const what = el('div', 'tm-line', s.summary);
    const truthLine = el('div', 'tm-line');
    truthLine.innerHTML = `<b>Actually simulated:</b> ${truth}`;
    const why = el('div', 'tm-line', c.because);
    const tag = el('div', 'tm-cite', `${c.evidence}${c.cite ? ' · ' + c.cite : ''}`);

    reveal.append(head, what, truthLine, why, tag);
    reveal.hidden = false;
  };

  const submitPick: TeachHandle['submitPick'] = (worldX, region) => {
    const s = scorePickRegion(brain.disease, region, worldX);
    if (!answered) {
      answered = true;
      showReveal(s);
    }
    return s;
  };

  // Live picking, only if the case grants it.
  if (c.allow.includes('pick')) {
    brain.onPick((p) => {
      if (answered) return;
      if (!p.hit) {
        feedback.textContent = 'No surface there — click the cortical surface.';
        return;
      }
      // Material space, not world: mass effect can displace tissue across the
      // midline, and the question is which hemisphere the tissue came FROM.
      submitPick(p.material[0], p.region);
    });
  }

  const ungate = gateShortcuts(c.allow);

  return {
    root,
    dispose: () => {
      ungate();
      root.remove();
    },
    visibleText: () => root.innerText,
    submitPick,
  };
}
