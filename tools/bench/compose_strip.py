"""Reel frames (top) over director renders (bottom) at the same times: work/contact/strip.jpg.

    pipeline/.venv/Scripts/python tools/bench/compose_strip.py 3.4,3.5,...
"""

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1].parent
times = [float(t) for t in sys.argv[1].split(",")]
rows = [[], []]
for t in times:
    reel = cv2.imread(str(ROOT / "work" / "p1" / "frames" / f"f_{round(t * 10):04d}.png"))
    ours = cv2.imread(str(ROOT / "work" / "contact" / "strip" / f"t{t:.1f}.png"))
    for k, im in enumerate((reel, ours)):
        im = cv2.resize(im, (218, 220), interpolation=cv2.INTER_AREA)
        cv2.putText(im, f"{'reel' if k == 0 else 'ours'} {t:.1f}s", (5, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
        rows[k].append(im)
cv2.imwrite(str(ROOT / "work" / "contact" / "strip.jpg"), np.vstack([np.hstack(r) for r in rows]))
print("work/contact/strip.jpg")
