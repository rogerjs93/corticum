"""Turn stroke_qeeg's free-text StrokeLocation into model parameters.

The dataset records lesion location as clinician prose — "Left pons",
"Right temporo-parietal occipital lobe and insula, Right basal ganglia,
Right paraventricular". This maps each clause onto an occlusion site that the
renderer can actually produce, plus the side.

Two things worth knowing about this cohort before reading the map:

1. It is dominated by SMALL-VESSEL and BRAINSTEM strokes — 16 of 50 are pontine,
   and basal ganglia / paraventricular / corona radiata account for most of the
   rest. Large-vessel cortical syndromes are the minority. That is typical of a
   qEEG stroke series and it is why `lsa` and `thalamoperf` (isolated perforator
   occlusions) had to exist before this script could say anything useful.

2. Several terms name a WATERSHED or PERIVENTRICULAR region rather than an
   arterial territory — "paraventricular", "centrum semiovale", "inner
   watershed". These are small-vessel disease, not a named large-vessel
   occlusion, so the mapping is genuinely approximate and every one of them is
   flagged `approximate` so the UI can say so.

Emits public/fields/presets.json. Nothing here touches the GPU.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

# Location keyword -> (occlusion site id, approximate?, why)
#
# Keys are STEMS, because the prose uses combining forms: "fronto-parietal
# temporo-occipital lobe" names four lobes but contains neither "frontal" nor
# "temporal". Matching is longest-key-first and each match is REMOVED from the
# clause, so "subparietal" cannot also fire "pariet".
#
# A clause is scanned for EVERY key, not just the first. One phrase routinely
# names a lesion spanning several territories, and picking whichever key happened
# to match first put a near-hemispheric infarct on the PCA alone.
LOCATION_MAP: list[tuple[str, str, bool, str]] = [
    ('medulla', 'pica', False, 'lateral medulla is PICA territory (Wallenberg)'),
    ('cerebell', 'pica', False, 'cerebellar hemisphere'),
    ('centrum semiovale', 'lsa', True,
     'watershed white matter, not a named large-vessel territory'),
    ('corona radiata', 'lsa', False, 'lenticulostriate perforator territory'),
    ('internal capsule', 'lsa', False, 'posterior limb, perforator territory'),
    ('basal ganglia', 'lsa', False, 'striatum and pallidum'),
    ('paraventricular', 'lsa', True,
     'periventricular white matter is small-vessel / borderzone territory'),
    ('watershed', 'lsa', True, 'internal borderzone, not a single territory'),
    ('subcortical', 'lsa', True, 'unspecified deep white matter'),
    ('thalam', 'thalamoperf', False, 'thalamoperforator territory'),
    ('pons', 'basilar', False, 'basilar perforators'),
    ('insula', 'm1', False, 'insular cortex is proximal MCA'),
    ('occipit', 'pca', False, 'PCA cortical territory'),
    ('subparietal', 'm2sup', True, 'medial parietal, ACA/MCA border'),
    ('subfrontal', 'aca', True, 'orbitofrontal, ACA/MCA border'),
    ('pariet', 'm2sup', False, 'MCA superior division'),
    ('tempor', 'm2inf', False, 'MCA inferior division'),
    ('front', 'm2sup', False, 'MCA superior division'),
    ('lateral ventricle', '', True, 'CSF space, not parenchyma — ignored'),
]
LOCATION_MAP.sort(key=lambda e: -len(e[0]))

# The only site whose territory is genuinely midline, so "side not stated" is not
# an approximation there — the model infarcts both sides by anatomy.
BILATERAL_SITES = {'basilar'}

SIDE_RE = re.compile(r'\b(left|right|bilateral)\b', re.IGNORECASE)


def parse_location(text: str) -> tuple[list[dict], list[str]]:
    """Return (lesions, unmapped clauses)."""
    lesions: list[dict] = []
    unmapped: list[str] = []
    # Clauses are comma-separated, and "X and Y" inside a clause names two places.
    clauses = [c.strip() for c in re.split(r',|\band\b', text) if c.strip()]

    inherited: str | None = None
    for clause in clauses:
        low = clause.lower()
        m = SIDE_RE.search(low)
        if m:
            inherited = m.group(1).lower()
        # A clause with no side of its own inherits the previous one, which is
        # how "Right paraventricular, Right basal ganglia" and the sloppier
        # "Right cerebellum,bilateral occipital lobes" both read correctly.
        side = inherited

        # Collect every territory the clause names, consuming each match so a
        # stem cannot fire twice through an overlapping longer term.
        rest = low
        hits: list[tuple[str, bool, str]] = []
        recognised = False
        for keyword, site, approx, why in LOCATION_MAP:
            if keyword in rest:
                rest = rest.replace(keyword, ' ')
                recognised = True
                if site:
                    hits.append((site, approx, why))
        if not hits:
            # A clause that matched a keyword with no site (a CSF space) was
            # deliberately dropped; only genuinely unrecognised prose is a gap.
            if not recognised:
                unmapped.append(clause)
            continue

        # One phrase naming several lobes is a large infarct crossing territory
        # boundaries; no single occlusion site reproduces it, so say so.
        spans = len({h[0] for h in hits}) > 1
        for site, approx, why in hits:
            bilateral = site in BILATERAL_SITES
            unsided = side is None and not bilateral
            sides = ['left', 'right'] if side == 'bilateral' else [side or 'left']
            reasons = [why]
            if spans:
                reasons.append('clause spans more than one arterial territory')
            if unsided:
                reasons.append('side not stated, assumed left')
            for s in sides:
                entry = {
                    'site': site,
                    'side': s,
                    'approximate': approx or unsided or spans,
                    'from': clause,
                    'why': '; '.join(reasons),
                }
                if entry not in lesions:
                    lesions.append(entry)
    return lesions, unmapped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--tsv', default=r'E:\Roger\projects data\stroke_qeeg\data\participants.tsv')
    ap.add_argument('--out', default='public/fields/presets.json')
    args = ap.parse_args()

    rows = list(csv.DictReader(Path(args.tsv).open(encoding='utf-8'), delimiter='\t'))
    presets = []
    unmapped_all: list[str] = []
    for r in rows:
        lesions, unmapped = parse_location(r['StrokeLocation'])
        unmapped_all.extend(unmapped)
        presets.append({
            'id': r['Participant_ID'],
            'age': int(r['Age']),
            'gender': r['Gender'],
            'durationMonths': int(r['Duration']),
            'paralysisSide': r['ParalysisSide'],
            'handedness': r['Handedness'],
            'location': r['StrokeLocation'],
            'nihss': int(r['NIHSS']),
            'mbi': int(r['MBI']),
            'mrs': int(r['mRS']),
            'lesions': lesions,
        })

    # GATE. The corticospinal tract decussates, so a unilateral lesion must be
    # CONTRALATERAL to the recorded weakness. This scores the side parsed out of
    # the StrokeLocation prose against the ParalysisSide column, which the
    # parser never reads — an independent check on the one field most likely to
    # be silently reversed, and the kind of error no amount of eyeballing the
    # render would catch. Brainstem lesions are excluded: the pons is at or
    # above the decussation and pontine syndromes are not reliably crossed.
    scored = crossed = 0
    exceptions = []
    for p in presets:
        sides = {l['side'] for l in p['lesions'] if l['site'] != 'basilar'}
        par = p['paralysisSide'].strip().lower()
        if len(sides) != 1 or par not in ('left', 'right'):
            continue
        scored += 1
        if sides.pop() != par:
            crossed += 1
        else:
            exceptions.append(p['id'])
    gate = {
        'scored': scored,
        'contralateral': crossed,
        'exceptions': exceptions,
        'pass': scored > 0 and not exceptions,
        'note': 'a unilateral lesion must be contralateral to the recorded '
                'paralysis; scores parsed StrokeLocation against the untouched '
                'ParalysisSide column',
    }
    print(f'laterality gate: {crossed}/{scored} contralateral '
          f'-> {"PASS" if gate["pass"] else "FAIL " + str(exceptions)}')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        'lateralityGate': gate,
        'source': 'stroke_qeeg participants.tsv',
        'n': len(presets),
        'evidence': 'plausible-approximation',
        'limitation':
            'Lesion locations are clinician free text mapped onto the nearest '
            'occlusion site this model can produce. Entries marked approximate '
            'name a watershed or periventricular region rather than a single '
            'arterial territory. No imaging was consulted.',
        'presets': presets,
    }, indent=1), encoding='utf-8')

    n_les = sum(len(p['lesions']) for p in presets)
    n_appr = sum(1 for p in presets for l in p['lesions'] if l['approximate'])
    covered = sum(1 for p in presets if p['lesions'])
    print(f'{len(presets)} patients -> {n_les} lesions ({n_appr} approximate)')
    print(f'patients with at least one mapped lesion: {covered}/{len(presets)}')
    if unmapped_all:
        print(f'UNMAPPED clauses ({len(unmapped_all)}):')
        for u in sorted(set(unmapped_all)):
            print(f'  - {u!r}')
    print(f'wrote {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
