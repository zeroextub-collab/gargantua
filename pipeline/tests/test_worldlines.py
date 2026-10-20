from __future__ import annotations

import numpy as np

from gargantua import synth
from gargantua.worldlines import match_to_truth, track


def test_tracks_follow_blob_motion():
    frames, truth = synth.sparse_blobs(T=120)
    tracks = track(frames, max_tracks=800)
    assert len(tracks) > 20
    stats = match_to_truth(tracks, truth["centers"], frames.shape[2], frames.shape[1])
    assert stats["coverage"] >= 0.8, stats  # most movers get at least one track
    assert stats["velocity_err_px_median"] < 0.5, stats


def test_static_background_corners_are_not_reported_as_worldlines():
    frames, truth = synth.sparse_blobs(T=120)
    tracks = track(frames, max_tracks=800)
    stats = match_to_truth(tracks, truth["centers"], frames.shape[2], frames.shape[1])
    assert stats["unmatched_frac"] < 0.15, stats


def test_track_points_are_normalized_and_time_ordered():
    frames, _ = synth.sparse_blobs(T=60)
    for tr in track(frames, max_tracks=200)[:50]:
        assert tr.points.shape[1] == 2
        assert np.all((tr.points >= 0) & (tr.points <= 1))
        assert tr.start >= 0 and tr.start + len(tr.points) <= 60


def test_tracks_on_animated_screens_are_excluded():
    """Changing screen content produces KLT 'movement' that is not an object; the flicker mask removes it."""
    from gargantua.evidence import flicker_mask, flow_magnitude

    frames, truth = synth.flicker_screens(T=120)
    mask = flicker_mask(frames, flow_magnitude(frames))
    h, w = frames.shape[1:3]
    tracks = track(frames, max_tracks=800, exclude_mask=mask)
    on_screen = 0
    for tr in tracks:
        mid = tr.points[len(tr.points) // 2] * np.array([w, h])
        on_screen += bool(truth["screens"][min(h - 1, int(mid[1])), min(w - 1, int(mid[0]))])
    assert on_screen / max(len(tracks), 1) < 0.05, (on_screen, len(tracks))


def test_stabilised_frames_are_not_camera_compensated_twice():
    """Regression: worldlines were computed on stabilised frames AND compensated with the camera model again,
    which made static scenery look like it moved (the inverse camera path) on the user's jittery night clip.
    (On the smooth synthetic drift the double path passes the step filter only rarely, so the guard here is the
    wiring decision; the real-clip symptom is checked in docs/BENCH.md via straight-track share.)"""
    from gargantua.camera import estimate_motion
    from gargantua.cli import worldline_camera

    frames, _ = synth.camera_scene("drift", T=60)
    motion = estimate_motion(frames, fps=30.0)
    assert worldline_camera(motion, stabilized=True) is None
    assert worldline_camera(motion, stabilized=False) is motion


def test_jittering_static_points_are_not_movers():
    """Real footage (noise, compression, stabilisation interpolation) makes static corners jitter 0.3-0.5 px
    every frame. A mover travels; jitter does not accumulate. Measured on the user's night clip: 73% of tracks
    were static corners jittering in place before this test existed."""
    import cv2

    frames, truth = synth.sparse_blobs(T=120)
    rng = np.random.default_rng(0)
    h, w = frames.shape[1:3]
    jit = np.empty_like(frames)
    for i, f in enumerate(frames):
        m = np.float32([[1, 0, rng.normal(0, 0.35)], [0, 1, rng.normal(0, 0.35)]])
        g = cv2.warpAffine(f, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT).astype(np.int16)
        jit[i] = np.clip(g + rng.normal(0, 3, g.shape), 0, 255).astype(np.uint8)
    tracks = track(jit, max_tracks=800)
    stats = match_to_truth(tracks, truth["centers"], w, h)
    assert stats["unmatched_frac"] < 0.2, stats
    assert stats["coverage"] >= 0.8, stats
