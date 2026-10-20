from __future__ import annotations

import numpy as np
import pytest

from gargantua.pack import GvolError, read_gvol, write_gvol


def test_roundtrip_preserves_header_and_sections(tmp_path):
    vol = np.random.default_rng(0).integers(0, 255, (5, 6, 7, 4), dtype=np.uint8)
    pts = np.arange(12, dtype=np.float32).reshape(6, 2)
    out = tmp_path / "x.gvol"
    write_gvol(out, {"clip": {"name": "x"}, "fps": 30.0}, {"volume": vol, "track_points": pts})
    header, sections = read_gvol(out)
    assert header["clip"]["name"] == "x"
    assert header["fps"] == 30.0
    np.testing.assert_array_equal(sections["volume"], vol)
    np.testing.assert_array_equal(sections["track_points"], pts)


def test_sections_are_16_byte_aligned(tmp_path):
    out = tmp_path / "a.gvol"
    write_gvol(out, {"note": "odd" * 7}, {"a": np.zeros(3, np.uint8), "b": np.ones(5, np.float32)})
    header, _ = read_gvol(out)
    for s in header["sections"].values():
        assert s["offset"] % 16 == 0


def test_rejects_wrong_magic(tmp_path):
    bad = tmp_path / "bad.gvol"
    bad.write_bytes(b"NOPE" + b"\0" * 64)
    with pytest.raises(GvolError, match="magic"):
        read_gvol(bad)
