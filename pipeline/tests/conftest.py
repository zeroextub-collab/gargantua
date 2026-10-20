from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
P0 = ROOT / "docs" / "evidence" / "p0"
MEDIA = ROOT / "work" / "testmedia"


@pytest.fixture(scope="session")
def probe_json():
    """Real ffprobe output captured in P0 (not hand-written fixtures)."""

    def load(name: str) -> dict:
        return json.loads((P0 / f"{name}.ffprobe.json").read_text())

    return load


def _ff(args: list[str], out: Path) -> Path:
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args, str(out)], check=True)
    return out


@pytest.fixture(scope="session")
def media() -> dict[str, Path]:
    """Small generated clips covering the ingest edge cases (cached under work/testmedia)."""
    src = "testsrc2=size=320x180:rate=30"
    m: dict[str, Path] = {}
    m["plain"] = _ff(["-f", "lavfi", "-i", f"{src}:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264"], MEDIA / "plain.mp4")
    m["long"] = _ff(["-f", "lavfi", "-i", f"{src}:duration=20", "-pix_fmt", "yuv420p", "-c:v", "libx264"], MEDIA / "long_20s.mp4")
    m["fps60"] = _ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264"],
                     MEDIA / "fps60.mp4")
    m["rotated"] = _ff(["-display_rotation", "90", "-i", str(m["plain"]), "-c", "copy"], MEDIA / "rotated90.mp4")
    m["hdr10"] = _ff(["-f", "lavfi", "-i", f"{src}:duration=2", "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
                      "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
                      "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"], MEDIA / "hdr10.mp4")
    m["odd"] = _ff(["-f", "lavfi", "-i", "testsrc2=size=250x190:rate=25:duration=2", "-vf", "setsar=4/3",
                    "-pix_fmt", "yuv444p", "-c:v", "libx264"], MEDIA / "odd_sar.mp4")
    m["vfr"] = _ff(["-f", "lavfi", "-i", f"{src}:duration=3", "-vf", "select='not(eq(mod(n,5),2))'", "-fps_mode", "vfr",
                    "-pix_fmt", "yuv420p", "-c:v", "libx264"], MEDIA / "vfr.mp4")
    m["audio"] = _ff(["-f", "lavfi", "-i", f"{src}:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest"], MEDIA / "with_audio.mp4")
    corrupt = MEDIA / "corrupt.mp4"
    if not corrupt.exists():
        long_bytes = _ff(["-f", "lavfi", "-i", f"{src}:duration=4", "-pix_fmt", "yuv420p", "-c:v", "libx264",
                          "-movflags", "+faststart"], MEDIA / "for_corrupt.mp4").read_bytes()
        b = bytearray(long_bytes)
        # keep the header, overwrite a stretch in the middle of the mdat, truncate the tail
        for i in range(len(b) // 2, len(b) // 2 + 4000):
            b[i] = 0
        corrupt.write_bytes(bytes(b[: int(len(b) * 0.8)]))
    m["corrupt"] = corrupt
    notvideo = MEDIA / "not_a_video.mp4"
    if not notvideo.exists():
        notvideo.write_bytes(b"this is not a video file" * 100)
    m["notvideo"] = notvideo
    return m
