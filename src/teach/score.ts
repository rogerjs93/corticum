import { OCCLUSION_SITES, territoryOf, type TerritoryId } from '../disease/territories';
import type { DiseaseState } from '../disease/types';
import type { RegionMeta } from '../fields/loader';
import type { Scored } from './types';

/**
 * Score a `pick-region` answer.
 *
 * **Nothing here reads an answer key.** The affected territories come from the
 * SAME `OCCLUSION_SITES` table the stroke operator starves, and the side gate
 * is the same midline rule the shader applies — so the case and the render
 * cannot disagree about what is infarcted. A stored "correct: mcaSuperior"
 * would be a second source of truth, and the copy that goes stale is always the
 * one nobody re-checks.
 *
 * Note the signature: it takes the STATE and not the CASE. That is the design
 * working rather than an oversight — there is nothing in a case for a scorer to
 * read, because a case holds no answer.
 *
 * Known limit, worth naming rather than hiding: this resolves the clicked
 * PARCEL through the territory lookup. It does not sample the core mask at the
 * clicked voxel, so a parcel straddling the infarct edge scores as fully inside.
 * A voxel-level probe would be stronger and is the obvious next step; it needs
 * a GPU readback at an arbitrary point, which `pick-region` does not currently do.
 */
export function scorePickRegion(
  state: DiseaseState,
  region: RegionMeta | null,
  worldX: number
): Scored {
  if (!region) {
    return { grade: 'none', summary: 'No region under that click — try the cortical surface.' };
  }

  const site = OCCLUSION_SITES.find((s) => s.id === state.stroke.site);
  if (!site) {
    return { grade: 'none', summary: 'No occlusion in this case.' };
  }

  const affected = new Set<TerritoryId>(site.affects.map((a) => a.territory));
  const picked = territoryOf(region.fsLabel);
  const inTerritory = affected.has(picked);

  // World X is Right, so left is x < 0 — the same spatial midline gate the
  // stroke operator uses. Laterality is checked SEPARATELY from territory
  // because getting the syndrome right and the side wrong is the classic
  // error, and it is one this project has itself shipped: an M1 occlusion
  // once infarcted both hemispheres and still scored Dice 0.948.
  const pickedSide = worldX >= 0 ? 'right' : 'left';
  const correctSide = site.bilateral ? pickedSide : state.stroke.side;
  const sideOk = pickedSide === correctSide;

  const where = `${region.name} (${picked})`;

  if (inTerritory && sideOk) {
    return {
      grade: 'full',
      summary: `${where} is inside the infarcted territory, on the affected side.`,
    };
  }
  if (inTerritory && !sideOk) {
    return {
      grade: 'partial',
      summary:
        `${where} is the right territory but the WRONG hemisphere. The deficit ` +
        `is contralateral to the lesion — that is the single most common way to ` +
        `get this backwards.`,
    };
  }
  return {
    grade: 'none',
    summary: `${where} is outside the infarcted territory.`,
  };
}
