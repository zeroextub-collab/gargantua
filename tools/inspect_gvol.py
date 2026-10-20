"""Dump a .gvol's header summary and its derived layers as PNGs for eyeballing and contact sheets.

Usage: pipeline/.venv/Scripts/python tools/inspect_gvol.py work/volumes/clip8.gvol [out_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline" / "src"))
from gargantua.pack import read_gvol


def hsv_color(angle: float, speed: float) -> tuple[int, int, int]:
    hsv = np.uint8([[[int((angle % 360) / 2), 220, int(120 + 135 * min(speed, 1.0))]]])
    b, g, r = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0]
    return int(b), int(g), int(r)


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix("")
    out.mkdir(parents=True, exist_ok=True)
    hdr, s = read_gvol(src)
    vol = s["volume"]
    t, h, w, _ = vol.shape
    summary = {k: hdr[k] for k in ("plan", "camera", "evidence", "worldlines", "look", "timings_s")}
    summary["analysis"] = {k: hdr["analysis"][k] for k in ("category", "tags", "quality", "stats")}
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))

    bgr = lambda rgb: cv2.cvtColor(np.ascontiguousarray(rgb), cv2.COLOR_RGB2BGR)  # noqa: E731
    bg = s["background"]
    cv2.imwrite(str(out / "background.png"), bgr(bg[..., :3]))
    cv2.imwrite(str(out / "bg_support.png"), bg[..., 3])
    cv2.imwrite(str(out / "flicker.png"), s["flicker"])
    a_max = vol[::2, ..., 3].max(0)
    a_mean = vol[::2, ..., 3].astype(np.float32).mean(0)
    cv2.imwrite(str(out / "evidence_max.png"), a_max)
    cv2.imwrite(str(out / "evidence_mean.png"), np.clip(a_mean * 4, 0, 255).astype(np.uint8))
    for frac in (0.1, 0.5, 0.9):
        i = int(frac * (t - 1))
        rgb = vol[i, ..., :3]
        a = vol[i, ..., 3:4].astype(np.float32) / 255
        side = np.hstack([bgr(rgb), cv2.cvtColor(vol[i, ..., 3], cv2.COLOR_GRAY2BGR), bgr((rgb * a).astype(np.uint8))])
        cv2.imwrite(str(out / f"slice_{int(frac * 100):02d}.png"), side)
    # worldlines over the background, coloured by direction, brightness by speed
    canvas = (bgr(bg[..., :3]).astype(np.float32) * 0.35).astype(np.uint8)
    if "track_points" in s:
        pts, lens = s["track_points"], s["track_len"]
        off = np.concatenate([[0], np.cumsum(lens, dtype=np.int64)]).astype(np.int64)
        speeds = s["track_speed"]
        vmax = np.percentile(speeds, 95) + 1e-6
        for k in range(len(lens)):
            p = pts[off[k] : off[k + 1]] * np.array([w, h])
            d = p[-1] - p[0]
            col = hsv_color(np.degrees(np.arctan2(d[1], d[0])), speeds[k] / vmax)
            cv2.polylines(canvas, [np.round(p).astype(np.int32)], False, col, 1, cv2.LINE_AA)
    cam = s["camera_path"] * np.array([w, h])
    cv2.polylines(canvas, [np.round(cam).astype(np.int32)], False, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.imwrite(str(out / "worldlines.png"), canvas)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
