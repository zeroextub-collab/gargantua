from __future__ import annotations

import numpy as np
import pytest

from gargantua import synth
from gargantua.camera import estimate_motion, stabilize, transform_error_px


@pytest.fixture(scope="module")
def scenes():
    return {
        "static": synth.sparse_blobs(T=120),
        "drift": synth.camera_scene("drift", T=120),
        "pan": synth.camera_scene("pan", T=120),
        "parallax": synth.parallax_scene(T=120),
        "dense_static": synth.dense_crowd(T=120),
        "long_drift": synth.camera_scene("drift", T=180),
    }


@pytest.mark.parametrize(("name", "expected"), [("static", "static"), ("drift", "drift"), ("pan", "pan"), ("parallax", "handheld"),
                                               ("dense_static", "static"), ("long_drift", "drift")])
def test_camera_class(scenes, name, expected):
    frames, _ = scenes[name]
    motion = estimate_motion(frames, fps=30.0)
    assert motion.cls == expected, (motion.cls, motion.metrics, motion.reasons)


@pytest.mark.parametrize("name", ["drift", "pan"])
def test_estimated_path_matches_truth_within_half_a_pixel(scenes, name):
    frames, truth = scenes[name]
    motion = estimate_motion(frames, fps=30.0)
    err = transform_error_px(motion.to_ref, truth["cam"], frames.shape[2], frames.shape[1])
    assert err < 0.5, err


def test_stabilizing_drift_reduces_temporal_variation_of_static_pixels(scenes):
    frames, truth = scenes["drift"]
    motion = estimate_motion(frames, fps=30.0)
    stable = stabilize(frames, motion)
    static = ~truth["masks"].any(0)
    h, w = static.shape
    core = np.zeros_like(static)
    core[30 : h - 30, 30 : w - 30] = True  # ignore the warped border
    sel = static & core
    before = frames.astype(np.float32).std(0).mean(-1)[sel].mean()
    after = stable.astype(np.float32).std(0).mean(-1)[sel].mean()
    assert after < 0.5 * before, (before, after)


def test_users_night_clip_is_drift_not_pan():
    """Regression: per-frame estimation noise on a night scene full of changing screens once read as a pan."""
    from pathlib import Path

    from gargantua.ingest import decode, plan_ingest
    from gargantua.probe import probe

    clip = Path(__file__).resolve().parents[2] / "input" / "Video_Project_8.mp4"
    if not clip.exists():
        pytest.skip("user clip not present")
    info = probe(clip)
    plan = plan_ingest(info, tier="S")
    motion = estimate_motion(decode(clip, plan), plan.work_fps)
    assert motion.cls == "drift", (motion.cls, motion.metrics)
