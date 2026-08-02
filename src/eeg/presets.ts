/**
 * Patient presets derived from stroke_qeeg's `participants.tsv`.
 *
 * The free-text StrokeLocation is parsed offline by `tools/prep/eeg_presets.py`
 * — in Python, next to the data, where the keyword map can be inspected and the
 * unmapped-clause count printed — rather than at runtime. This module only
 * loads the result.
 */

export interface PresetLesion {
  site: string;
  side: 'left' | 'right';
  /** True where the record names a watershed region, spans several territories, or omits the side. */
  approximate: boolean;
  from: string;
  why: string;
}

export interface PatientPreset {
  id: string;
  age: number;
  gender: string;
  durationMonths: number;
  paralysisSide: string;
  handedness: string;
  location: string;
  nihss: number;
  mbi: number;
  mrs: number;
  lesions: PresetLesion[];
}

export interface PresetDoc {
  source: string;
  n: number;
  limitation: string;
  presets: PatientPreset[];
}

export async function loadPresets(base: string): Promise<PresetDoc | null> {
  try {
    const r = await fetch(`${base}fields/presets.json`);
    if (!r.ok) return null;
    return (await r.json()) as PresetDoc;
  } catch {
    // Optional layer: the renderer must start without it.
    return null;
  }
}
