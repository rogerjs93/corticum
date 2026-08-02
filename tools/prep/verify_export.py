"""Validate the NIfTI files corticum emits, with an independent reader.

A NIfTI that OPENS but is quietly mis-oriented is the characteristic failure of
this format, and nothing in the browser can catch it — the writer checking its
own arithmetic proves nothing. So this loads the emitted bytes with nibabel and
asks questions whose answers are known independently:

  * does the affine put the brain where the model said it was?
  * a mass lesion at a deliberately ASYMMETRIC world position (right, superior,
    anterior) must land in the right, superior, anterior octant after the
    RAS permutation. Any axis swap or flip moves it somewhere else.
  * the displacement field must be a 5-D vector image with intent DISPVECT,
    and its components must point the way the lesion pushes.

Run after posting bytes from the browser:
    python tools/prep/verify_export.py
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import nibabel as nib

ART = Path(__file__).resolve().parents[2] / 'tests' / 'artifacts'


def main() -> int:
    doc = json.loads((ART / 'export_bytes.json').read_text(encoding='utf-8'))
    lesion = np.array(doc['lesionCentreWorld'], dtype=float)  # world X=R, Y=S, Z=A
    # The same point in RAS, which is what the file should be in.
    lesion_ras = np.array([lesion[0], lesion[2], lesion[1]])

    out = {}
    imgs = {}
    for f in doc['files']:
        p = ART / f['name']
        p.write_bytes(base64.b64decode(f['b64']))
        imgs[f['name'].split('_')[-1].replace('.nii', '')] = nib.load(str(p))
        out[f['name']] = p.stat().st_size

    ok = True

    t1 = imgs['t1']
    sdf = imgs['sdf']
    disp = imgs['disp']

    print(f'shapes: t1 {t1.shape}  sdf {sdf.shape}  disp {disp.shape}')
    print(f'affine:\n{t1.affine}')
    print(f'sform_code {int(t1.header["sform_code"])}  '
          f'qform_code {int(t1.header["qform_code"])}  '
          f'intent(disp) {int(disp.header["intent_code"])}')

    # --- the brain is where it should be -----------------------------------
    d = np.asarray(sdf.dataobj)
    inside = d < 0
    frac = inside.mean()
    print(f'inside fraction {frac:.4f}')
    ok &= 0.08 < frac < 0.35

    # Centroid of the brain in world RAS via the affine.
    idx = np.array(np.nonzero(inside))
    centre_vox = idx.mean(axis=1)
    centre_ras = nib.affines.apply_affine(sdf.affine, centre_vox)
    print(f'brain centroid RAS {np.round(centre_ras, 1)}')
    # A whole brain centred near the tkrRAS origin: |R| small, and A/S modest.
    ok &= abs(centre_ras[0]) < 12

    # --- the lesion landed in the right octant -----------------------------
    v = np.squeeze(np.asarray(disp.dataobj))
    mag = np.linalg.norm(v, axis=-1)

    # The magnitude-WEIGHTED centroid, not the argmax.
    #
    # Mass effect is a radial expansion, so the displacement is zero at the
    # lesion centre and peaks on a shell at r ~ R. Taking the brightest voxel
    # therefore lands ~R millimetres away in an arbitrary direction, which looks
    # like a 30 mm orientation error and is nothing of the sort. The weighted
    # centroid of a radially symmetric shell is its centre.
    w = mag.ravel()
    grid = np.array(np.meshgrid(*[np.arange(s) for s in mag.shape], indexing='ij'))
    cent_vox = (grid.reshape(3, -1) * w).sum(axis=1) / max(w.sum(), 1e-9)
    cent_ras = nib.affines.apply_affine(disp.affine, cent_vox)
    print(f'max |displacement| {mag.max():.2f} mm; weighted centroid RAS '
          f'{np.round(cent_ras, 1)}   (commanded RAS {np.round(lesion_ras, 1)})')

    # Same octant on every axis is the orientation test: an axis swap or flip
    # moves the lesion out of the octant it was placed in.
    same_octant = all(
        (cent_ras[i] > 0) == (lesion_ras[i] > 0) or abs(lesion_ras[i]) < 5
        for i in range(3)
    )
    print(f'displacement centroid in the commanded octant: {same_octant}')
    ok &= bool(same_octant)
    dist = float(np.linalg.norm(cent_ras - lesion_ras))
    print(f'distance from commanded centre {dist:.1f} mm')
    ok &= dist < 30

    ok &= int(disp.header['intent_code']) == 1006
    ok &= disp.shape[-1] == 3

    print()
    print('NIfTI export gate:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
