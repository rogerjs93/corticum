"""Compose the subject -> MNI152 affine and record it in the field manifest.

corticum's exported NIfTI is already in the subject's tkrRAS, so putting an
export into MNI space needs exactly one 4x4 left-multiply and no resampling.
That matrix is what this script computes.

Nothing is registered here. FreeSurfer already solved this when the subject was
reconstructed, and re-deriving it would be inventing an answer that is already
on disk:

    tkrRAS  --Norig @ inv(Torig)-->  scanner RAS
            --talairach.xfm------->  MNI305
            --published constant-->  MNI152

**This is an AFFINE.** Deep-structure error against published coordinates is a
few millimetres, which is what a 12-dof normalisation gives and is fine for
placing a lesion into a normative connectome. It is not a nonlinear warp;
`talairach.m3z` exists if that is ever wanted.

Usage:
    python tools/prep/mni_transform.py --subject sample [--write]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np

DEFAULT_SUBJECTS_DIR = Path(r"C:\Users\roger\mne_data\MNE-sample-data\subjects")
FIELDS = Path(__file__).resolve().parents[2] / "public" / "fields"

# FreeSurfer's MNI305 -> MNI152 affine (CoordinateSystems reference).
MNI305_TO_MNI152 = np.array(
    [
        [0.9975, -0.0073, 0.0176, -0.0429],
        [0.0146, 1.0009, -0.0024, 1.5496],
        [-0.0130, -0.0093, 0.9971, 1.1840],
        [0.0, 0.0, 0.0, 1.0],
    ]
)

# Deep grey centroids in MNI152, from the literature. Deliberately NOT taken
# from corticum's own parcellation: a check scored against the same table the
# transform was built from would only prove self-consistency.
PUBLISHED_MNI = {
    17: ("Left-Hippocampus", (-26, -24, -14)),
    53: ("Right-Hippocampus", (26, -24, -14)),
    18: ("Left-Amygdala", (-23, -5, -18)),
    54: ("Right-Amygdala", (23, -5, -18)),
    11: ("Left-Caudate", (-13, 10, 10)),
    12: ("Left-Putamen", (-26, 0, 2)),
    51: ("Right-Putamen", (26, 0, 2)),
    10: ("Left-Thalamus", (-11, -19, 8)),
}

# An affine normalisation lands deep structures within a few mm. Twenty is
# generous; a composition error (missing Torig, a flip, a wrong xfm) misses by
# far more than that, which is what this bound is for.
WORST_ERROR_LIMIT_MM = 20.0


def read_xfm(path: Path) -> np.ndarray:
    """Parse an MNI .xfm: three rows of a 4x4, terminated by ';'."""
    body = path.read_text().split("Linear_Transform")[1].split("=", 1)[1].split(";")[0]
    nums = [float(x) for x in body.split()]
    if len(nums) != 12:
        raise ValueError(f"{path}: expected 12 numbers, got {len(nums)}")
    m = np.eye(4)
    m[:3, :] = np.asarray(nums).reshape(3, 4)
    return m


def compose(subject_dir: Path) -> tuple[np.ndarray, str]:
    orig = nib.load(str(subject_dir / "mri" / "orig.mgz"))
    tkr_to_scanner = orig.header.get_vox2ras() @ np.linalg.inv(orig.header.get_vox2ras_tkr())

    transforms = subject_dir / "mri" / "transforms"
    xfm_path = transforms / "talairach.xfm"
    if not xfm_path.exists():
        xfm_path = transforms / "talairach.auto.xfm"
    if not xfm_path.exists():
        raise FileNotFoundError(f"no talairach transform under {transforms}")

    return MNI305_TO_MNI152 @ read_xfm(xfm_path) @ tkr_to_scanner, xfm_path.name


def validate(subject_dir: Path, tkr_to_mni: np.ndarray) -> dict:
    """Score the composition against published coordinates. Independent axis."""
    aseg = nib.load(str(subject_dir / "mri" / "aparc+aseg.mgz"))
    data = np.asarray(aseg.dataobj)
    vox_to_tkr = aseg.header.get_vox2ras_tkr()

    rows = []
    for label, (name, ref) in PUBLISHED_MNI.items():
        idx = np.argwhere(data == label)
        if idx.size == 0:
            continue
        tkr = vox_to_tkr @ np.append(idx.mean(axis=0), 1.0)
        mni = (tkr_to_mni @ tkr)[:3]
        rows.append((name, mni, np.asarray(ref, float), float(np.linalg.norm(mni - ref))))

    if not rows:
        raise RuntimeError("no reference structures found in aparc+aseg")

    print(f"\n{'structure':<20} {'computed MNI152':<26} {'published':<18} error")
    for name, mni, ref, d in rows:
        got = f"({mni[0]:6.1f},{mni[1]:6.1f},{mni[2]:6.1f})"
        exp = f"({ref[0]:5.0f},{ref[1]:5.0f},{ref[2]:5.0f})"
        print(f"{name:<20} {got:<26} {exp:<18} {d:5.1f} mm")

    errs = [d for *_, d in rows]
    worst = max(errs)

    # Laterality is the error this project has been bitten by, and a mean
    # distance will not catch it: a left/right flip keeps every structure the
    # same distance from the midline. Check the SIGN of x separately.
    flips = [
        name
        for name, mni, ref, _ in rows
        if abs(ref[0]) > 5 and np.sign(mni[0]) != np.sign(ref[0])
    ]

    report = {
        "structures": len(rows),
        "meanErrorMm": round(float(np.mean(errs)), 2),
        "worstErrorMm": round(worst, 2),
        "lateralityFlips": flips,
    }
    print(f"\nmean {report['meanErrorMm']} mm, worst {report['worstErrorMm']} mm")

    if flips:
        raise SystemExit(f"FAIL: left/right flipped for {flips}")
    if worst > WORST_ERROR_LIMIT_MM:
        raise SystemExit(f"FAIL: worst error {worst:.1f} mm exceeds {WORST_ERROR_LIMIT_MM} mm")
    print("PASS: no laterality flip, worst error within bound")
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", default="sample")
    ap.add_argument("--subjects-dir", type=Path, default=DEFAULT_SUBJECTS_DIR)
    ap.add_argument("--write", action="store_true", help="patch the field manifest")
    args = ap.parse_args()

    subject_dir = args.subjects_dir / args.subject
    tkr_to_mni, xfm_name = compose(subject_dir)
    print(f"{args.subject}: composed via {xfm_name}")
    print("tkrRAS -> MNI152:")
    print(np.round(tkr_to_mni, 5))

    report = validate(subject_dir, tkr_to_mni)

    if not args.write:
        print("\n(dry run — pass --write to patch the manifest)")
        return

    manifest_path = FIELDS / f"{args.subject}-208" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["mni"] = {
        "space": "MNI152",
        "kind": "affine",
        "via": f"{xfm_name} (subject->MNI305) composed with FreeSurfer's MNI305->MNI152",
        "tkrRasToMni152": [[round(v, 8) for v in row] for row in tkr_to_mni.tolist()],
        "validation": report,
        "note": (
            "Affine only, and the voxel grid stays the subject's — an export "
            "carries this as its sform so downstream tools can resample. It is "
            "not a nonlinear warp."
        ),
    }
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    print(f"\nwrote mni block -> {manifest_path}")


if __name__ == "__main__":
    main()
