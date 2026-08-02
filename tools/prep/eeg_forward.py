"""Build the EEG -> cortex projection matrix.

Emits `public/fields/eeg_proj.json`: one row per Desikan-Killiany cortical parcel,
one column per 10-20 channel, so the browser can turn 29 scalp band-power numbers
into a value per cortical region with a single matrix multiply.

WHY DESIKAN-KILLIANY AND NOT DESTRIEUX. The plan called for the 152-parcel
Destrieux atlas plus a new per-voxel `patch_index` field. Two measurements argued
against it. First, the localisation check at the bottom of this script puts the
median electrode-to-parcel distance at ~33 mm — 148 parcels is far finer than
that supports, and rendering a resolution the method does not have is precisely
the dishonesty the evidence tags exist to prevent. Second, the renderer already
ships a DK label field and already has a per-region uniform-array path (the
selection highlight and the atrophy LUT both use it), so DK costs no new payload,
no new upload and no new shader.

WHY THE SUBJECT IS `sample`. fsaverage as installed here has only a source space
and no BEM surfaces, so it cannot produce a forward solution without a download.
`sample` ships a full 3-layer BEM, its own head co-registration, and its own
aparc — and it is already corticum's default rendered subject, so the EEG model
and the anatomy on screen are the same individual. No morphing, no template head,
no download.

WHAT THIS IS NOT. The matrix is a linear map from scalp band power to cortical
regions through an inverse operator. It is NOT a source-power reconstruction:
band power discards phase, so the cross-channel covariance a real source
estimate needs is simply not available at runtime. Treat it as an
anatomically-weighted projection of the scalp topography onto cortex.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import mne

mne.set_log_level('ERROR')

# The 29 EEG channels in stroke_qeeg (HEOL/VEOR are EOG and excluded).
CHANNELS = ('FP1 FP2 Fz F3 F4 F7 F8 FCz FC3 FC4 FT7 FT8 Cz C3 C4 T3 T4 '
            'CP3 CP4 TP7 TP8 Pz P3 P4 T5 T6 Oz O1 O2').split()


def build(subject: str, subjects_dir: str, trans: str, bem: str, src_path: str):
    montage = mne.channels.make_standard_montage('standard_1020')
    # standard_1020 spells the frontopolar pair Fp1/Fp2; the dataset uses FP1/FP2.
    canon = {c.lower(): c for c in montage.ch_names}
    missing = [c for c in CHANNELS if c.lower() not in canon]
    if missing:
        raise SystemExit(f'channels not in standard_1020: {missing}')
    resolved = [canon[c.lower()] for c in CHANNELS]

    raw = mne.io.RawArray(np.zeros((len(resolved), 10)),
                          mne.create_info(resolved, 500.0, 'eeg'), verbose=False)
    raw.set_montage(montage)
    # The recording is referenced to CPz, which is not among our channels, so the
    # montage cannot reproduce that reference. Average reference is the standard
    # substitute and is what the inverse operator expects.
    raw.set_eeg_reference('average', projection=True, verbose=False)
    info = raw.info

    src = mne.read_source_spaces(src_path)
    fwd = mne.make_forward_solution(info, trans=trans, src=src, bem=bem,
                                    eeg=True, meg=False, mindist=5.0, verbose=False)
    cov = mne.make_ad_hoc_cov(info, verbose=False)
    inv = mne.minimum_norm.make_inverse_operator(info, fwd, cov, loose=0.2,
                                                 depth=0.8, verbose=False)

    labels = [l for l in mne.read_labels_from_annot(
        subject, parc='aparc', subjects_dir=subjects_dir, verbose=False)
        if 'unknown' not in l.name.lower()]

    # Push an identity through the inverse: "time point" j is a unit response on
    # channel j, so column j of the parcel time course IS that channel's
    # footprint on cortex. Public API throughout — the private kernel accessor
    # needs a prepared operator and is not worth the coupling.
    evoked = mne.EvokedArray(np.eye(len(resolved)), info, tmin=0, verbose=False)
    stc = mne.minimum_norm.apply_inverse(evoked, inv, lambda2=1.0 / 9.0,
                                         method='dSPM', verbose=False)
    M = np.abs(mne.extract_label_time_course(stc, labels, src, mode='mean',
                                             verbose=False))
    return M, labels, info, src


def localisation_report(M, labels, info, src, trans_path):
    """Two falsifiable checks on the projection.

    The hemisphere test is the load-bearing one: every lateral electrode must
    land in its OWN hemisphere. A flipped axis, a bad co-registration or a
    transposed matrix all break it, and none of them are visible by eye.

    The distance is a sanity bound, not a precision claim — it is measured from
    a scalp electrode to a parcel centroid, so it can never approach zero: skull,
    CSF and the depth of the parcel itself are all included.
    """
    trans = mne.read_trans(trans_path)
    pos_head = np.array([ch['loc'][:3] for ch in info['chs']])
    pos_mri = mne.transforms.apply_trans(trans, pos_head) * 1000.0

    rr = {'lh': src[0]['rr'] * 1000.0, 'rh': src[1]['rr'] * 1000.0}
    cent, hemi = [], []
    for l in labels:
        h = 'lh' if l.name.endswith('-lh') else 'rh'
        cent.append(rr[h][l.vertices].mean(axis=0))
        hemi.append(h)
    cent = np.array(cent)

    rows, mismatches, dists = [], [], []
    for j, ch in enumerate(CHANNELS):
        p = int(np.argmax(M[:, j]))
        d = float(np.linalg.norm(pos_mri[j] - cent[p]))
        dists.append(d)
        digits = [c for c in ch if c.isdigit()]
        want = None if not digits else ('lh' if int(digits[-1]) % 2 else 'rh')
        ok = want is None or want == hemi[p]
        if not ok:
            mismatches.append(ch)
        rows.append({'channel': ch, 'peak': labels[p].name,
                     'distanceMm': round(d, 1), 'hemisphereOk': ok})
    dists = np.array(dists)
    lateral = [r for r in rows if any(c.isdigit() for c in r['channel'])]
    return rows, {
        'hemisphereAgreement': {
            'lateralChannels': len(lateral),
            'mismatches': mismatches,
            'pass': not mismatches,
            'note': 'every lateral electrode must peak in its own hemisphere',
        },
        'distance': {
            'medianMm': round(float(np.median(dists)), 1),
            'maxMm': round(float(dists.max()), 1),
            'thresholdMm': 60.0,
            'pass': bool(np.median(dists) < 45.0 and dists.max() < 60.0),
            'note': 'scalp electrode to parcel centroid; includes skull, CSF '
                    'and parcel depth, so it cannot approach zero',
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--subject', default='sample')
    ap.add_argument('--out', default='public/fields/eeg_proj.json')
    args = ap.parse_args()

    sd = mne.datasets.sample.data_path(download=False)
    subjects_dir = os.path.join(sd, 'subjects')
    bem = os.path.join(subjects_dir, args.subject, 'bem',
                       f'{args.subject}-5120-5120-5120-bem-sol.fif')
    src_path = os.path.join(subjects_dir, args.subject, 'bem',
                            f'{args.subject}-oct-6-src.fif')
    trans = os.path.join(sd, 'MEG', args.subject, f'{args.subject}_audvis_raw-trans.fif')
    for p in (bem, src_path, trans):
        if not os.path.exists(p):
            raise SystemExit(f'missing required input: {p}')

    print(f'building forward model on {args.subject} (this takes a few minutes)...')
    M, labels, info, src = build(args.subject, subjects_dir, trans, bem, src_path)
    print(f'projection: {M.shape} (parcels x channels)')

    rows, gates = localisation_report(M, labels, info, src, trans)
    for k, g in gates.items():
        print(f'  {k}: {"PASS" if g["pass"] else "FAIL"}')
    print(f'  median distance {gates["distance"]["medianMm"]} mm, '
          f'{len(gates["hemisphereAgreement"]["mismatches"])} hemisphere mismatches')

    # Row-normalise: the browser wants each parcel's response as a weighting over
    # channels, and absolute dSPM units mean nothing once band power is the input.
    Mn = M / np.maximum(M.sum(axis=1, keepdims=True), 1e-30)

    # ctx-<hemi>-<name> is how regions.json spells these, so the runtime can join
    # on the label field it already has without another lookup table.
    names = []
    for l in labels:
        hemi = 'lh' if l.name.endswith('-lh') else 'rh'
        names.append(f'ctx-{hemi}-{l.name[:-3]}')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        'subject': args.subject,
        'atlas': 'Desikan-Killiany (aparc)',
        'channels': CHANNELS,
        'parcels': names,
        'matrix': [[round(float(v), 6) for v in row] for row in Mn],
        'evidence': 'plausible-approximation',
        'method': 'dSPM inverse (loose 0.2, depth 0.8, ad-hoc noise covariance) '
                  'on a 3-layer BEM, standard_1020 montage, average reference',
        'gates': gates,
        'localisation': rows,
        'limitation':
            'A linear map from scalp band power to cortical regions, NOT a '
            'source-power reconstruction: band power discards phase, so the '
            'cross-channel covariance a true source estimate requires is not '
            'available. Electrode positions are a template montage, not '
            'digitised per patient. Median electrode-to-parcel distance is '
            f'{gates["distance"]["medianMm"]} mm, so this resolves lobes, not gyri.',
    }, indent=1), encoding='utf-8')
    print(f'wrote {out} ({out.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
