"""Universal ingest: trim, resample, autorotate, tone-map, scale to a volume tier, decode to RGB frames."""

from __future__ import annotations

import math
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .probe import ClipInfo, IngestError

__all__ = ["IngestError", "IngestPlan", "choose_tier", "decode", "plan_ingest"]

MAX_TEXTURE_AXIS = 2048  # WebGL2 MAX_3D_TEXTURE_SIZE measured in P0 (Chrome 155 / ANGLE D3D11)
TIERS = {"S": 360, "M": 540, "L": 720}  # short-side pixels
DEFAULT_BUDGET = 1.1e9  # bytes of RGBA8 voxels; P3 measured fps decides the final default
MAX_FPS = 30.0
MAX_DURATION = 15.0


@dataclass
class IngestPlan:
    start: float
    duration: float
    work_fps: float
    n_frames: int
    width: int
    height: int
    tier: str
    tonemap: bool
    notes: list[str] = field(default_factory=list)

    @property
    def voxel_bytes(self) -> int:
        return self.width * self.height * self.n_frames * 4


def _round4(x: float) -> int:
    return max(4, int(round(x / 4.0)) * 4)


def _tier_size(dw: int, dh: int, short: int) -> tuple[int, int]:
    aspect = dw / dh
    if aspect >= 1:
        h, w = short, short * aspect
    else:
        w, h = short, short / aspect
    # cap at the texture limit and never upscale beyond the source
    scale = min(1.0, MAX_TEXTURE_AXIS / max(w, h), max(dw, dh) / max(w, h))
    return _round4(w * scale), _round4(h * scale)


def choose_tier(dw: int, dh: int, n_frames: int, budget_bytes: float = DEFAULT_BUDGET, tier: str = "auto") -> tuple[int, int, str]:
    if tier != "auto":
        if tier not in TIERS:
            raise IngestError(f"unknown tier {tier!r}; use auto, S, M or L")
        w, h = _tier_size(dw, dh, TIERS[tier])
        return w, h, tier
    chosen = None
    for name in ("S", "M", "L"):
        w, h = _tier_size(dw, dh, TIERS[name])
        if chosen is None or w * h * n_frames * 4 <= budget_bytes:
            chosen = (w, h, name)
    assert chosen is not None
    return chosen


def plan_ingest(
    info: ClipInfo,
    start: float = 0.0,
    max_duration: float = MAX_DURATION,
    tier: str = "auto",
    budget_bytes: float = DEFAULT_BUDGET,
    max_fps: float = MAX_FPS,
) -> IngestPlan:
    notes: list[str] = []
    if start < 0 or start >= info.duration - 1e-3:
        raise IngestError(f"start {start:.2f}s is outside the clip (duration {info.duration:.2f}s)")
    avail = info.duration - start
    duration = min(max_duration, avail)
    if avail > max_duration + 1e-3:
        notes.append(f"clip is {info.duration:.2f}s; trimmed to {start:.2f}-{start + duration:.2f}s (max {max_duration:.0f}s)")
    src_fps = info.fps
    if src_fps > max_fps + 0.5:
        step = math.ceil(src_fps / max_fps - 1e-6)
        work_fps = src_fps / step
        notes.append(f"source {src_fps:.3g} fps resampled to {work_fps:.4g} fps working rate")
    else:
        work_fps = src_fps
    if info.vfr:
        notes.append(f"variable frame rate (avg {info.fps:.3g}, base {info.fps_r:.3g}); resampled to constant {work_fps:.4g} fps")
    n_frames = max(1, int(math.floor(duration * work_fps + 1e-6)))
    w, h, name = choose_tier(info.display_width, info.display_height, n_frames, budget_bytes, tier)
    if info.rotation:
        notes.append(f"rotation metadata {info.rotation} deg applied (autorotate)")
    if info.hdr:
        notes.append(f"HDR ({info.color_transfer}, {info.bit_depth}-bit) tone-mapped to SDR BT.709")
    elif info.bit_depth > 8:
        notes.append(f"{info.bit_depth}-bit source reduced to 8-bit")
    if max(info.display_width, info.display_height) > 2 * max(w, h):
        notes.append(f"downscaled {info.display_width}x{info.display_height} to {w}x{h} (tier {name})")
    if not info.has_audio:
        notes.append("no audio track (export will be silent)")
    return IngestPlan(start, duration, work_fps, n_frames, w, h, name, info.hdr, notes)


def _filter_chain(plan: IngestPlan) -> str:
    chain = []
    if plan.tonemap:
        chain += [
            "zscale=t=linear:npl=100",
            "format=gbrpf32le",
            "zscale=p=bt709",
            "tonemap=tonemap=hable:desat=0",
            "zscale=t=bt709:m=bt709:r=tv",
            "format=yuv420p",
        ]
    chain += [f"fps={plan.work_fps:.6f}", f"scale={plan.width}:{plan.height}:flags=area", "setsar=1", "format=rgb24"]
    return ",".join(chain)


def build_ffmpeg_cmd(path: str | Path, plan: IngestPlan) -> list[str]:
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-err_detect", "ignore_err", "-fflags", "+discardcorrupt+genpts"]
    if plan.start > 0:
        cmd += ["-ss", f"{plan.start:.3f}"]
    cmd += ["-i", str(path), "-t", f"{plan.duration:.3f}", "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", _filter_chain(plan), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    return cmd


def decode(path: str | Path, plan: IngestPlan, progress: Callable[[float], None] | None = None) -> np.ndarray:
    """Decode the planned window to (T, H, W, 3) uint8 RGB. Never returns fewer frames than planned:
    a short or damaged stream is padded with its last good frame and the plan's notes say so."""
    frame_bytes = plan.width * plan.height * 3
    out = np.empty((plan.n_frames, plan.height, plan.width, 3), np.uint8)
    proc = subprocess.Popen(build_ffmpeg_cmd(path, plan), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    n = 0
    try:
        while n < plan.n_frames:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            out[n] = np.frombuffer(buf, np.uint8).reshape(plan.height, plan.width, 3)
            n += 1
            if progress and (n % 8 == 0 or n == plan.n_frames):
                progress(n / plan.n_frames)
    finally:
        proc.stdout.close()
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        proc.kill() if proc.poll() is None else None
        proc.wait()
    err_lines = [ln for ln in stderr.splitlines() if ln.strip()]
    if n == 0:
        tail = err_lines[-1] if err_lines else "no frames produced"
        raise IngestError(f"{Path(path).name}: could not decode any frames ({tail})")
    if err_lines:
        plan.notes.append(f"decoder reported {len(err_lines)} error line(s), e.g. '{err_lines[0][:120]}'")
    if n < plan.n_frames:
        plan.notes.append(f"stream ended after {n} of {plan.n_frames} frames; padded with the last good frame")
        out[n:] = out[n - 1]
    return out
