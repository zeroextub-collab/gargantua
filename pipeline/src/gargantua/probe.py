"""ffprobe wrapper: turns a media file into the facts the ingest planner needs."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


class IngestError(RuntimeError):
    """A clear, user-facing reason why a clip cannot be ingested."""


HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}


@dataclass(frozen=True)
class ClipInfo:
    path: str
    codec: str
    width: int  # coded
    height: int
    display_width: int  # after rotation and sample aspect ratio
    display_height: int
    rotation: int  # 0, 90, 180, 270
    sar: float
    fps: float  # average frame rate
    fps_r: float  # container "real" base rate
    vfr: bool
    duration: float
    nb_frames: int | None
    has_audio: bool
    pix_fmt: str
    bit_depth: int
    color_transfer: str | None
    color_primaries: str | None
    hdr: bool


def _rate(s: str | None) -> float:
    if not s or s in ("0/0", "N/A"):
        return 0.0
    try:
        return float(Fraction(s.replace(":", "/")))
    except (ValueError, ZeroDivisionError):
        return 0.0


def _bit_depth(stream: dict) -> int:
    raw = stream.get("bits_per_raw_sample")
    if isinstance(raw, str) and raw.isdigit():
        return int(raw)
    pix = stream.get("pix_fmt", "")
    for d in (16, 14, 12, 10, 9):
        if f"p{d}" in pix or pix.endswith(f"{d}le") or pix.endswith(f"{d}be"):
            return d
    return 8


def _rotation(stream: dict) -> int:
    rot = 0.0
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = float(sd["rotation"])
    tags = stream.get("tags", {}) or {}
    if not rot and "rotate" in tags:
        rot = float(tags["rotate"])
    return int(round(rot / 90.0)) * 90 % 360


def parse_probe(j: dict, path: str | Path) -> ClipInfo:
    streams = j.get("streams", [])
    video = [s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic", 0) == 0]
    if not video:
        raise IngestError(f"{Path(path).name}: no video stream found")
    v = video[0]
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    if w <= 0 or h <= 0:
        raise IngestError(f"{Path(path).name}: video stream has no valid size")
    sar = _rate(v.get("sample_aspect_ratio")) or 1.0
    rot = _rotation(v)
    dw, dh = round(w * sar), h
    if rot in (90, 270):
        dw, dh = dh, dw
    fps_avg, fps_r = _rate(v.get("avg_frame_rate")), _rate(v.get("r_frame_rate"))
    fps = fps_avg or fps_r
    if fps <= 0:
        raise IngestError(f"{Path(path).name}: could not determine a frame rate")
    fmt = j.get("format", {})
    duration = float(v.get("duration") or fmt.get("duration") or 0.0)
    if duration <= 0:
        raise IngestError(f"{Path(path).name}: could not determine the duration")
    nb = v.get("nb_frames")
    transfer = v.get("color_transfer")
    depth = _bit_depth(v)
    return ClipInfo(
        path=str(path),
        codec=v.get("codec_name", "?"),
        width=w,
        height=h,
        display_width=int(dw),
        display_height=int(dh),
        rotation=rot,
        sar=sar,
        fps=fps,
        fps_r=fps_r or fps,
        vfr=bool(fps_r and fps_avg and abs(fps_r - fps_avg) / fps_r > 0.01),
        duration=duration,
        nb_frames=int(nb) if isinstance(nb, str) and nb.isdigit() else None,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        pix_fmt=v.get("pix_fmt", "?"),
        bit_depth=depth,
        color_transfer=transfer,
        color_primaries=v.get("color_primaries"),
        hdr=transfer in HDR_TRANSFERS,
    )


def probe(path: str | Path) -> ClipInfo:
    path = Path(path)
    if not path.exists():
        raise IngestError(f"{path}: file not found")
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except FileNotFoundError as e:
        raise IngestError("ffprobe is not installed or not on PATH") from e
    if res.returncode != 0 or not res.stdout.strip():
        msg = (res.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
        raise IngestError(f"{path.name}: could not read the file as video ({msg[0]})")
    return parse_probe(json.loads(res.stdout), path)
