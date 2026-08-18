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



def fast_compare(
    workdir: Path, brain: Path, prefix: str
) -> dict[str, float]:
    """Run FSL FAST on a BET-extracted brain and describe what it found.

    Runs on the BET OUTPUT, i.e. the conventional pipeline. The first version
    masked by exact ground truth instead, reasoning that this would isolate
    tissue segmentation from BET's error. It does not work: a razor-sharp
    parenchyma cut with an exactly-zero background makes FAST's bias-field and
    mixture estimation diverge — it printed `MeaNsK variance nan`, collapsed all
    three classes into one, and **exited 0**. BET's output keeps a CSF rim and a
    softer edge, which is why the conventional order is conventional.

    Measuring the pipeline as actually run is also the more honest question, and
    the one the roadmap asks: what do real tools DO with this image.

    Headline is the MIXED fraction: voxels FAST cannot assign cleanly to a
    single class. A hard tissue-class image has almost none, because every voxel
    is exactly one tissue; a real image has many, because real boundaries are
    graded. That is the number the partial-volume ramp should move, and the one
    the bet metrics were structurally unable to see.
    """
    docker_run(workdir, f"fast -t 1 -n 3 -o {prefix} {brain.name};")

    pves = [
        np.asarray(nib.load(workdir / f"{prefix}_pve_{k}.nii.gz").dataobj)
        for k in range(3)
    ]
    sums = [float(pv.sum()) for pv in pves]
    # FAST exits 0 even when its mixture model diverges. Refusing to report a
    # degenerate fit is the whole point of having noticed this once.
    if min(sums) <= 0.0:
        # NOT an error, and not something to abort on: a tool that refuses to
        # process the image is the strongest realism signal available, and far
        # less ambiguous than any score. FAST converges on the real brain and
        # collapses on this one, which is a finding worth recording as a result.
        return {
            "converged": False,
            "note": "FAST mixture diverged (MeaNsK variance nan) and collapsed to one class",
            "class_sums": [int(x) for x in sums],
        }

    stack = np.stack(pves, axis=0)
    inside = stack.sum(axis=0) > 0.01
    peak = stack.max(axis=0)[inside]
    frac = [float(pv[inside].sum() / inside.sum()) for pv in pves]

    return {
        "converged": True,
        # FAST orders classes by intensity: CSF, GM, WM for a T1.
        "csf_frac": round(frac[0], 4),
        "gm_frac": round(frac[1], 4),
        "wm_frac": round(frac[2], 4),
        "mixed_frac": round(float((peak < 0.95).sum() / peak.size), 4),
        "mean_peak_pve": round(float(peak.mean()), 4),
    }


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

    # ---- FAST: tissue segmentation ------------------------------------------
    print("\nrunning fast on the synthetic image (ground-truth masked) ...")
    fs = fast_compare(workdir, workdir / "rg_synth_0.5.nii.gz", "rg_fsynth")
    print("running fast on the real image ...")
    fr = fast_compare(workdir, workdir / "rg_real_0.5.nii.gz", "rg_freal")

    print(f"\n{'':22}{'synthetic':>12}{'real':>12}{'delta':>12}")
    fast_rows = {}
    print(f"  {'converged':<20}{str(fs['converged']):>12}{str(fr['converged']):>12}")
    fast_rows["converged"] = {"synthetic": fs["converged"], "real": fr["converged"]}

    if not (fs["converged"] and fr["converged"]):
        # The headline IS the divergence. Reporting fractions from a collapsed
        # fit would be reporting noise dressed as data.
        for side, r in (("synthetic", fs), ("real", fr)):
            if not r["converged"]:
                print(f"    {side}: {r['note']}")
                fast_rows[f"{side}_note"] = r["note"]
        print("")
        print("  A tool REFUSING to process the image is the least ambiguous")
        print("  realism signal there is -- no metric choice can flatter it.")
    else:
        for key, label in [
            ("csf_frac", "CSF fraction"),
            ("gm_frac", "GM fraction"),
            ("wm_frac", "WM fraction"),
            ("mixed_frac", "MIXED voxels"),
            ("mean_peak_pve", "mean peak PVE"),
        ]:
            d = round(fs[key] - fr[key], 4)
            fast_rows[key] = {"synthetic": fs[key], "real": fr[key], "delta": d}
            print(f"  {label:<20}{fs[key]:>12.4f}{fr[key]:>12.4f}{d:>+12.4f}")

    print("\n  MIXED = voxels FAST cannot assign cleanly to one class (peak PVE < 0.95).")
    print("  A hard tissue-class image has almost none; a real image has many, because")
    print("  real tissue boundaries are graded. This is the number the partial-volume")
    print("  ramp should move, and the one the bet metrics could never see.")

    args.out.write_text(
        json.dumps(
            {
                "bet": {"per_f": rows, "closest_f": best_f, "gap_oversize_pct": gap},
                "fast": fast_rows,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
