import { OCCLUSION_SITES, TERRITORY_INFO, territoryOf } from '../disease/territories';
import { CASES } from './cases';
import type { Case } from './types';

/**
 * The leak gate: a case must not give away its own answer.
 *
 * This has to be automated, because an author cannot self-check it. They
 * already know the answer, so they do not notice it sitting on screen — the
 * same blindness as a verification path that derives its truth from the table
 * the model uses (#39).
 *
 * Two ways a case leaks:
 *
 *   1. TEXT — the stem or prompt names the artery, the territory or the side.
 *   2. AFFORDANCE — a granted control displays it. `arteries` draws the
 *      occluded tree; `time` scrubs back to the uninfarcted brain; `split`
 *      shows the healthy counterfactual beside the diseased one.
 *
 * Run from the console: `await __corticum.verifyCases()`.
 */

/** Controls that would reveal a stroke answer outright if granted. */
const REVEALING: Record<string, string> = {
  arteries: 'draws the occluded arterial tree, naming the vessel',
  time: 'scrubbing to onset shows the brain before the infarct',
  split: 'shows the healthy counterfactual beside the diseased brain',
};

function answerWords(c: Case): string[] {
  const stroke = c.state.stroke;
  if (!stroke?.enabled) return [];

  const site = OCCLUSION_SITES.find((s) => s.id === stroke.site);
  const words = new Set<string>();

  if (site) {
    // The site name, and each word of it long enough to be a giveaway.
    for (const w of site.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3) words.add(w);
    }
    for (const a of site.affects) {
      const info = TERRITORY_INFO.find((t) => t.id === a.territory);
      if (info) {
        for (const w of info.name.toLowerCase().split(/[^a-z0-9]+/)) {
          if (w.length >= 4) words.add(w);
        }
      }
    }
  }
  return [...words];
}

/**
 * The side, but only where it is ATTACHED to a vessel or territory.
 *
 * A bare word match on "left"/"right" is useless: a stroke vignette must
 * describe lateralised signs — weakness down the left, gaze driven to the
 * right — and those are the INPUT to the reasoning, not the answer. Flagging
 * them would make every honest case fail and train the author to delete the
 * clinical detail that makes the case worth doing.
 *
 * What is a leak is the side welded to the anatomy: "right MCA", "left middle
 * cerebral". So look for the side within a short distance of a vascular term.
 */
function sideLeak(c: Case, haystack: string): string | null {
  const stroke = c.state.stroke;
  if (!stroke?.enabled) return null;
  const vessel = '(mca|aca|pca|middle cerebral|anterior cerebral|posterior cerebral|basilar|lenticulostriate)';
  const re = new RegExp(`\\b${stroke.side}\\b[\\s\\-]*(\\w+[\\s\\-]+){0,2}${vessel}`, 'i');
  const reRev = new RegExp(`${vessel}[\\s\\-]*(\\w+[\\s\\-]+){0,2}\\b${stroke.side}\\b`, 'i');
  const m = haystack.match(re) ?? haystack.match(reRev);
  return m ? `side attached to vessel: "${m[0].trim()}"` : null;
}

export interface CaseAudit {
  id: string;
  pass: boolean;
  textLeaks: string[];
  affordanceLeaks: string[];
  hasEvidence: boolean;
  scorerSane: boolean;
}

/**
 * Audit every case. `visible` supplies the text a mounted case puts on screen;
 * when omitted the stem and prompt are used, which is what a case controls.
 */
export function auditCases(visible?: (c: Case) => string): CaseAudit[] {
  return CASES.map((c) => {
    const haystack = (visible ? visible(c) : `${c.stem} ${c.task.prompt}`).toLowerCase();
    const textLeaks = answerWords(c).filter((w) => new RegExp(`\\b${w}\\b`).test(haystack));
    const side = sideLeak(c, haystack);
    if (side) textLeaks.push(side);
    const affordanceLeaks = c.allow.filter((a) => a in REVEALING).map((a) => `${a}: ${REVEALING[a]}`);

    // A scorer that says "full" for everything would pass every other check
    // while teaching nothing, so prove it can also say no. Cheap and it caught
    // nothing today, which is the point of running it before it can.
    const site = OCCLUSION_SITES.find((s) => s.id === c.state.stroke?.site);
    const affected = new Set(site?.affects.map((a) => a.territory) ?? []);
    const scorerSane =
      affected.size > 0 && TERRITORY_INFO.some((t) => t.id !== 0 && !affected.has(t.id));

    return {
      id: c.id,
      textLeaks,
      affordanceLeaks,
      hasEvidence: !!c.evidence && c.because.trim().length > 0,
      scorerSane,
      pass:
        textLeaks.length === 0 &&
        affordanceLeaks.length === 0 &&
        !!c.evidence &&
        c.because.trim().length > 0 &&
        scorerSane,
    };
  });
}

/** Sanity: the territory lookup must actually discriminate. */
export function territorySanity(): { distinct: number; ok: boolean } {
  const seen = new Set<number>();
  for (let label = 1000; label <= 1035; label++) seen.add(territoryOf(label));
  return { distinct: seen.size, ok: seen.size > 1 };
}
