import type { DiseaseState } from '../disease/types';

/**
 * Teaching mode types. Design and rationale: `docs/teaching-mode.md`.
 *
 * The rule this file exists to enforce: **a case stores how to MEASURE its
 * answer, never the answer itself.** An authored key is a second source of
 * truth, and when the two disagree the wrong one is always the one nobody
 * re-checks — the same failure as the side-blind territory gate that scored
 * Dice 0.948 while infarcting both hemispheres.
 */

/**
 * What the learner is allowed to do during a case. Default is DENY: some
 * controls ARE the answer, and a case that grants everything leaks silently,
 * because the author already knows the answer and will not notice it on screen.
 */
export type Affordance =
  | 'rotate'
  | 'zoom'
  | 'pick'
  | 'xray'
  | 'lens'
  | 'modality'
  | 'slice'
  | 'time'
  | 'split'
  | 'arteries';

/**
 * A task the learner performs on the tool itself, rather than choosing from a
 * list. Answering by doing is the reason to teach on this rather than on
 * slides, and the simulator can score it because it knows what is true.
 */
export type Task = {
  kind: 'pick-region';
  prompt: string;
  /**
   * How to score, NOT what the answer is. `infarct-territory` resolves the
   * clicked parcel through the same territory lookup and side gate the stroke
   * operator uses, so the case and the render cannot disagree about what is
   * infarcted.
   */
  measure: 'infarct-territory';
};

export type Grade = 'full' | 'partial' | 'none';

export interface Scored {
  grade: Grade;
  /** Shown to the learner. Must describe what was MEASURED, not a stored key. */
  summary: string;
}

export interface Case {
  id: string;
  /** Short label for the library listing. Must not name the answer either. */
  title: string;
  /** Clinical vignette. Prose only — never names the answer. */
  stem: string;
  /** The parameters that produce this brain. Reuses the renderer's own type. */
  state: Partial<DiseaseState>;
  allow: Affordance[];
  task: Task;
  /**
   * Why the answer is what it is, shown after the learner commits. Every
   * clinical claim carries an evidence tag, same rule as the parameter panel.
   */
  because: string;
  evidence: 'literature' | 'derived' | 'plausible-approximation';
  cite?: string;
}
