#!/usr/bin/env python
"""
Build corticum's compact anatomical field payload from a FreeSurfer subject.

The repository ships no textures, meshes, HDRIs or animation data. What it does
ship is the output of this script: a quantised signed-distance field plus a
tissue/region label field, together a couple of megabytes gzipped. Everything
else — the sub-voxel relief, the vasculature, the shading, every frame of
disease progression — is generated on the GPU from these.

Usage
-----
    python build_fields.py --subject fsaverage
    python build_fields.py --subject sample --half 104

Outputs (to public/fields/<subject>-<N>/):
    sdf_brain.i8.gz   N^3   int8, signed distance to the parenchyma surface, +-16 mm
    sdf_vent.i8.gz    128^3 int8, signed distance to the ventricular system
    labels.u8.gz      N^3   uint8, dense index into regions.json
    sulc.i8.gz        96^3  int8, nearest-vertex sulcal depth, +-2
    regions.json            index -> name, colour, tissue class
    manifest.json           grid geometry, byte sizes, source SHA-256s, version

Coordinate convention
---------------------
The output grid is axis-aligned in a canonical world frame, NOT in the source
volume's voxel order:

    world X = Right, world Y = Superior, world Z = Anterior   (Babylon left-handed)

and is centred on the **tkrRAS origin**, which for a conformed FreeSurfer volume
is exactly voxel (128, 128, 128). Centring anywhere else — the label bounding
box, say — would silently desynchronise the volume-derived fields from the
surface-derived ones, because FreeSurfer surface coordinates are tkrRAS.

Because vox2ras_tkr for a conformed volume is a signed permutation with integer
offsets and 1 mm spacing, the resample is an exact relabelling of voxels: no
interpolation, no resampling error. The script asserts this rather than assuming
it.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage

VERSION = "1.0.0"

DEFAULT_SUBJECTS_DIR = Path(r"C:\Users\roger\mne_data\MNE-sample-data\subjects")

# Distance fields are clipped to this range before quantisation. At +-16 mm an
# int8 step is 16*2/255 = 0.125 mm, an order of magnitude finer than the 1 mm
# voxel grid the anatomy is sampled on, so quantisation is not the accuracy
# limit. The range only has to exceed the largest empty-space step the
# raymarcher will ever want to take.
SDF_RANGE_MM = 16.0

# ---------------------------------------------------------------------------
# FreeSurfer label groups -> tissue classes.
# Class order matters: it is the order the GPU tests against.
# ---------------------------------------------------------------------------
TISSUE = {
    "background": 0,
    "csf_ventricle": 1,
    "cortical_gm": 2,
    "cerebral_wm": 3,
    "deep_gm": 4,
    "cerebellar_gm": 5,
    "cerebellar_wm": 6,
    "brainstem": 7,
    "vessel": 8,
}

CSF_VENTRICLE = {4, 5, 14, 15, 24, 31, 43, 44, 63, 72}
CEREBRAL_WM = {2, 41, 77, 78, 79, 251, 252, 253, 254, 255}
DEEP_GM = {10, 11, 12, 13, 17, 18, 26, 28, 49, 50, 51, 52, 53, 54, 58, 60}
CEREBELLAR_GM = {8, 47}
CEREBELLAR_WM = {7, 46}
BRAINSTEM = {16, 85}
VESSEL = {30, 62}


def tissue_of(label: int) -> int:
    """Map a FreeSurfer label id to a tissue class."""
    if label == 0:
        return TISSUE["background"]
    if label in CSF_VENTRICLE:
        return TISSUE["csf_ventricle"]
    if 1000 <= label <= 1035 or 2000 <= label <= 2035:
        return TISSUE["cortical_gm"]
    if label in CEREBRAL_WM:
        return TISSUE["cerebral_wm"]
    if label in DEEP_GM:
        return TISSUE["deep_gm"]
    if label in CEREBELLAR_GM:
        return TISSUE["cerebellar_gm"]
    if label in CEREBELLAR_WM:
        return TISSUE["cerebellar_wm"]
    if label in BRAINSTEM:
        return TISSUE["brainstem"]
    if label in VESSEL:
        return TISSUE["vessel"]
    # Anything unclassified (hypointensities, unknown) counts as parenchyma so
    # it does not punch holes in the surface.
    return TISSUE["cerebral_wm"]


def load_lut() -> dict[int, tuple[str, tuple[int, int, int]]]:
    """FreeSurferColorLUT ships inside the installed mne package — no download."""
    import mne

    path = Path(mne.__file__).parent / "data" / "FreeSurferColorLUT.txt"
    lut: dict[int, tuple[str, tuple[int, int, int]]] = {}
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 5:
                continue
            try:
                idx = int(parts[0])
                r, g, b = int(parts[2]), int(parts[3]), int(parts[4])
            except ValueError:
                continue
            lut[idx] = (parts[1], (r, g, b))
    return lut


# ---------------------------------------------------------------------------
# Region grouping.
#
# Atrophy is already a per-region lookup, so a "select the whole frontal lobe"
# or "select the default mode network" control needs nothing more than a
# region -> group mapping in regions.json. No extra volume field ships, and the
# GPU side is unchanged.
# ---------------------------------------------------------------------------

# Desikan-Killiany cortical regions -> lobe. Standard anatomical grouping.
DK_LOBE = {
    "frontal": [1002, 1003, 1012, 1014, 1017, 1018, 1019, 1020, 1024, 1026,
                1027, 1028, 1032],
    "parietal": [1008, 1010, 1022, 1023, 1025, 1029, 1031],
    "temporal": [1001, 1006, 1007, 1009, 1015, 1016, 1030, 1033, 1034],
    "occipital": [1005, 1011, 1013, 1021],
    "cingulate": [1002, 1010, 1023, 1026],
    "insula": [1035],
}

SUBCORTICAL_LOBE = {
    "basal ganglia": [11, 12, 13, 26, 50, 51, 52, 58],
    "thalamus": [10, 49],
    "limbic": [17, 18, 53, 54],
    "ventricle": [4, 5, 14, 15, 43, 44, 72],
    "cerebellum": [7, 8, 46, 47],
    "brainstem": [16, 28, 60, 85],
    "white matter": [2, 41, 77, 251, 252, 253, 254, 255],
}


def lobe_of(label: int) -> str:
    """Lobe (or coarse anatomical group) for a FreeSurfer label."""
    # Cortical labels are 1000+offset (left) and 2000+offset (right); the
    # offset is what identifies the region, so normalise the hemisphere away.
    if 1000 <= label <= 1035 or 2000 <= label <= 2035:
        base = 1000 + (label % 1000)
        # Cingulate regions also sit inside frontal/parietal lists; check the
        # more specific group first.
        for name in ("cingulate", "insula", "frontal", "parietal", "temporal", "occipital"):
            if base in DK_LOBE.get(name, []):
                return name
        return "cortex"
    for name, labels in SUBCORTICAL_LOBE.items():
        if label in labels:
            return name
    return "other"


YEO7_NAMES = [
    "none",
    "visual",
    "somatomotor",
    "dorsal attention",
    "ventral attention",
    "limbic",
    "frontoparietal",
    "default mode",
]


def yeo_network_map(subjects_dir: Path) -> dict[int, str]:
    """
    Dominant Yeo-2011 7-network assignment per Desikan-Killiany region.

    Both parcellations are per-vertex annotations on the same surface, so the
    mapping is a majority vote: for every vertex, look up its DK region and its
    Yeo network, and give each region the network most of its vertices fall in.

    Always computed from **fsaverage**, whatever subject is being built. The
    result is a relationship between two ATLASES, not a property of one brain —
    DK region names mean the same thing in every subject — so it transfers
    directly. It also has to be: only fsaverage ships the Yeo annotations, and
    reading them from an individual subject silently produced "none" for every
    region.

    This is why "atrophy the default mode network" costs nothing extra — the AD
    signature reduces to selecting a set of DK regions.
    """
    from collections import Counter

    atlas_dir = subjects_dir / "fsaverage"
    out: dict[int, Counter] = {}
    for hemi, offset in (("lh", 1000), ("rh", 2000)):
        aparc = atlas_dir / "label" / f"{hemi}.aparc.annot"
        yeo = atlas_dir / "label" / f"{hemi}.Yeo2011_7Networks_N1000.annot"
        if not aparc.exists() or not yeo.exists():
            print(f"  ! fsaverage {hemi} Yeo/aparc annot missing — no network map")
            return {}
        a_lab, _, a_names = nib.freesurfer.read_annot(str(aparc))
        y_lab, _, _ = nib.freesurfer.read_annot(str(yeo))
        n = min(len(a_lab), len(y_lab))
        for i in range(n):
            ai = a_lab[i]
            yi = y_lab[i]
            if ai < 0 or ai >= len(a_names) or yi <= 0:
                continue
            name = a_names[ai]
            name = name.decode() if isinstance(name, bytes) else name
            if name in ("unknown", "corpuscallosum"):
                continue
            # aparc annot index i corresponds to FreeSurfer label offset+i.
            fs_label = offset + int(ai)
            out.setdefault(fs_label, Counter())[int(yi)] += 1

    result: dict[int, str] = {}
    for fs_label, counter in out.items():
        top = counter.most_common(1)[0][0]
        if 0 < top < len(YEO7_NAMES):
            result[fs_label] = YEO7_NAMES[top]
    return result


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def to_gpu_order(arr: np.ndarray) -> np.ndarray:
    """
    Reorder a world-indexed [x][y][z] array into WebGPU 3D-texture byte order.

    A C-ordered numpy array runs its LAST axis fastest, so arr[x][y][z] lays out
    z-fastest. WebGPU wants x-fastest (index = x + y*W + z*W*H). Uploading
    without this transpose silently swaps the X and Z axes of the volume: the
    result still looks like a brain from most angles, which is precisely why it
    is worth a named function and a comment rather than an inline .T.
    """
    return np.ascontiguousarray(arr.transpose(2, 1, 0))


def write_gz(path: Path, arr: np.ndarray) -> int:
    """Write raw bytes in GPU texture order, gzipped. Returns compressed size."""
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = to_gpu_order(arr).tobytes()
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(raw)
    return path.stat().st_size


def resample_to_world(vol: np.ndarray, tkr: np.ndarray, half: int) -> np.ndarray:
    """
    Resample a conformed volume onto the canonical world grid.

    Output voxel (ix, iy, iz) sits at world (ix-half, iy-half, iz-half) mm, i.e.
    integer millimetres, which coincide exactly with source voxel centres.
    """
    n = 2 * half
    ax = np.arange(n, dtype=np.float64) - half

    # world (x=R, y=S, z=A) -> tkrRAS (R, A, S)
    wx = ax[:, None, None]
    wy = ax[None, :, None]
    wz = ax[None, None, :]
    R = np.broadcast_to(wx, (n, n, n))
    S = np.broadcast_to(wy, (n, n, n))
    A = np.broadcast_to(wz, (n, n, n))

    inv = np.linalg.inv(tkr)
    ones = np.ones((n, n, n))
    ijk = [
        inv[r, 0] * R + inv[r, 1] * A + inv[r, 2] * S + inv[r, 3] * ones
        for r in range(3)
    ]

    idx = []
    for a in ijk:
        rounded = np.rint(a)
        residual = float(np.abs(a - rounded).max())
        if residual > 1e-6:
            raise SystemExit(
                f"resample is not an exact voxel relabelling (residual {residual:.3g}); "
                "the source volume is probably not conformed to 1 mm"
            )
        idx.append(rounded.astype(np.int64))

    out = np.zeros((n, n, n), dtype=vol.dtype)
    inside = (
        (idx[0] >= 0) & (idx[0] < vol.shape[0])
        & (idx[1] >= 0) & (idx[1] < vol.shape[1])
        & (idx[2] >= 0) & (idx[2] < vol.shape[2])
    )
    out[inside] = vol[idx[0][inside], idx[1][inside], idx[2][inside]]
    return out


def signed_distance(mask: np.ndarray) -> np.ndarray:
    """Signed Euclidean distance in mm; negative inside the mask."""
    d_out = ndimage.distance_transform_edt(~mask)
    d_in = ndimage.distance_transform_edt(mask)
    return (d_out - d_in).astype(np.float32)


def quantise(field: np.ndarray, rng: float) -> np.ndarray:
    return np.rint(np.clip(field, -rng, rng) / rng * 127.0).astype(np.int8)


def build_sulc_field(subject_dir: Path, half: int, grid: int) -> np.ndarray | None:
    """
    Nearest-vertex sulcal depth on a coarse grid.

    This is what seeds the GPU's procedural micro-relief with *measured*
    curvature rather than invented noise: fold detail is amplitude-modulated by
    real sulcal depth, so gyral crowns and sulcal fundi get their true
    distribution. Only the thin band near cortex is ever read, where the
    nearest-vertex approximation is sub-millimetre.
    """
    from scipy.spatial import cKDTree

    verts, vals = [], []
    for hemi in ("lh", "rh"):
        surf = subject_dir / "surf" / f"{hemi}.white"
        sulc = subject_dir / "surf" / f"{hemi}.sulc"
        if not surf.exists() or not sulc.exists():
            print(f"  ! {hemi}.white/.sulc missing — skipping sulc field")
            return None
        v, _ = nib.freesurfer.read_geometry(str(surf))
        s = nib.freesurfer.read_morph_data(str(sulc))
        verts.append(v)
        vals.append(s)

    v = np.vstack(verts)            # tkrRAS (R, A, S) mm
    s = np.concatenate(vals).astype(np.float32)

    # tkrRAS -> canonical world (R, S, A)
    pts = np.column_stack([v[:, 0], v[:, 2], v[:, 1]])
    tree = cKDTree(pts)

    ax = (np.arange(grid, dtype=np.float64) + 0.5) / grid * (2 * half) - half
    gx, gy, gz = np.meshgrid(ax, ax, ax, indexing="ij")
    q = np.column_stack([gx.ravel(), gy.ravel(), gz.ravel()])
    _, nn = tree.query(q, k=1, workers=-1)
    return np.rint(np.clip(s[nn].reshape(grid, grid, grid), -2, 2) / 2 * 127).astype(np.int8)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subject", default="fsaverage")
    ap.add_argument("--subjects-dir", type=Path, default=DEFAULT_SUBJECTS_DIR)
    ap.add_argument(
        "--half",
        type=int,
        default=104,
        help="half-extent in mm; the cube is 2*half per side (default 104 -> 208^3)",
    )
    ap.add_argument("--sulc-grid", type=int, default=96)
    ap.add_argument("--vent-grid", type=int, default=128)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    t0 = time.time()
    subject_dir = args.subjects_dir / args.subject
    seg_path = subject_dir / "mri" / "aparc+aseg.mgz"
    if not seg_path.exists():
        raise SystemExit(f"not found: {seg_path}")

    n = 2 * args.half
    out_dir = args.out or (
        Path(__file__).resolve().parents[2] / "public" / "fields" / f"{args.subject}-{n}"
    )

    print(f"corticum build_fields {VERSION}")
    print(f"  subject : {args.subject}")
    print(f"  source  : {seg_path}")
    print(f"  grid    : {n}^3 @ 1 mm, half-extent {args.half} mm")

    img = nib.load(str(seg_path))
    seg = np.asarray(img.dataobj).astype(np.int32)
    tkr = img.header.get_vox2ras_tkr()

    # Fail loudly rather than silently truncating anatomy. A 192^3 cube clips
    # the occipital pole off fsaverage and the frontal pole off sample.
    nz = np.argwhere(seg > 0)
    origin = np.linalg.solve(tkr, np.array([0.0, 0.0, 0.0, 1.0]))[:3]
    dev = np.maximum(np.abs(nz.min(0) - origin), np.abs(nz.max(0) - origin)).max()
    if dev > args.half:
        raise SystemExit(
            f"half-extent {args.half} mm would clip labelled brain "
            f"(needs at least {int(np.ceil(dev))} mm). Re-run with --half {int(np.ceil(dev))}."
        )
    print(f"  fit     : brain needs {dev:.0f} mm, cube provides {args.half} mm — OK")

    print("  resampling to canonical world grid…")
    world = resample_to_world(seg, tkr, args.half)
    kept = int((world > 0).sum())
    total = int((seg > 0).sum())
    if kept != total:
        raise SystemExit(f"resample lost {total - kept} labelled voxels")
    occupancy = kept / world.size
    print(f"    {kept:,} labelled voxels preserved ({occupancy * 100:.1f}% of cube)")

    # --- tissue classes ----------------------------------------------------
    present = np.unique(world)
    tissue_lut = np.zeros(int(present.max()) + 1, dtype=np.uint8)
    for lab in present:
        tissue_lut[lab] = tissue_of(int(lab))
    tissue = tissue_lut[world]

    parenchyma = (tissue != TISSUE["background"]) & (tissue != TISSUE["csf_ventricle"])
    ventricle = np.isin(world, list(CSF_VENTRICLE - {24}))

    print("  distance transforms…")
    sdf_brain = signed_distance(parenchyma)
    sdf_vent_full = signed_distance(ventricle)

    # --- dense label remap -------------------------------------------------
    lut = load_lut()
    print("  region grouping (lobes + Yeo networks)…")
    networks = yeo_network_map(args.subjects_dir)
    order = [int(x) for x in present]
    remap = np.zeros(int(present.max()) + 1, dtype=np.uint8)
    regions = []
    for i, lab in enumerate(order):
        if i > 255:
            raise SystemExit("more than 256 distinct labels; u8 index insufficient")
        remap[lab] = i
        name, colour = lut.get(lab, (f"label_{lab}", (128, 128, 128)))
        regions.append(
            {
                "index": i,
                "fsLabel": lab,
                "name": name,
                "color": list(colour),
                "tissue": int(tissue_lut[lab]),
                "lobe": lobe_of(lab),
                "network": networks.get(lab, "none"),
                "hemisphere": (
                    "left" if (1000 <= lab <= 1035 or lab in (2, 4, 5, 7, 8, 10, 11, 12, 13, 17, 18, 26, 28, 31))
                    else "right" if (2000 <= lab <= 2035 or lab in (41, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60, 63))
                    else "midline"
                ),
            }
        )
    labels = remap[world]

    # --- ventricle SDF at reduced resolution -------------------------------
    step = n // args.vent_grid
    if step * args.vent_grid != n:
        # Fall back to interpolation when the grids are not commensurate.
        zoom = args.vent_grid / n
        sdf_vent = ndimage.zoom(sdf_vent_full, zoom, order=1)
    else:
        sdf_vent = sdf_vent_full[::step, ::step, ::step]

    print("  sulcal depth field…")
    sulc = build_sulc_field(subject_dir, args.half, args.sulc_grid)

    # --- anatomical landmarks for the compliance field ---------------------
    # The falx cerebri is a stiff midsagittal sheet, but it does NOT reach the
    # corpus callosum: it has a free edge above it. That gap is exactly why the
    # cingulate gyrus herniates *under* the falx in subfalcine herniation, so
    # the free edge has to be placed from the data rather than guessed.
    # Likewise the tentorium separates cerebrum from cerebellum, so its height
    # follows the superior extent of the cerebellum.
    landmarks = {}
    cc = np.isin(world, [251, 252, 253, 254, 255])
    if cc.any():
        ys = np.argwhere(cc)[:, 1] - args.half
        landmarks["corpusCallosumTopMm"] = float(ys.max())
        landmarks["corpusCallosumBottomMm"] = float(ys.min())
    cbm = np.isin(world, [8, 47, 7, 46])
    if cbm.any():
        ys = np.argwhere(cbm)[:, 1] - args.half
        landmarks["cerebellumTopMm"] = float(ys.max())
    brainstem = world == 16
    if brainstem.any():
        zs = np.argwhere(brainstem)[:, 2] - args.half
        landmarks["brainstemCentreZMm"] = float(zs.mean())
    print(f"  landmarks: {landmarks}")

    # --- write -------------------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = {}
    sizes["sdf_brain.i8.gz"] = write_gz(out_dir / "sdf_brain.i8.gz", quantise(sdf_brain, SDF_RANGE_MM))
    sizes["sdf_vent.i8.gz"] = write_gz(out_dir / "sdf_vent.i8.gz", quantise(sdf_vent, SDF_RANGE_MM))
    sizes["labels.u8.gz"] = write_gz(out_dir / "labels.u8.gz", labels)
    if sulc is not None:
        sizes["sulc.i8.gz"] = write_gz(out_dir / "sulc.i8.gz", sulc)

    (out_dir / "regions.json").write_text(json.dumps(regions, indent=1), encoding="utf-8")
    sizes["regions.json"] = (out_dir / "regions.json").stat().st_size

    manifest = {
        "version": VERSION,
        "subject": args.subject,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "grid": {
            "dim": n,
            "halfExtentMm": args.half,
            "spacingMm": 1.0,
            "worldAxes": "X=Right, Y=Superior, Z=Anterior",
            "centredOn": "tkrRAS origin (conformed voxel 128,128,128)",
            "byteOrder": "x-fastest (WebGPU 3D texture order)",
        },
        "sdf": {"rangeMm": SDF_RANGE_MM, "encoding": "int8, d/range*127"},
        "ventricle": {"dim": args.vent_grid},
        "sulc": {"dim": args.sulc_grid, "range": 2.0} if sulc is not None else None,
        "occupancy": round(occupancy, 4),
        "landmarks": landmarks,
        "labelCount": len(order),
        "tissueClasses": TISSUE,
        "bytes": sizes,
        "sources": {
            "aparc+aseg.mgz": sha256(seg_path),
        },
        "license": "FreeSurfer — see LICENSES/FreeSurfer.md. Derived/modified data.",
    }
    for hemi in ("lh", "rh"):
        for kind in ("white", "sulc"):
            p = subject_dir / "surf" / f"{hemi}.{kind}"
            if p.exists():
                manifest["sources"][f"{hemi}.{kind}"] = sha256(p)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    total_gz = sum(v for k, v in sizes.items())
    print(f"\n  wrote {out_dir}")
    for k, v in sizes.items():
        print(f"    {k:22s} {v / 1e6:7.3f} MB")
    print(f"    {'TOTAL':22s} {total_gz / 1e6:7.3f} MB gzipped")
    print(f"  done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
