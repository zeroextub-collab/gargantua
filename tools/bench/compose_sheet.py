"""Compose contact sheets: the reel's frames at its own timestamps on the top row, then each volume's renders
at the same director times. Reel frames are third-party; sheets stay in work/ (gitignored).

    pipeline/.venv/Scripts/python tools/bench/compose_sheet.py OUT.jpg name1 name2 ... [--extra]
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
REEL = {"r00.0_solid": 0, "r01.7_dissolve": 17, "r03.8_topdown": 38, "r05.4_headon": 54, "r07.2_inside": 72, "r10.3_back": 103}
EXTRA = ["x_separated", "x_worldlines"]
TILE = 300


def tile(img: np.ndarray | None, label: str) -> np.ndarray:
    t = np.zeros((TILE, TILE, 3), np.uint8) if img is None else cv2.resize(img, (TILE, int(TILE * img.shape[0] / img.shape[1])), interpolation=cv2.INTER_AREA)
    t = cv2.copyMakeBorder(t, 0, max(0, TILE - t.shape[0]), 0, 0, cv2.BORDER_CONSTANT, value=0)[:TILE]
    cv2.rectangle(t, (0, 0), (TILE, 18), (0, 0, 0), -1)
    cv2.putText(t, label, (4, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (120, 200, 255), 1, cv2.LINE_AA)
    return t


def main() -> None:
    out = Path(sys.argv[1])
    names = [a for a in sys.argv[2:] if not a.startswith("--")]
    extra = "--extra" in sys.argv
    poses = list(REEL) + (EXTRA if extra else [])
    rows = [np.hstack([tile(cv2.imread(str(ROOT / "work" / "p1" / "frames" / f"f_{REEL[p]:04d}.png")), f"REEL t={REEL[p] / 10:.1f}s")
                       if p in REEL else tile(None, p) for p in poses])]
    rows.extend(np.hstack([tile(cv2.imread(str(ROOT / "work" / "contact" / n / f"{p}.png")), f"{n} {p}") for p in poses]) for n in names)
    sheet = np.vstack(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(out, sheet.shape)


if __name__ == "__main__":
    main()
