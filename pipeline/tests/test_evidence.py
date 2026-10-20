from __future__ import annotations

import numpy as np
import pytest

from gargantua import synth
from gargantua.evidence import (
    bg_hybrid,
    bg_median,
    bg_mode,
    bg_sliding,
    evidence_field,
    flicker_mask,
    flow_magnitude,
    motion_energy,
    support_of,
)


def bg_error(est: np.ndarray, truth: np.ndarray, region=None) -> float:
    d = np.abs(est.astype(np.float32) - truth.astype(np.float32)).mean(-1)
    return float(d[region].mean() if region is not None else d.mean())


@pytest.fixture(scope="module")
def sparse():
    return synth.sparse_blobs(T=120)


@pytest.fixture(scope="module")
def dense():
    return synth.dense_crowd(T=160)


def test_dense_scene_really_hides_background_more_than_half_the_time(dense):
    _, truth = dense
    assert truth["meta"]["bg_visible_frac_band"] < 0.5


def test_mode_beats_median_when_background_visible_20_to_50_percent(dense):
    """The user's hypothesis, with the boundary the measurement found: plain mode wins while the
    background is still the most frequent colour (about 20-50% visibility here)."""
    frames, truth = dense
    vis = 1 - truth["masks"].mean(0)
    sel = (vis >= 0.2) & (vis < 0.5)
    e_med = bg_error(bg_median(frames), truth["background"], sel)
    e_mode = bg_error(bg_mode(frames)[0], truth["background"], sel)
    assert e_mode < 0.3 * e_med, (e_mode, e_med)


def test_hybrid_beats_median_where_background_is_mostly_hidden(dense):
    frames, truth = dense
    band = np.zeros(frames.shape[1:3], bool)
    band[int(frames.shape[1] * 0.4):] = True
    e_med = bg_error(bg_median(frames), truth["background"], band)
    e_hyb = bg_error(bg_hybrid(frames)[0], truth["background"], band)
    assert e_hyb < 0.6 * e_med, (e_hyb, e_med)


def test_capped_mode_recovers_background_glimpsed_15_to_20_percent(dense):
    """A slow walker dwelling over a pixel outnumbers scattered background glimpses; capping each
    temporal run counts separate visits instead. Measured: this helps at 15-20% visibility; below
    ~12% nothing recovers the background (docs/BENCH.md)."""
    frames, truth = dense
    vis = 1 - truth["masks"].mean(0)
    sel = (vis >= 0.15) & (vis < 0.2)
    e_mode = bg_error(bg_mode(frames)[0], truth["background"], sel)
    e_cap = bg_error(bg_mode(frames, run_cap=8)[0], truth["background"], sel)
    assert e_cap < 0.5 * e_mode, (e_cap, e_mode)


def test_hybrid_is_no_worse_than_median_on_sparse_scene(sparse):
    frames, truth = sparse
    e_med = bg_error(bg_median(frames), truth["background"])
    e_hyb = bg_error(bg_hybrid(frames)[0], truth["background"])
    assert e_hyb <= e_med + 0.25, (e_hyb, e_med)


def test_support_is_high_on_static_background(sparse):
    frames, truth = sparse
    support = support_of(frames, truth["background"], tol=12)
    never_covered = ~truth["masks"].any(0)
    assert np.median(support[never_covered]) > 0.95


def test_sliding_background_tracks_a_lighting_change(sparse):
    frames, _ = sparse
    f = frames.astype(np.int16).copy()
    f[60:] = np.clip(f[60:] + 40, 0, 255)  # lights switch on halfway
    f = f.astype(np.uint8)
    per_frame = bg_sliding(f, fps=30.0, window_s=1.0, hop_s=0.5)
    assert per_frame.shape == f.shape
    early = np.abs(per_frame[10].astype(int) - f[10].astype(int)).mean()
    late = np.abs(per_frame[110].astype(int) - f[110].astype(int)).mean()
    assert early < 6 and late < 6


def test_motion_energy_concentrates_on_movers(sparse):
    frames, truth = sparse
    e = motion_energy(frames, k=2).astype(np.float32)
    inside = e[truth["masks"]].mean()
    outside = e[~truth["masks"]].mean()
    assert inside > 6 * outside


