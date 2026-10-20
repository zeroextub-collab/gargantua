"""Clip analyzer: statistics, category (preset choice) and a CLIP QUALITY SCORE with reasons."""

from __future__ import annotations

import cv2
import numpy as np

from .camera import CameraMotion, estimate_motion
from .evidence import bg_hybrid, flicker_mask, flow_magnitude

GRADES = ("Excellent", "OK", "Poor")


def _small(frames: np.ndarray, max_width: int = 480, max_frames: int = 240) -> np.ndarray:
    t, h, w, _ = frames.shape
    step = max(1, int(np.ceil(t / max_frames)))
    s = min(1.0, max_width / w)
    sw, sh = int(round(w * s)), int(round(h * s))
    return np.stack([cv2.resize(f, (sw, sh), interpolation=cv2.INTER_AREA) for f in frames[::step]])


def analyze_frames(frames: np.ndarray, fps: float, motion: CameraMotion | None = None, duration: float | None = None,
                   source_short_side: int | None = None) -> dict:
    small = _small(frames)
    t = small.shape[0]
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in small]).astype(np.float32)
    hsv = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2HSV) for f in small[:: max(1, t // 30)]])
    p1, p50, p99 = (float(np.percentile(gray[:: max(1, t // 30)], q)) for q in (1, 50, 99))
    sat = float(hsv[..., 1].mean() / 255)
    hue = hsv[..., 0].astype(np.float32) * 2
    greenish = float(((hue > 70) & (hue < 170) & (hsv[..., 1] > 60)).mean())
    if motion is None:
        motion = estimate_motion(frames, fps)
    bg, support, _ = bg_hybrid(small)
    if motion.cls in ("static", "drift"):
        diff = np.abs(small.astype(np.int16) - bg[None].astype(np.int16)).max(-1)
        moving_frac = float((diff > 30).mean())
        low_support = float((support < 0.5).mean())
    else:
        diff = np.abs(np.diff(gray, axis=0))
        moving_frac = float((diff > 20).mean())
        low_support = float("nan")
    if motion.cls in ("static", "drift"):
        flow = flow_magnitude(small, max_width=320)
        flick = flicker_mask(small, flow)
        flicker_frac = float((flick > 0.5).mean())
    else:  # with a moving camera, unexplained brightness change is everywhere; the detector is not valid
        flicker_frac = 0.0
    emissive_frac = float(((gray > 200) & (hsv[..., 1].mean() > 0)).mean()) if p50 < 70 else 0.0

    tags = []
    if motion.cls in ("handheld", "pan"):
        tags.append("handheld")
    if p50 < 70 and (flicker_frac > 0.01 or emissive_frac > 0.01):
        tags.append("night_lights")
    if moving_frac > 0.12 or (low_support == low_support and low_support > 0.25):
        tags.append("dense_crowd")
    if greenish > 0.35 and sat > 0.25:
        tags.append("nature")
    if not tags:
        tags.append("sparse_overhead")
    category = tags[0]

    reasons, grade = [], 0

    def flag(level: int, text: str):
        nonlocal grade
        grade = max(grade, level)
        reasons.append(text)

    if motion.cls == "handheld":
        for r in motion.reasons or ["camera moves a lot"]:
            flag(2, r)
        flag(2, "raw frames are shown unaligned: static content smears into streaks along time; parallax cannot be corrected")
    elif motion.cls == "pan":
        for r in motion.reasons:
            flag(2, r)
    elif motion.cls == "drift":
        flag(1, motion.reasons[0] if motion.reasons else "camera drifts slightly")
    dur = duration if duration is not None else frames.shape[0] / fps
    if dur < 2.0:
        flag(2, f"very short clip ({dur:.1f}s): the time axis will be thin")
    elif dur < 4.0:
        flag(1, f"short clip ({dur:.1f}s)")
    if p50 < 25:
        flag(1, f"very dark (median luma {p50:.0f}/255): smoke will be dim; exposure stretch applied")
    if moving_frac < 0.002 and motion.cls == "static":
        flag(1, "almost nothing moves: the cube will look like an extruded still")
    if moving_frac > 0.30:
        flag(1, f"dense motion ({moving_frac:.0%} of pixels differ from the background): REEL smoke will be muddy; "
                "use SEPARATED mode + worldlines")
    if flicker_frac > 0.05:
        flag(1, f"large animated screens ({flicker_frac:.0%} of frame): choose keep / scenery / suppress")
    if source_short_side is not None and source_short_side < 360:
        flag(1, f"low resolution source ({source_short_side}px short side)")
    if not reasons:
        reasons.append("static camera, clear movers, good exposure")

    return {
        "category": category,
        "tags": tags,
        "quality": {"grade": GRADES[grade], "reasons": reasons},
        "camera": {"class": motion.cls, **{k: round(v, 4) if isinstance(v, float) else v for k, v in motion.metrics.items()}},
        "stats": {
            "luma_p1": round(p1, 1), "luma_p50": round(p50, 1), "luma_p99": round(p99, 1),
            "saturation": round(sat, 3), "greenish_frac": round(greenish, 3),
            "moving_frac": round(moving_frac, 4), "low_support_frac": None if low_support != low_support else round(low_support, 4),
            "flicker_frac": round(flicker_frac, 4), "emissive_frac": round(emissive_frac, 4),
        },
    }
