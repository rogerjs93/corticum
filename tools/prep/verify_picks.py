#!/usr/bin/env python
"""
Phase 4 gate: does clicking the brain name the right region?

The browser casts picks through the real screen path — camera, picking ray, the
shared WGSL march — and records the material-space position and region each one
reported. This script looks up the SAME coordinates in aparc+aseg.mgz and checks
that the answers agree.

As with the anatomy gate, the two sides share no code: the GPU walks a
quantised distance field and samples a uint8 label texture; this walks the
original NIfTI. Agreement across both is evidence; agreement within one is not.

Usage:
    python verify_picks.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "tests" / "artifacts"
SUBJECTS = Path(r"C:\Users\roger\mne_data\MNE-sample-data\subjects")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fields import resample_to_world  # noqa: E402


def main() -> None:
    files = sorted(ARTIFACTS.glob("picks_*.json"))
    if not files:
        raise SystemExit(
            f"no picks_*.json in {ARTIFACTS}\n"
            "Run window.__corticum.verifyPicks() in the browser first."
        )

    all_ok = True
    for path in files:
        doc = json.loads(path.read_text(encoding="utf-8"))
        subject = doc["subject"]
        half = int(doc["halfExtentMm"])
        picks = doc["picks"]

        img = nib.load(str(SUBJECTS / subject / "mri" / "aparc+aseg.mgz"))
        seg = np.asarray(img.dataobj).astype(np.int32)
        world = resample_to_world(seg, img.header.get_vox2ras_tkr(), half)

        print(f"\n=== {subject} ({len(picks)} picks) ===")
        agree = 0
        for i, p in enumerate(picks):
            x, y, z = p["material"]
            ix = int(round(x)) + half
            iy = int(round(y)) + half
            iz = int(round(z)) + half
            if not (0 <= ix < world.shape[0] and 0 <= iy < world.shape[1] and 0 <= iz < world.shape[2]):
                print(f"  {i:2d}  OUT OF BOUNDS  ({x:.1f}, {y:.1f}, {z:.1f})")
                all_ok = False
                continue

            # The pick lands ON the isosurface, where the nearest labelled voxel
            # may be a fraction of a millimetre inside. Accept any label in the
            # immediate 3x3x3 neighbourhood: a surface point is genuinely
            # ambiguous at sub-voxel scale, and demanding an exact centre-voxel
            # match would test rounding rather than anatomy.
            nb = world[
                max(ix - 1, 0):ix + 2,
                max(iy - 1, 0):iy + 2,
                max(iz - 1, 0):iz + 2,
            ]
            truth = set(int(v) for v in np.unique(nb) if v != 0)
            got = int(p["fsLabel"])
            ok = got in truth
            agree += 1 if ok else 0
            if not ok:
                names = sorted(truth)[:6]
                print(
                    f"  {i:2d}  MISMATCH  gpu={got} ({p['name']}) "
                    f"truth={names}  at ({x:.1f}, {y:.1f}, {z:.1f})"
                )

        print(f"  {agree}/{len(picks)} picks agree with aparc+aseg.mgz")
        if agree != len(picks):
            all_ok = False

    print(f"\nPhase 4 pick gate: {'PASS' if all_ok else 'FAIL'}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
