"""Screen-detector cues inside hand-labelled regions of the user's night clip, plus a mask overlay.

    pipeline/.venv/Scripts/python tools/bench/flicker_regions.py work/volumes/clip8.gvol

The regions were labelled by eye on Video_Project_8 (relative x0, y0, x1, y1). They are approximate, not
ground truth; they show which cue separates animated screens from walkers on real footage. Writes
work/flicker/<name>_regions.json and <name>_overlay.jpg.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))
from gargantua.evidence import flicker_mask, flow_magnitude  # noqa: E402
from gargantua.pack import read_gvol  # noqa: E402

REGIONS = {  # kind, relative box
    "screen: UC sign": ("screen", (0.115, 0.204, 0.198, 0.333)),
    "screen: centre building top": ("screen", (0.475, 0.052, 0.579, 0.156)),
    "screen: centre building middle": ("screen", (0.475, 0.326, 0.588, 0.437)),
    "screen: right, lower": ("screen", (0.871, 0.481, 0.983, 0.585)),
    "walkers: crowd centre": ("walkers", (0.375, 0.741, 0.688, 0.963)),
    "walkers: crowd on bright stripes": ("walkers", (0.021, 0.685, 0.229, 0.926)),
    "static: lit facade": ("static", (0.313, 0.407, 0.417, 0.630)),
}


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "work" / "volumes" / "clip8.gvol")
    _, sec = read_gvol(path)
    frames = np.ascontiguousarray(sec["volume"][..., :3])
    flow = flow_magnitude(frames)
    mask = flicker_mask(frames, flow)
    p50, p75 = np.percentile(flow.luma_peak, [50, 75])
    rel = (flow.luma_peak - p50) / max(p75 - p50, 10.0)
    sh, sw = flow.region_std.shape
    t, h, w, _ = frames.shape
    out = {"volume": path.name, "mask_frac": round(float((mask > 0.5).mean()), 4), "regions": {}}
    for name, (kind, (x0, y0, x1, y1)) in REGIONS.items():
        sl = (slice(int(y0 * sh), int(y1 * sh)), slice(int(x0 * sw), int(x1 * sw)))
        full = (slice(int(y0 * h), int(y1 * h)), slice(int(x0 * w), int(x1 * w)))
        out["regions"][name] = {
            "kind": kind,
            "region_std": round(float(np.median(flow.region_std[sl])), 2),
            "unexplained": round(float(np.median(flow.unexplained[sl])), 3),
            "peak_rel": round(float(np.median(rel[sl])), 2),
            "mask_cover": round(float((mask[full] > 0.5).mean()), 3),
        }
    dest = ROOT / "work" / "flicker"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{path.stem}_regions.json").write_text(json.dumps(out, indent=1))
    frame = np.ascontiguousarray(frames[t // 2][..., ::-1]).copy()
    m = mask > 0.5
    frame[m] = (0.45 * frame[m] + np.array([0, 140, 0])).astype(np.uint8)
    for kind, (x0, y0, x1, y1) in REGIONS.values():
        col = {"screen": (0, 255, 255), "walkers": (255, 160, 60), "static": (200, 200, 200)}[kind]
        cv2.rectangle(frame, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), col, 1)
    cv2.imwrite(str(dest / f"{path.stem}_overlay.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"mask covers {out['mask_frac']:.1%} of the frame")
    print(f"{'region':34s} {'std':>6s} {'unexpl':>7s} {'peak':>6s} {'mask':>6s}")
    for name, r in out["regions"].items():
        print(f"{name:34s} {r['region_std']:6.1f} {r['unexplained']:7.3f} {r['peak_rel']:6.2f} {r['mask_cover']:6.2f}")


if __name__ == "__main__":
    main()
