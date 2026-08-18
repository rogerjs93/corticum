"""Realism gate — score the DIFFERENCE in tool behaviour, synthetic vs real.

The point, learned the hard way (see `docs/experiment-0.md`): an absolute score
on the synthetic image measures nothing, because there is no reference value to
compare it against. FSL bet returns Dice 0.88 on corticum's synthetic T1 and
Dice 0.61 on a real one, scored identically — the synthetic looks BETTER, which
tells you the metric was wrong, not that the image was good.

So this never reports a synthetic score alone. It runs the same tool, at the
same settings, on both, and reports the **delta**. A perfectly realistic image
would make a tool behave the same way it behaves on real data; the size of the
gap is the realism signal, and it is the number Phase 2 exists to reduce.

    python tools/realism/realism_gate.py --synthetic <t1.nii> --sdf <sdf.nii> \
        --real <real_t1.nii> --real-parenchyma <real_parenchyma.nii>

Requires Docker and the FSL image. Ground truth for the synthetic side is the
exported SDF (sdf < 0 is parenchyma by construction); for the real side it is a
FreeSurfer segmentation, which is an estimate — stated rather than hidden.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

FSL_IMAGE = "brainlife/fsl:6.0.4-patched2"
F_SWEEP = ["0.3", "0.4", "0.5", "0.6", "0.7"]


def docker_run(workdir: Path, script: str) -> None:
    """Run a bash snippet inside the FSL image with `workdir` mounted at /data."""
    mount = subprocess.run(
        ["cygpath", "-w", str(workdir)], capture_output=True, text=True
    ).stdout.strip() or str(workdir)
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{mount}:/data",
        FSL_IMAGE,
        "bash", "-lc", f"cd /data; export FSLOUTPUTTYPE=NIFTI_GZ; {script}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"docker failed:\n{r.stderr[-2000:]}")


def score(mask: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    mask = mask.astype(bool)
    truth = truth.astype(bool)
    inter = int((mask & truth).sum())
    return {
        "dice": round(2 * inter / (mask.sum() + truth.sum()), 4),
        "oversize_pct": round(100 * (int(mask.sum()) - int(truth.sum())) / int(truth.sum()), 1),
        "kept_background": int((mask & ~truth).sum()),
        "cut_truth": int((truth & ~mask).sum()),
    }


def bet_sweep(workdir: Path, image: Path, prefix: str, truth: np.ndarray) -> dict:
    steps = " ".join(f"bet {image.name} {prefix}_{f} -m -f {f};" for f in F_SWEEP)
    docker_run(workdir, steps)
    out = {}
    for f in F_SWEEP:
        m = np.asarray(nib.load(workdir / f"{prefix}_{f}_mask.nii.gz").dataobj)
        out[f] = score(m, truth)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", required=True, type=Path)
    ap.add_argument("--sdf", required=True, type=Path, help="exported SDF; sdf<0 is parenchyma")
    ap.add_argument("--real", required=True, type=Path)
    ap.add_argument("--real-parenchyma", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=Path("realism_report.json"))
    args = ap.parse_args()

    workdir = args.synthetic.resolve().parent

    synth_truth = np.asarray(nib.load(args.sdf).dataobj) < 0.0
    real_truth = np.asarray(nib.load(args.real_parenchyma).dataobj) > 0

    print("running bet on the synthetic image ...")
    synth = bet_sweep(workdir, args.synthetic, "rg_synth", synth_truth)
    print("running bet on the real image ...")
    real = bet_sweep(workdir, args.real, "rg_real", real_truth)

    print(f"\n{'f':>5}  {'synthetic':>22}  {'real':>22}   {'DELTA':>16}")
    print(f"{'':>5}  {'dice   oversize':>22}  {'dice   oversize':>22}   {'dice  oversize':>16}")
    rows = {}
    for f in F_SWEEP:
        s, r = synth[f], real[f]
        dd = round(s["dice"] - r["dice"], 4)
        do = round(s["oversize_pct"] - r["oversize_pct"], 1)
        rows[f] = {"synthetic": s, "real": r, "delta_dice": dd, "delta_oversize_pct": do}
        print(
            f"{f:>5}  {s['dice']:>7.4f} {s['oversize_pct']:>+11.1f}%  "
            f"{r['dice']:>7.4f} {r['oversize_pct']:>+11.1f}%   "
            f"{dd:>+7.4f} {do:>+8.1f}pt"
        )

    # The headline is the SMALLEST gap achievable across the sweep: if any
    # sensible setting makes the tool behave the same on both, the image is
    # doing its job at that setting.
    best_f = min(F_SWEEP, key=lambda f: abs(rows[f]["delta_oversize_pct"]))
    gap = abs(rows[best_f]["delta_oversize_pct"])
    print(f"\n  closest agreement at f={best_f}: {gap:.1f} percentage points of oversize")
    print("  A realistic image would drive this toward 0. It is the number Phase 2 reduces.")
    print("\n  Ground truth is NOT symmetric: the synthetic side is exact (generated),")
    print("  the real side is a FreeSurfer estimate. The delta is still meaningful")
    print("  because both are scored against their own best available truth.")

    args.out.write_text(
        json.dumps({"per_f": rows, "closest_f": best_f, "gap_oversize_pct": gap}, indent=1),
        encoding="utf-8",
    )
    print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
