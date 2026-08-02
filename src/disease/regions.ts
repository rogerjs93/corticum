import type { RegionMeta } from '../fields/loader';

/**
 * Per-region modifiers layered on top of whatever the active diseases assign.
 *
 * The composition is:
 *
 *     atrophy[r] = ( braak[r] + ftd[r] + ... ) * vulnerability[r] + override[r]
 *
 * The two halves answer different questions and both are worth having:
 *
 *   * `vulnerability` scales what the disease already does to a region, so it
 *     asks "what if this patient's hippocampus were twice as vulnerable?" and
 *     composes with staging. It cannot invent atrophy in a region the disease
 *     does not touch, which keeps the result anatomically coherent.
 *   * `override` adds atrophy directly in millimetres, ignoring staging. Useful
 *     for free exploration and for building teaching examples that no single
 *     named disease produces.
 */
export class RegionModifiers {
  private vulnerability = new Map<number, number>();
  private override = new Map<number, number>();

  private byLabel: Map<number, RegionMeta>;
  private byName: Map<string, RegionMeta>;

  constructor(private regions: RegionMeta[]) {
    this.byLabel = new Map(regions.map((r) => [r.fsLabel, r]));
    this.byName = new Map(regions.map((r) => [r.name.toLowerCase(), r]));
  }

  /** Resolve a FreeSurfer label id, a region name, or a dense index. */
  resolve(key: number | string): RegionMeta | null {
    if (typeof key === 'number') {
      return this.byLabel.get(key) ?? this.regions[key] ?? null;
    }
    const k = key.toLowerCase();
    const exact = this.byName.get(k);
    if (exact) return exact;
    return this.regions.find((r) => r.name.toLowerCase().includes(k)) ?? null;
  }

  /**
   * Every region belonging to a named group.
   *
   * Groups come from regions.json, which carries a lobe, a Yeo-2011 network and
   * a hemisphere per region — so "default mode network" or "frontal" or
   * "left" all work, and can be combined by intersecting the results.
   */
  group(kind: 'lobe' | 'network' | 'hemisphere' | 'tissue', value: string): RegionMeta[] {
    const v = value.toLowerCase();
    return this.regions.filter((r) => {
      if (kind === 'lobe') return r.lobe.toLowerCase() === v;
      if (kind === 'network') return r.network.toLowerCase() === v;
      if (kind === 'hemisphere') return r.hemisphere.toLowerCase() === v;
      return String(r.tissue) === v;
    });
  }

  /** Distinct values available for a grouping, with member counts. */
  groups(kind: 'lobe' | 'network' | 'hemisphere'): Array<{ value: string; count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.regions) {
      const v = kind === 'lobe' ? r.lobe : kind === 'network' ? r.network : r.hemisphere;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
  }

  setVulnerability(key: number | string, factor: number): boolean {
    const r = this.resolve(key);
    if (!r) return false;
    if (factor === 1) this.vulnerability.delete(r.index);
    else this.vulnerability.set(r.index, factor);
    return true;
  }

  setOverride(key: number | string, mm: number): boolean {
    const r = this.resolve(key);
    if (!r) return false;
    if (mm === 0) this.override.delete(r.index);
    else this.override.set(r.index, mm);
    return true;
  }

  /** Apply a modifier to every member of a group; returns how many matched. */
  setGroupVulnerability(
    kind: 'lobe' | 'network' | 'hemisphere',
    value: string,
    factor: number
  ): number {
    const members = this.group(kind, value);
    for (const r of members) this.setVulnerability(r.fsLabel, factor);
    return members.length;
  }

  setGroupOverride(
    kind: 'lobe' | 'network' | 'hemisphere',
    value: string,
    mm: number
  ): number {
    const members = this.group(kind, value);
    for (const r of members) this.setOverride(r.fsLabel, mm);
    return members.length;
  }

  getVulnerability(index: number): number {
    return this.vulnerability.get(index) ?? 1;
  }

  getOverride(index: number): number {
    return this.override.get(index) ?? 0;
  }

  /** Regions the user has touched, for the UI to list. */
  modified(): Array<{ region: RegionMeta; vulnerability: number; overrideMm: number }> {
    const touched = new Set([...this.vulnerability.keys(), ...this.override.keys()]);
    return [...touched]
      .map((i) => this.regions[i])
      .filter(Boolean)
      .map((region) => ({
        region,
        vulnerability: this.getVulnerability(region.index),
        overrideMm: this.getOverride(region.index),
      }));
  }

  clear(): void {
    this.vulnerability.clear();
    this.override.clear();
  }

  get isEmpty(): boolean {
    return this.vulnerability.size === 0 && this.override.size === 0;
  }
}
