from __future__ import annotations

from gargantua import synth
from gargantua.analyze import analyze_frames


def test_handheld_parallax_clip_scores_poor_with_camera_reason():
    frames, _ = synth.parallax_scene(T=120)
    a = analyze_frames(frames, fps=30.0)
    assert a["quality"]["grade"] == "Poor"
    assert any("camera" in r.lower() or "parallax" in r.lower() for r in a["quality"]["reasons"])
    assert a["category"] == "handheld"


def test_static_sparse_clip_scores_excellent_or_ok():
    frames, _ = synth.sparse_overhead(T=120, size=(640, 360))
    a = analyze_frames(frames, fps=30.0)
    assert a["quality"]["grade"] in ("Excellent", "OK")
    assert a["category"] == "sparse_overhead"


def test_dense_crowd_is_categorized_as_dense():
    frames, _ = synth.dense_crowd(T=120)
    a = analyze_frames(frames, fps=30.0)
    assert a["category"] == "dense_crowd"


def test_night_screens_are_categorized_as_night_lights():
    frames, _ = synth.flicker_screens(T=120)
    a = analyze_frames(frames, fps=30.0)
    assert a["category"] == "night_lights"


def test_users_walk_clip_scores_poor_for_camera_reasons():
    """P2 gate: the hand-held 4K walk must score Poor, citing forward motion and parallax."""
    from pathlib import Path

    import pytest

    from gargantua.camera import estimate_motion
    from gargantua.ingest import decode, plan_ingest
    from gargantua.probe import probe

    clip = Path(__file__).resolve().parents[2] / "input" / "walk_portrait_4k.mp4"
    if not clip.exists():
        pytest.skip("user clip not present")
    info = probe(clip)
    plan = plan_ingest(info, tier="S")
    frames = decode(clip, plan)
    a = analyze_frames(frames, plan.work_fps, estimate_motion(frames, plan.work_fps))
    text = " ".join(a["quality"]["reasons"]).lower()
    assert a["quality"]["grade"] == "Poor"
    assert "forward" in text and "parallax" in text, a["quality"]["reasons"]
