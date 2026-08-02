#!/usr/bin/env python
"""
Phase 1 gate: score what the GPU actually sampled against the source MRI.

The browser samples the uploaded field through a compute shader on a regular
grid (src/verify/sliceProbe.ts) and POSTs the result to tests/artifacts/. This
script recomputes the same slices straight from aparc+aseg.mgz and reports Dice.

The point is that the two paths share no code. A round-trip check written
against the same array the builder produced would pass even if the upload
flipped an axis, the sampler was off by half a voxel, or the decode used the
wrong range. This catches all three.

Usage:
    python verify_slice.py                       # scores every artifact found
    python verify_slice.py --subject sample
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "tests" / "artifacts"
SUBJECTS = Path(r"C:\Users\roger\mne_data\MNE-sample-data\subjects")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fields import TISSUE, resample_to_world, tissue_of  # noqa: E402

GATE = 0.97


def unpack_bits(b64: str, count: int) -> np.ndarray:
    raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
    bits = np.unpackbits(raw, bitorder="little")[:count]
    return bits.astype(bool)


def truth_volume(subject: str, half: int) -> np.ndarray:
    img = nib.load(str(SUBJECTS / subject / "mri" / "aparc+aseg.mgz"))
    seg = np.asarray(img.dataobj).astype(np.int32)
    world = resample_to_world(seg, img.header.get_vox2ras_tkr(), half)
    present = np.unique(world)
    tl = np.zeros(int(present.max()) + 1, dtype=np.uint8)
    for lb in present:
        tl[lb] = tissue_of(int(lb))
    t = tl[world]
    return (t != TISSUE["background"]) & (t != TISSUE["csf_ventricle"])


def dice(a: np.ndarray, b: np.ndarray) -> float:
    denom = a.sum() + b.sum()
    if denom == 0:
        return 1.0
    return float(2 * np.logical_and(a, b).sum() / denom)


def score(path: Path) -> bool:
    doc = json.loads(path.read_text(encoding="utf-8"))
    subject = doc["subject"]
    half = int(doc["halfExtentMm"])
    res = int(doc["dim"])

    print(f"\n=== {subject}  ({path.name}) ===")
    truth = truth_volume(subject, half)

    ok = True
    for s in doc["slices"]:
        axis, pos, label = int(s["axis"]), float(s["posMm"]), s["label"]
        gpu = unpack_bits(s["insideBase64"], res * res).reshape(res, res)

        # The GPU grid point (gx, gy) maps to world (a, b) = (gx-half, gy-half)
        # with the slice coordinate substituted on `axis`. Index the truth
        # volume the same way: world w -> index w+half.
        k = int(round(pos)) + half
        if axis == 0:
            ref = truth[k, :, :]
        elif axis == 1:
            ref = truth[:, k, :]
        else:
            ref = truth[:, :, k]
        # GPU writes outBuf[gy*res + gx] with gx the first varying world axis,
        # so the array is [b][a] and the reference is [a][b].
        ref = ref.T

        d = dice(gpu, ref)
        agree = float((gpu == ref).mean())
        disagree = int((gpu != ref).sum())
        flag = "PASS" if d >= GATE else "FAIL"
        if d < GATE:
            ok = False
        print(
            f"  {label:<18} Dice {d:.4f}  voxel agreement {agree * 100:6.3f}%  "
            f"({disagree} of {res * res} differ)  [{flag}]"
        )

    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", default=None)
    args = ap.parse_args()

    pattern = f"anatomy_{args.subject}.json" if args.subject else "anatomy_*.json"
    files = sorted(ARTIFACTS.glob(pattern))
    if not files:
        raise SystemExit(
            f"no artifacts matching {pattern} in {ARTIFACTS}\n"
            "Run window.__corticum.verifyAnatomy() in the browser first."
        )

    all_ok = all(score(f) for f in files)
    print(f"\nPhase 1 anatomy gate (Dice >= {GATE}): {'PASS' if all_ok else 'FAIL'}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