def test_flicker_mask_finds_screens_not_walkers():
    frames, truth = synth.flicker_screens(T=120)
    flow = flow_magnitude(frames)
    mask = flicker_mask(frames, flow) > 0.5
    screens = truth["screens"]
    iou = (mask & screens).sum() / max((mask | screens).sum(), 1)
    walker_area = truth["masks"].any(0) & ~screens
    assert iou > 0.6, iou
    assert (mask & walker_area).sum() / max(walker_area.sum(), 1) < 0.1


def test_evidence_field_recalls_movers_on_sparse_scene(sparse):
    frames, truth = sparse
    bg, conf, _ = bg_hybrid(frames)
    a = evidence_field(frames, bg, conf, motion_energy(frames), flow_magnitude(frames), None) > 127
    m = truth["masks"]
    recall = (a & m).sum() / m.sum()
    precision = (a & m).sum() / max(a.sum(), 1)
    assert recall > 0.8 and precision > 0.8, (recall, precision)


def test_evidence_ignores_one_pixel_misalignment_of_static_edges():
    """Residual stabilisation error shifts static edges by ~1 px; on sharp high-contrast edges (zebra
    stripes, neon) that must not read as motion."""
    frames, truth = synth.sparse_overhead(T=80, size=(640, 360))
    bg, conf, _ = bg_hybrid(frames)
    shifted = frames.copy()
    shifted[::2] = np.roll(frames[::2], 1, axis=2)  # every other frame misaligned by 1 px horizontally
    a = evidence_field(shifted, bg, conf, motion_energy(shifted), None, None) > 127
    static = ~truth["masks"].any(0)
    false_pos = a[:, static].mean()
    recall = (a & truth["masks"]).sum() / truth["masks"].sum()
    assert false_pos < 0.005, false_pos
    assert recall > 0.75, recall


@pytest.mark.parametrize("scene", ["dense_crowd", "dense_crowd_dark", "crowd_grows"])
def test_crowds_are_not_mistaken_for_animated_screens(scene):
    """Uniformly coloured walkers defeat optical flow (aperture problem) but they are not screens."""
    frames, _ = synth.SCENES[scene](T=120)
    mask = flicker_mask(frames, flow_magnitude(frames)) > 0.5
    assert mask.mean() < 0.01, mask.mean()


def test_users_night_clip_screens_are_found_and_its_crowd_is_not():
    """Regression: a detector tuned only on synthetic screens found 0% screens on the user's clip, because
    optical flow partly 'explains' changing screen content. Regions labelled by eye (approximate); the same
    boxes are measured by tools/bench/flicker_regions.py."""
    from pathlib import Path

    from gargantua.camera import estimate_motion, stabilize
    from gargantua.ingest import decode, plan_ingest
    from gargantua.probe import probe

    clip = Path(__file__).resolve().parents[2] / "input" / "Video_Project_8.mp4"
    if not clip.exists():
        pytest.skip("user clip not present")
    plan = plan_ingest(probe(clip), tier="S")
    frames = decode(clip, plan)
    frames = stabilize(frames, estimate_motion(frames, plan.work_fps))  # as the pipeline does for drift
    mask = flicker_mask(frames, flow_magnitude(frames)) > 0.5
    h, w = mask.shape

    def cover(x0, y0, x1, y1):
        return mask[int(y0 * h) : int(y1 * h), int(x0 * w) : int(x1 * w)].mean()

    screens = {"UC sign": (0.115, 0.204, 0.198, 0.333), "centre top": (0.475, 0.052, 0.579, 0.156),
               "centre middle": (0.475, 0.326, 0.588, 0.437), "right lower": (0.871, 0.481, 0.983, 0.585)}
    others = {"crowd centre": (0.375, 0.741, 0.688, 0.963), "crowd on stripes": (0.021, 0.685, 0.229, 0.926),
              "lit facade": (0.313, 0.407, 0.417, 0.630)}
    found = {k: round(float(cover(*b)), 2) for k, b in screens.items()}
    false = {k: round(float(cover(*b)), 2) for k, b in others.items()}
    assert all(v > 0.5 for v in found.values()), found
    assert all(v < 0.05 for v in false.values()), false
    assert 0.02 < mask.mean() < 0.15, mask.mean()
