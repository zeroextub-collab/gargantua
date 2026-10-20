"""Look Director inputs computed at preprocess time; the viewer turns them into shader parameters.

The REEL target comes from docs/REEL_ANALYSIS.md: smoke/pavement display ratio ~0.25 at the measured
pose; the renderer fits sigma to it (viewer/src/look/LookDirector.ts). Here we only measure the clip.
"""

from __future__ import annotations

import numpy as np

PRESETS = {
    # category -> defaults the viewer starts from (all overridable, saved as JSON presets)
    "sparse_overhead": {"mode": "reel", "sep": 0.0, "worldlines": False, "flicker": "keep", "bloom": 0.12},
    "dense_crowd": {"mode": "separated", "sep": 0.65, "worldlines": True, "flicker": "keep", "bloom": 0.15},
    "night_lights": {"mode": "reel", "sep": 0.35, "worldlines": True, "flicker": "scenery", "bloom": 0.22},
    "handheld": {"mode": "reel", "sep": 0.0, "worldlines": False, "flicker": "keep", "bloom": 0.12, "camera_path": True},
    "nature": {"mode": "reel", "sep": 0.2, "worldlines": False, "flicker": "keep", "bloom": 0.15},
}


def look_params(frames: np.ndarray, evidence: np.ndarray, category: str) -> dict:
    step = max(1, frames.shape[0] // 60)
    sub = frames[::step, ::2, ::2].astype(np.float32)
    luma = 0.2126 * sub[..., 0] + 0.7152 * sub[..., 1] + 0.0722 * sub[..., 2]
    lo, hi = np.percentile(luma, [0.5, 99.5])
    emissive = float(np.percentile(luma, 99.7))
    mean_a = float(evidence[::step, ::2, ::2].mean() / 255.0)
    mean_rgb = sub.reshape(-1, 3).mean(0) / 255.0
    return {
        "stretch_black": round(float(lo) / 255, 4),
        "stretch_white": round(float(max(hi, lo + 20)) / 255, 4),
        "emissive_luma": round(min(emissive, 250.0) / 255, 4),
        "mean_evidence": round(mean_a, 5),
        "mean_rgb": [round(float(x), 4) for x in mean_rgb],
        "preset": category,
        "preset_defaults": PRESETS.get(category, PRESETS["sparse_overhead"]),
    }


def bricks(evidence: np.ndarray, size: int = 8) -> np.ndarray:
    """Max evidence per size^3 brick, for empty-space skipping in SEPARATED mode."""
    t, h, w = evidence.shape
    bt, bh, bw = -(-t // size), -(-h // size), -(-w // size)
    pad = np.zeros((bt * size, bh * size, bw * size), np.uint8)
    pad[:t, :h, :w] = evidence
    return pad.reshape(bt, size, bh, size, bw, size).max(axis=(1, 3, 5))
