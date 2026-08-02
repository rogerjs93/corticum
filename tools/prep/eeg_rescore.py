"""Re-score the projection's localisation with an atlas-independent gate.

An absolute electrode-to-centroid distance is a bad gate: it scales with parcel
SIZE. Desikan-Killiany parcels are roughly twice the area of Destrieux ones, so
the same projection scores 33 mm on one atlas and 37 mm on the other, and a
threshold tuned on one silently fails the other. That is a gate measuring the
atlas, not the model.

This asks a scale-free question instead: among all parcels in the same
hemisphere, how does the peak parcel's distance RANK? A meaningless projection
puts the peak at the 50th percentile. A working one puts it near the top.

Reads the matrix already written by eeg_forward.py, so it does not rebuild the
forward solution (which takes ~40 minutes).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import mne

mne.set_log_level('ERROR')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--proj', default='public/fields/eeg_proj.json')
    ap.add_argument('--subject', default='sample')
    args = ap.parse_args()

    doc = json.loads(Path(args.proj).read_text(encoding='utf-8'))
    M = np.array(doc['matrix'])
    channels = doc['channels']

    sd = mne.datasets.sample.data_path(download=False)
    subjects_dir = os.path.join(sd, 'subjects')
    src = mne.read_source_spaces(
        os.path.join(subjects_dir, args.subject, 'bem', f'{args.subject}-oct-6-src.fif'))
    trans = mne.read_trans(
        os.path.join(sd, 'MEG', args.subject, f'{args.subject}_audvis_raw-trans.fif'))
    labels = [l for l in mne.read_labels_from_annot(
        args.subject, parc='aparc', subjects_dir=subjects_dir, verbose=False)
        if 'unknown' not in l.name.lower()]

    montage = mne.channels.make_standard_montage('standard_1020')
    canon = {c.lower(): c for c in montage.ch_names}
    raw = mne.io.RawArray(
        np.zeros((len(channels), 2)),
        mne.create_info([canon[c.lower()] for c in channels], 500.0, 'eeg'),
        verbose=False)
    raw.set_montage(montage)
    pos = mne.transforms.apply_trans(
        trans, np.array([ch['loc'][:3] for ch in raw.info['chs']])) * 1000.0

    rr = {'lh': src[0]['rr'] * 1000.0, 'rh': src[1]['rr'] * 1000.0}
    cent, hemi = [], []
    for l in labels:
        h = 'lh' if l.name.endswith('-lh') else 'rh'
        cent.append(rr[h][l.vertices].mean(axis=0))
        hemi.append(h)
    cent, hemi = np.array(cent), np.array(hemi)

    rows, pcts, mismatches = [], [], []
    for j, ch in enumerate(channels):
        p = int(np.argmax(M[:, j]))
        # Re-run the hemisphere check on the SHIPPED (row-normalised) matrix.
        # eeg_forward.py scored the raw matrix and then normalised before
        # writing, and row scaling can move a column's argmax — so that report
        # was not describing the file the renderer loads.
        digits = [c for c in ch if c.isdigit()]
        want = None if not digits else ('lh' if int(digits[-1]) % 2 else 'rh')
        if want is not None and want != hemi[p]:
            mismatches.append(ch)
        d_all = np.linalg.norm(cent[hemi == hemi[p]] - pos[j], axis=1)
        d_peak = float(np.linalg.norm(cent[p] - pos[j]))
        # Fraction of same-hemisphere parcels the peak beats. 1.0 = nearest.
        pct = float((d_all > d_peak).mean())
        pcts.append(pct)
        rows.append({'channel': ch, 'peak': labels[p].name,
                     'distanceMm': round(d_peak, 1),
                     'nearerThanFraction': round(pct, 3)})

    pcts = np.array(pcts)
    gate = {
        'medianPercentile': round(float(np.median(pcts)), 3),
        'worstPercentile': round(float(pcts.min()), 3),
        'chanceLevel': 0.5,
        'pass': bool(np.median(pcts) >= 0.8 and pcts.min() >= 0.5),
        'note': 'fraction of same-hemisphere parcels FURTHER from the electrode '
                'than the peak parcel; 0.5 is chance, 1.0 is the nearest parcel. '
                'Scale-free, so it measures the projection and not the atlas.',
    }

    for r in sorted(rows, key=lambda r: r['nearerThanFraction'])[:5]:
        print(f"  {r['channel']:>4} {r['peak']:<28} {r['distanceMm']:5.1f} mm  "
              f"pct {r['nearerThanFraction']:.2f}")
    print(f"median percentile {gate['medianPercentile']}, "
          f"worst {gate['worstPercentile']} -> {'PASS' if gate['pass'] else 'FAIL'}")

    hemi_gate = {
        'lateralChannels': sum(1 for c in channels if any(d.isdigit() for d in c)),
        'mismatches': mismatches,
        'pass': not mismatches,
        'note': 'every lateral electrode must peak in its own hemisphere, '
                'scored on the shipped row-normalised matrix',
    }
    print(f"hemisphere mismatches on shipped matrix: {len(mismatches)} {mismatches}")

    doc['gates']['distance'].pop('pass', None)
    doc['gates']['distance']['note'] += (
        ' NOT a gate: it scales with parcel size. See proximityRank.')
    doc['gates']['proximityRank'] = gate
    doc['gates']['hemisphereAgreement'] = hemi_gate
    doc['localisation'] = rows
    Path(args.proj).write_text(json.dumps(doc, indent=1), encoding='utf-8')
    print(f'updated {args.proj}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
