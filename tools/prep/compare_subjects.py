#!/usr/bin/env python
"""
Compare built field payloads against their sources, and against each other.

Answers two questions that matter before any GPU work:

1. Did the payload survive crop -> EDT -> quantise -> gzip intact? (Dice, and
   the round-trip error of the quantised distance field.)
2. Which subject actually carries more cortical folding? fsaverage is an
   *average* brain, so averaging smooths gyri; an individual should show a
   larger isosurface area for a similar brain volume. Surface area per unit
   volume is the standard proxy, so measure it rather than guess.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage
from skimage import measure

ROOT = Path(__file__).resolve().parents[2]
SUBJECTS = Path(r"C:\Users\roger\mne_data\MNE-sample-data\subjects")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fields import (  # noqa: E402
    CSF_VENTRICLE,
    SDF_RANGE_MM,
    TISSUE,
    resample_to_world,
    signed_distance,
    tissue_of,
)


def load_payload(d: Path):
    """Read a payload back into world [x][y][z] order."""
    man = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    n = man["grid"]["dim"]

    def read(name, dtype):
        with gzip.open(d / name, "rb") as fh:
            a = np.frombuffer(fh.read(), dtype=dtype).reshape(n, n, n)
        # Files are written x-fastest for WebGPU, i.e. [z][y][x]; undo it.
        return np.ascontiguousarray(a.transpose(2, 1, 0))

    return man, read("sdf_brain.i8.gz", np.int8), read("labels.u8.gz", np.uint8)


def dice(a: np.ndarray, b: np.ndarray) -> float:
    inter = np.logical_and(a, b).sum()
    return float(2 * inter / (a.sum() + b.sum()))


def analyse(subject: str, half: int = 104) -> dict:
    n = 2 * half
    d = ROOT / "public" / "fields" / f"{subject}-{n}"
    man, sdf_q, labels = load_payload(d)

    # Ground truth, recomputed from source exactly as the builder does.
    img = nib.load(str(SUBJECTS / subject / "mri" / "aparc+aseg.mgz"))
    seg = np.asarray(img.dataobj).astype(np.int32)
    world = resample_to_world(seg, img.header.get_vox2ras_tkr(), half)

    present = np.unique(world)
    tl = np.zeros(int(present.max()) + 1, dtype=np.uint8)
    for lb in present:
        tl[lb] = tissue_of(int(lb))
    tissue = tl[world]
    truth = (tissue != TISSUE["background"]) & (tissue != TISSUE["csf_ventricle"])

    sdf_ref = signed_distance(truth)
    sdf_dec = sdf_q.astype(np.float32) / 127.0 * SDF_RANGE_MM

    recon = sdf_dec < 0
    dice_mask = dice(recon, truth)

    # Round-trip error only matters in the band the raymarcher actually reads.
    band = np.abs(sdf_ref) <= 4.0
    err = np.abs(sdf_dec[band] - np.clip(sdf_ref[band], -SDF_RANGE_MM, SDF_RANGE_MM))

    # Fold complexity: isosurface area of the decoded field.
    verts, faces, _, _ = measure.marching_cubes(sdf_dec, level=0.0)
    tri = verts[faces]
    area = float(
        np.linalg.norm(
            np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1
        ).sum()
        * 0.5
    )
    volume = float(truth.sum())

    # Cortical grey matter only — the part whose folding we care about.
    ctx = np.isin(world, list(range(1000, 1036)) + list(range(2000, 2036)))

    return {
        "subject": subject,
        "dice": dice_mask,
        "labelAgreement": float((labels != 0).sum() / max((world != 0).sum(), 1)),
        "rtMeanErrMm": float(err.mean()),
        "rtMaxErrMm": float(err.max()),
        "areaCm2": area / 100.0,
        "volumeCm3": volume / 1000.0,
        "gyrification": area / (volume ** (2 / 3)),
        "cortexCm3": float(ctx.sum()) / 1000.0,
        "payloadMB": sum(man["bytes"].values()) / 1e6,
        "occupancy": man["occupancy"],
    }


def main() -> None:
    rows = [analyse(s) for s in ("fsaverage", "sample")]

    print(f"\n{'metric':<26}" + "".join(f"{r['subject']:>14}" for r in rows))
    print("-" * (26 + 14 * len(rows)))

    def line(label, key, fmt="{:.4f}"):
        print(f"{label:<26}" + "".join(f"{fmt.format(r[key]):>14}" for r in rows))

    line("Dice (recon vs source)", "dice")
    line("label coverage", "labelAgreement")
    line("round-trip mean err (mm)", "rtMeanErrMm")
    line("round-trip max err (mm)", "rtMaxErrMm")
    line("isosurface area (cm^2)", "areaCm2", "{:.0f}")
    line("parenchyma volume (cm^3)", "volumeCm3", "{:.0f}")
    line("cortical GM (cm^3)", "cortexCm3", "{:.0f}")
    line("gyrification A/V^(2/3)", "gyrification", "{:.2f}")
    line("payload (MB gz)", "payloadMB", "{:.3f}")
    line("cube occupancy", "occupancy", "{:.3f}")

    a, b = rows
    print(
        f"\n{b['subject']} carries "
        f"{(b['gyrification'] / a['gyrification'] - 1) * 100:+.1f}% "
        f"gyrification vs {a['subject']}"
    )
    worst = min(r["dice"] for r in rows)
    print(f"worst Dice across subjects: {worst:.4f}  "
          f"({'PASS' if worst >= 0.97 else 'FAIL'} vs 0.97 gate)")


if __name__ == "__main__":
    main()
