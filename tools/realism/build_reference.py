"""Build the realism REFERENCE from a set of real brains.

Runs on whichever machine holds the recon-all output — for this project that is
the remote FreeSurfer box, not the Windows workstation, because it is 40 x
(bet + fast) and the images never need to move. What comes back is a few
kilobytes of JSON.

The point: `realism_gate.py` compared the synthetic image against ONE real
brain, which cannot answer the question that matters. A 3.4-point CSF gap is
meaningless until you know how far real brains spread — it may already be well
inside the normal range, or the range may be narrower still. One subject cannot
tell you which.

    python build_reference.py --subjects-dir <SUBJECTS_DIR> --out reference.json

Expects FreeSurfer subject directories with mri/T1.mgz and mri/aparc+aseg.mgz.
Needs FSL on PATH (or run it inside the FSL container).
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np

F_SWEEP = ["0.3", "0.5", "0.6", "0.7"]
METRICS = ["csf_frac", "gm_frac", "wm_frac", "mixed_frac", "mean_peak_pve"]


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"failed: {' '.join(cmd)}\n{r.stderr[-1500:]}")


def measure_subject(subj: Path, work: Path) -> dict | None:
    t1_mgz = subj / "mri" / "T1.mgz"
    seg_mgz = subj / "mri" / "aparc+aseg.mgz"
    if not (t1_mgz.exists() and seg_mgz.exists()):
        return None

    t1 = nib.load(str(t1_mgz))
    seg = nib.load(str(seg_mgz))
    t1_nii = work / f"{subj.name}_t1.nii"
    nib.save(nib.Nifti1Image(np.asarray(t1.dataobj).astype(np.float32), t1.affine), t1_nii)
    truth = np.asarray(seg.dataobj) > 0

    out: dict = {"subject": subj.name, "bet": {}}
    for f in F_SWEEP:
        pre = work / f"{subj.name}_bet_{f}"
        run(["bet", str(t1_nii), str(pre), "-m", "-f", f])
        m = np.asarray(nib.load(f"{pre}_mask.nii.gz").dataobj).astype(bool)
        out["bet"][f] = {
            "dice": round(2 * (m & truth).sum() / (m.sum() + truth.sum()), 4),
            "oversize_pct": round(100 * (int(m.sum()) - int(truth.sum())) / int(truth.sum()), 1),
        }

    # FAST on the f=0.5 extraction: the conventional pipeline. A ground-truth
    # mask makes FAST's mixture diverge (MeaNsK variance nan) — see
    # docs/experiment-0.md.
    fpre = work / f"{subj.name}_fast"
    run(["fast", "-t", "1", "-n", "3", "-o", str(fpre), str(work / f"{subj.name}_bet_0.5.nii.gz")])
    pves = [np.asarray(nib.load(f"{fpre}_pve_{k}.nii.gz").dataobj) for k in range(3)]
    if min(float(p.sum()) for p in pves) <= 0:
        out["fast"] = {"converged": False}
        return out

    stack = np.stack(pves, axis=0)
    inside = stack.sum(axis=0) > 0.01
    peak = stack.max(axis=0)[inside]
    out["fast"] = {
        "converged": True,
        "csf_frac": round(float(pves[0][inside].sum() / inside.sum()), 4),
        "gm_frac": round(float(pves[1][inside].sum() / inside.sum()), 4),
        "wm_frac": round(float(pves[2][inside].sum() / inside.sum()), 4),
        "mixed_frac": round(float((peak < 0.95).sum() / peak.size), 4),
        "mean_peak_pve": round(float(peak.mean()), 4),
    }
    return out


def summarise(values: list[float]) -> dict:
    if len(values) < 2:
        return {"n": len(values), "mean": round(values[0], 4) if values else None, "sd": None}
    return {
        "n": len(values),
        "mean": round(statistics.mean(values), 4),
        "sd": round(statistics.stdev(values), 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subjects-dir", required=True, type=Path)
    ap.add_argument("--subjects", nargs="*", help="subset; default is every directory found")
    ap.add_argument("--out", type=Path, default=Path("reference.json"))
    args = ap.parse_args()

    subs = (
        [args.subjects_dir / s for s in args.subjects]
        if args.subjects
        else sorted(d for d in args.subjects_dir.iterdir() if (d / "mri" / "T1.mgz").exists())
    )
    print(f"{len(subs)} subject(s)")

    per_subject = []
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        for i, s in enumerate(subs, 1):
            print(f"  [{i}/{len(subs)}] {s.name} ...", flush=True)
            r = measure_subject(s, work)
            if r:
                per_subject.append(r)

    ok = [r for r in per_subject if r.get("fast", {}).get("converged")]
    ref = {
        "n_subjects": len(per_subject),
        "n_fast_converged": len(ok),
        "fast": {m: summarise([r["fast"][m] for r in ok]) for m in METRICS} if ok else {},
        "bet": {
            f: {
                "oversize_pct": summarise([r["bet"][f]["oversize_pct"] for r in per_subject]),
                "dice": summarise([r["bet"][f]["dice"] for r in per_subject]),
            }
            for f in F_SWEEP
        },
        "per_subject": per_subject,
        "note": (
            "Reference distribution of real brains. The gate asks whether the "
            "synthetic image falls INSIDE this spread, not whether it matches "
            "any single brain."
        ),
    }
    args.out.write_text(json.dumps(ref, indent=1), encoding="utf-8")
    print(f"\nwrote {args.out}  ({len(per_subject)} subjects, {len(ok)} FAST converged)")


if __name__ == "__main__":
    main()
