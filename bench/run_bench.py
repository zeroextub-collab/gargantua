"""Gargantua Bench: synthetic clips with known truth -> metrics, plus full-pipeline builds of every clip.

    pipeline/.venv/Scripts/python bench/run_bench.py [--skip-build] [--only name1,name2]

Writes work/bench/synthetic/<scene>.mp4 (+ truth .npz), work/bench/volumes/<scene>.gvol,
work/bench/results.json and docs/BENCH.md (metrics tables; fps/VRAM are merged in by tools/bench/perf.mjs).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from gargantua import synth  # noqa: E402
from gargantua.camera import estimate_motion, transform_error_px  # noqa: E402
from gargantua.evidence import (  # noqa: E402
    bg_hybrid,
    bg_median,
    bg_mode,
    evidence_field,
    flicker_mask,
    flow_magnitude,
    motion_energy,
)
from gargantua.worldlines import match_to_truth, track  # noqa: E402

OUT = ROOT / "work" / "bench"
PY = ROOT / "pipeline" / ".venv" / "Scripts" / "python.exe"
STATIC = {"sparse_blobs", "dense_crowd", "dense_crowd_dark", "flicker_screens", "sparse_overhead", "crowd_grows"}
EXPECTED_CAMERA = {"drift": "drift", "pan": "pan", "parallax": "handheld"}


def encode(frames: np.ndarray, path: Path, fps: float = 30.0) -> None:
    _, h, w, _ = frames.shape
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, input=frames.tobytes(), check=True)


def bg_err(est, truth, sel=None):
    d = np.abs(est.astype(np.float32) - truth.astype(np.float32)).mean(-1)
    return round(float(d[sel].mean() if sel is not None else d.mean()), 3)


def scene_metrics(name: str, frames: np.ndarray, truth: dict) -> dict:
    m: dict = {"scene": name, "frames": int(frames.shape[0]), "size": [int(frames.shape[2]), int(frames.shape[1])]}
    fps = truth["meta"].get("fps", 30.0)
    t0 = time.perf_counter()
    motion = estimate_motion(frames, fps)
    m["camera"] = {"class": motion.cls, "expected": EXPECTED_CAMERA.get(name, "static"), "correct": motion.cls == EXPECTED_CAMERA.get(name, "static")}
    if name in ("drift", "pan"):
        m["camera"]["path_error_px"] = round(transform_error_px(motion.to_ref, truth["cam"], frames.shape[2], frames.shape[1]), 4)
    if name in STATIC:
        b_med = bg_median(frames)
        b_mode, _ = bg_mode(frames)
        b_cap, _ = bg_mode(frames, run_cap=8)
        b_hyb, support, _ = bg_hybrid(frames)
        vis = 1 - truth["masks"].mean(0)
        m["background_mae"] = {"median": bg_err(b_med, truth["background"]), "mode": bg_err(b_mode, truth["background"]),
                               "mode_capped": bg_err(b_cap, truth["background"]), "hybrid": bg_err(b_hyb, truth["background"])}
        buckets = {}
        for lo, hi in ((0.0, 0.1), (0.1, 0.2), (0.2, 0.5), (0.5, 1.01)):
            sel = (vis >= lo) & (vis < hi)
            if sel.sum() > 200:
                buckets[f"{lo:.1f}-{min(hi, 1):.1f}"] = {"pixels": int(sel.sum()), "median": bg_err(b_med, truth["background"], sel),
                                                         "mode": bg_err(b_mode, truth["background"], sel),
                                                         "hybrid": bg_err(b_hyb, truth["background"], sel)}
        m["background_by_visibility"] = buckets
        m["hybrid_vs_median"] = "better" if m["background_mae"]["hybrid"] < m["background_mae"]["median"] - 0.05 else (
            "equal" if abs(m["background_mae"]["hybrid"] - m["background_mae"]["median"]) <= 0.05 else "WORSE")
        flow = flow_magnitude(frames)
        flick = flicker_mask(frames, flow)
        a = evidence_field(frames, b_hyb, support, motion_energy(frames), flow, None) > 127
        if name == "flicker_screens":
            s = truth["screens"]
            fm = flick > 0.5
            m["flicker_iou"] = round(float((fm & s).sum() / max((fm | s).sum(), 1)), 4)
            a &= ~fm[None]  # screens are reported separately; score trails on the rest
            mask = truth["masks"] & ~s[None]
        else:
            mask = truth["masks"]
        tp = float((a & mask).sum())
        m["trails"] = {"recall": round(tp / max(mask.sum(), 1), 4), "precision": round(tp / max(a.sum(), 1), 4)}
        tr = track(frames, max_tracks=1500, exclude_mask=flick if name == "flicker_screens" else None)
        m["worldlines"] = {k: (round(v, 4) if isinstance(v, float) else v)
                           for k, v in match_to_truth(tr, truth["centers"], frames.shape[2], frames.shape[1]).items()}
    m["metrics_s"] = round(time.perf_counter() - t0, 1)
    return m


def build(name: str, mp4: Path) -> dict:
    out = OUT / "volumes" / f"{name}.gvol"
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    res = subprocess.run([str(PY), "-m", "gargantua", "build", str(mp4), "-o", str(out), "--json-progress"],
                         capture_output=True, text=True, cwd=ROOT)
    done = [json.loads(ln) for ln in res.stdout.splitlines() if ln.startswith("{") and '"done"' in ln]
    if res.returncode != 0 or not done:
        return {"ok": False, "error": (res.stdout + res.stderr)[-600:]}
    s = done[-1]["summary"]
    return {"ok": True, "seconds": round(time.perf_counter() - t0, 1), "bytes": done[-1]["bytes"], "quality": s["quality"]["grade"],
            "reasons": s["quality"]["reasons"], "category": s["category"], "camera": s["camera"], "timings_s": s["timings_s"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    names = [n for n in synth.SCENES if not args.only or n in args.only.split(",")]
    (OUT / "synthetic").mkdir(parents=True, exist_ok=True)
    results = {}
    prev = OUT / "results.json"
    if prev.exists():
        results = json.loads(prev.read_text())
    for name in names:
        print(f"[bench] {name}: generating", flush=True)
        frames, truth = synth.SCENES[name]()
        mp4 = OUT / "synthetic" / f"{name}.mp4"
        encode(frames, mp4, truth["meta"].get("fps", 30.0))
        np.savez_compressed(OUT / "synthetic" / f"{name}_truth.npz", **{k: v for k, v in truth.items() if isinstance(v, np.ndarray)})
        print(f"[bench] {name}: metrics", flush=True)
        m = scene_metrics(name, frames, truth)
        if not args.skip_build:
            print(f"[bench] {name}: full pipeline build", flush=True)
            m["build"] = build(name, mp4)
        results[name] = m
        prev.write_text(json.dumps(results, indent=1))
        print(json.dumps({k: m[k] for k in m if k in ("camera", "background_mae", "trails", "worldlines", "flicker_iou", "hybrid_vs_median")}), flush=True)
    print("[bench] done ->", prev)


if __name__ == "__main__":
    main()
