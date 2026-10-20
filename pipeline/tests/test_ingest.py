from __future__ import annotations

import numpy as np
import pytest

from gargantua.ingest import IngestError, choose_tier, decode, plan_ingest
from gargantua.probe import parse_probe, probe

# ---------------------------------------------------------------- probe (real ffprobe JSON from P0)


def test_probe_landscape_clip_facts(probe_json):
    info = parse_probe(probe_json("Video_Project_8"), "Video_Project_8.mp4")
    assert (info.display_width, info.display_height) == (1920, 1080)
    assert info.fps == pytest.approx(30.0)
    assert info.nb_frames == 422
    assert info.duration == pytest.approx(14.0667, abs=1e-3)
    assert info.has_audio is True
    assert info.hdr is False
    assert info.bit_depth == 8


def test_probe_portrait_clip_facts(probe_json):
    info = parse_probe(probe_json("walk_portrait_4k"), "walk.mp4")
    assert (info.display_width, info.display_height) == (2160, 3840)
    assert info.fps == pytest.approx(29.97, abs=0.01)
    assert info.has_audio is False


def test_probe_reads_rotation_and_swaps_display_size(media):
    info = probe(media["rotated"])
    assert info.rotation in (90, 270)
    assert (info.width, info.height) == (320, 180)
    assert (info.display_width, info.display_height) == (180, 320)


def test_probe_flags_hdr_and_bit_depth(media):
    info = probe(media["hdr10"])
    assert info.hdr is True
    assert info.bit_depth == 10


def test_probe_applies_sample_aspect_ratio(media):
    info = probe(media["odd"])
    assert info.display_width == round(250 * 4 / 3)  # SAR 4:3 widens the display
    assert info.display_height == 190


def test_probe_rejects_non_video(media):
    with pytest.raises(IngestError, match=r"no video stream|could not read"):
        probe(media["notvideo"])


# ---------------------------------------------------------------- planning


def test_tier_landscape_clip_lands_on_960x540_under_default_budget():
    w, h, name = choose_tier(1920, 1080, 422, budget_bytes=1.1e9)
    assert (w, h, name) == (960, 540, "M")


def test_tier_portrait_clip_lands_on_720x1280():
    w, h, name = choose_tier(2160, 3840, 279, budget_bytes=1.1e9)
    assert (w, h, name) == (720, 1280, "L")


def test_tier_never_exceeds_2048_on_any_axis():
    w, h, _ = choose_tier(4000, 400, 100, budget_bytes=5e9)  # 10:1 panorama
    assert max(w, h) <= 2048
    assert w % 4 == 0 and h % 4 == 0


def test_tier_falls_back_to_smallest_when_budget_tiny():
    w, h, name = choose_tier(1920, 1080, 450, budget_bytes=1e6)
    assert name == "S"
    assert min(w, h) == 360


def test_plan_trims_long_clip_to_15s(probe_json):
    info = parse_probe(probe_json("Video_Project_8"), "x.mp4")
    info = info.__class__(**{**info.__dict__, "duration": 22.0, "nb_frames": 660})
    plan = plan_ingest(info)
    assert plan.duration == pytest.approx(15.0)
    assert plan.n_frames == 450
    assert any("trim" in n.lower() for n in plan.notes)


def test_plan_resamples_60fps_to_30(media):
    plan = plan_ingest(probe(media["fps60"]))
    assert plan.work_fps == pytest.approx(30.0)
    assert any("60" in n for n in plan.notes)


def test_plan_keeps_native_rate_at_or_below_30(probe_json):
    plan = plan_ingest(parse_probe(probe_json("walk_portrait_4k"), "w.mp4"))
    assert plan.work_fps == pytest.approx(29.97, abs=0.01)
    assert plan.n_frames == 279


def test_plan_rejects_start_beyond_end(media):
    with pytest.raises(IngestError, match="start"):
        plan_ingest(probe(media["plain"]), start=10.0)


# ---------------------------------------------------------------- decoding


def test_decode_returns_planned_frame_count_and_size(media):
    plan = plan_ingest(probe(media["plain"]), tier="S")
    frames = decode(media["plain"], plan)
    assert frames.dtype == np.uint8
    assert frames.shape == (plan.n_frames, plan.height, plan.width, 3)


def test_decode_autorotates_portrait(media):
    plan = plan_ingest(probe(media["rotated"]), tier="S")
    frames = decode(media["rotated"], plan)
    assert frames.shape[1] > frames.shape[2]  # taller than wide after rotation


def test_decode_tonemaps_hdr_to_8bit(media):
    plan = plan_ingest(probe(media["hdr10"]), tier="S")
    assert plan.tonemap is True
    frames = decode(media["hdr10"], plan)
    assert frames.shape[0] == plan.n_frames
    assert 5 < frames.mean() < 250  # an image, not black or white


def test_decode_vfr_gives_constant_rate_output(media):
    info = probe(media["vfr"])
    plan = plan_ingest(info, tier="S")
    frames = decode(media["vfr"], plan)
    assert frames.shape[0] == plan.n_frames


def test_decode_corrupt_file_does_not_crash_and_reports(media):
    info = probe(media["corrupt"])
    plan = plan_ingest(info, tier="S")
    frames = decode(media["corrupt"], plan)
    assert frames.shape[0] == plan.n_frames  # padded to the plan
    assert plan.notes  # the plan or decode recorded what happened
