"""GARGANTUA command line.

    gargantua build INPUT -o OUT.gvol [--start S] [--max-duration 15] [--tier auto|S|M|L]
                    [--budget-mb 1100] [--stabilize auto|on|off] [--no-worldlines] [--json-progress]
    gargantua analyze INPUT [--json]

Exit codes: 0 ok, 2 the clip cannot be ingested (a clear message is printed), 1 unexpected error.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from . import __version__
from .analyze import analyze_frames
from .camera import estimate_motion, sharpness_gain, stabilize
from .evidence import (
    HYBRID_CANDIDATES,
    bg_hybrid,
    bg_sliding,
    evidence_field,
    flicker_mask,
    flow_magnitude,
    motion_energy,
)
from .ingest import IngestError, decode, plan_ingest
from .look import bricks, look_params
from .pack import write_gvol
from .probe import probe
from .worldlines import pack_tracks, track


class Reporter:
    def __init__(self, json_mode: bool):
        self.json = json_mode
        self.t0 = time.perf_counter()
        self.timings: dict[str, float] = {}
        self._stage = None
        self._ts = self.t0

    def stage(self, name: str, msg: str = ""):
        now = time.perf_counter()
        if self._stage:
            self.timings[self._stage] = round(now - self._ts, 2)
        self._stage, self._ts = name, now
        self.emit({"stage": name, "progress": 0.0, "msg": msg})

    def progress(self, p: float):
        if self.json:
            self.emit({"stage": self._stage, "progress": round(p, 3)})

    def emit(self, obj: dict):
        if self.json:
            print(json.dumps(obj), flush=True)
        elif obj.get("msg") or obj.get("stage") in ("done", "error", "warning"):
            print(f"[{obj.get('stage')}] {obj.get('msg', '')}", flush=True)

    def finish(self):
        if self._stage:
            self.timings[self._stage] = round(time.perf_counter() - self._ts, 2)
        self.timings["total"] = round(time.perf_counter() - self.t0, 2)


def worldline_camera(motion, stabilized: bool):
    """Camera model for judging track motion: none for static cameras, and none when the frames were already
    stabilised (compensating twice turns static scenery into apparent movers)."""
    return None if stabilized or motion.cls == "static" else motion


def build(args: argparse.Namespace) -> int:
    rep = Reporter(args.json_progress)
    rep.stage("probe", f"reading {args.input}")
    info = probe(args.input)
    plan = plan_ingest(info, start=args.start, max_duration=args.max_duration, tier=args.tier,
                       budget_bytes=args.budget_mb * 1e6)
    rep.emit({"stage": "plan", "msg": f"{plan.width}x{plan.height}x{plan.n_frames} @ {plan.work_fps:.4g} fps (tier {plan.tier}, "
              f"{plan.voxel_bytes / 1e6:.0f} MB)", "notes": plan.notes})

    rep.stage("decode", "decoding frames")
    frames = decode(args.input, plan, rep.progress)

    rep.stage("camera", "estimating camera motion")
    motion = estimate_motion(frames, plan.work_fps)
    stab = {"applied": False, "class": motion.cls}
    if args.stabilize != "off" and (motion.cls in ("static", "drift") or args.stabilize == "on"):
        if motion.cls == "static" and args.stabilize == "auto":
            stab["reason"] = "camera is static; nothing to stabilise"
        else:
            stable = stabilize(frames, motion)
            gain = sharpness_gain(frames, stable)
            stab.update({k: round(v, 4) for k, v in gain.items()})
            keep = args.stabilize == "on" or gain["sharpness_gain"] > 0.05 or gain["temporal_std_after"] < 0.9 * gain["temporal_std_before"]
            stab["applied"] = bool(keep)
            stab["reason"] = ("kept: measurably sharper/steadier" if keep else "discarded: no measurable gain")
            if keep:
                frames = stable
            del stable
    elif motion.cls in ("pan", "handheld"):
        stab["reason"] = "large camera motion: raw frames rendered, camera path drawn as a worldline"
        rep.emit({"stage": "warning", "msg": "; ".join(motion.reasons) or "large camera motion"})

    rep.stage("analyze", "clip statistics and quality score")
    analysis = analyze_frames(frames, plan.work_fps, motion, duration=plan.duration,
                              source_short_side=min(info.display_width, info.display_height))

    rep.stage("background", "background: median, mode, run-capped mode -> hybrid")
    bg, support, choice = bg_hybrid(frames)
    rep.progress(0.7)
    half = frames[:, ::2, ::2]
    sliding = bg_sliding(half, plan.work_fps, window_s=3.0, hop_s=1.0)

    rep.stage("motion", "motion energy + optical flow")
    energy = motion_energy(frames)
    rep.progress(0.4)
    flow = flow_magnitude(frames)
    # a fixed per-pixel screen mask only means something while the image holds still (screens slide across
    # the frame under a pan or a walk); the analyzer skips the same case
    still = motion.cls in ("static", "drift")
    flick = flicker_mask(frames, flow) if still else np.zeros(frames.shape[1:3], np.float32)

    rep.stage("evidence", "fusing the evidence field")
    a = evidence_field(frames, bg, support, energy, flow, flick, sliding)
    del energy, sliding

    tracks = []
    if not args.no_worldlines:
        rep.stage("worldlines", "KLT worldlines")
        tracks = track(frames, max_tracks=args.max_tracks, camera=worldline_camera(motion, stab["applied"]),
                       exclude_mask=flick if motion.cls in ("static", "drift") else None)

    rep.stage("pack", f"writing {args.output}")
    t, h, w, _ = frames.shape
    vol = np.empty((t, h, w, 4), np.uint8)
    vol[..., :3] = frames
    vol[..., 3] = a
    look = look_params(frames, a, analysis["category"])
    sections = {
        "volume": vol,
        "background": np.dstack([bg, (np.clip(support, 0, 1) * 255).astype(np.uint8)]),
        "flicker": (np.clip(flick, 0, 1) * 255).astype(np.uint8),
        "bricks": bricks(a),
        "camera_path": (motion.path / np.array([w, h], np.float32)).astype(np.float32),
        **pack_tracks(tracks),
    }
    choice_counts = np.bincount(choice.ravel(), minlength=len(HYBRID_CANDIDATES))
    rep.finish()
    header = {
        "generator": f"gargantua {__version__}",
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "source": {k: getattr(info, k) for k in ("path", "codec", "width", "height", "display_width", "display_height",
                                                 "rotation", "fps", "vfr", "duration", "has_audio", "pix_fmt", "bit_depth", "hdr")},
        "plan": {"start": plan.start, "duration": plan.duration, "fps": plan.work_fps, "frames": plan.n_frames,
                 "width": plan.width, "height": plan.height, "tier": plan.tier, "tonemap": plan.tonemap, "notes": plan.notes},
        "analysis": analysis,
        "camera": {"class": motion.cls, "reasons": motion.reasons, "stabilization": stab, "ref": motion.ref},
        "evidence": {"mean": round(float(a[::4, ::4, ::4].mean() / 255), 5),
                     "bg_choice": {n: int(c) for n, c in zip(HYBRID_CANDIDATES, choice_counts, strict=True)},
                     "bg_support_median": round(float(np.median(support)), 4),
                     "flicker_frac": round(float((flick > 0.5).mean()), 4),
                     "flicker_skipped": None if still else f"{motion.cls} camera: screens move across the frame"},
        "worldlines": {"count": len(tracks), "points": int(sum(len(tr.points) for tr in tracks))},
        "look": look,
        "timings_s": rep.timings,
    }
    size = write_gvol(args.output, header, sections)
    rep.emit({"stage": "done", "progress": 1.0, "out": str(args.output), "bytes": size,
              "msg": f"{args.output} ({size / 1e6:.0f} MB) in {rep.timings['total']:.1f}s - quality {analysis['quality']['grade']}",
              "summary": {"quality": analysis["quality"], "category": analysis["category"], "camera": motion.cls,
                          "timings_s": rep.timings, "plan_notes": plan.notes}})
    return 0


def analyze_cmd(args: argparse.Namespace) -> int:
    info = probe(args.input)
    plan = plan_ingest(info, tier="S")
    frames = decode(args.input, plan)
    motion = estimate_motion(frames, plan.work_fps)
    a = analyze_frames(frames, plan.work_fps, motion, duration=plan.duration,
                       source_short_side=min(info.display_width, info.display_height))
    out = {"input": str(args.input), "plan_notes": plan.notes, **a}
    if args.json:
        print(json.dumps(out, indent=1))
    else:
        q = a["quality"]
        print(f"{Path(args.input).name}: {q['grade']}  (category {a['category']}, camera {a['camera']['class']})")
        for r in q["reasons"]:
            print(f"  - {r}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gargantua", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="video -> .gvol")
    b.add_argument("input", type=Path)
    b.add_argument("-o", "--output", type=Path, required=True)
    b.add_argument("--start", type=float, default=0.0)
    b.add_argument("--max-duration", type=float, default=15.0)
    b.add_argument("--tier", default="auto", choices=["auto", "S", "M", "L"])
    b.add_argument("--budget-mb", type=float, default=1100.0)
    b.add_argument("--stabilize", default="auto", choices=["auto", "on", "off"])
    b.add_argument("--no-worldlines", action="store_true")
    b.add_argument("--max-tracks", type=int, default=1500)
    b.add_argument("--json-progress", action="store_true")
    a = sub.add_parser("analyze", help="quality score + category only")
    a.add_argument("input", type=Path)
    a.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    json_mode = getattr(args, "json_progress", False)
    try:
        return build(args) if args.cmd == "build" else analyze_cmd(args)
    except IngestError as e:
        if json_mode:
            print(json.dumps({"stage": "error", "message": str(e)}), flush=True)
        else:
            print(f"error: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # never a bare traceback for the UI: report, then exit 1
        msg = f"unexpected error: {type(e).__name__}: {e}"
        if json_mode:
            print(json.dumps({"stage": "error", "message": msg, "trace": traceback.format_exc()[-2000:]}), flush=True)
        else:
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
