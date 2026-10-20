"""Build every real corpus clip (user clips + licensed downloads) through the full pipeline.

    pipeline/.venv/Scripts/python bench/build_corpus.py [--only slug,...]

Writes work/bench/corpus/<slug>.gvol and work/bench/corpus_results.json (quality, category, camera, timings,
plan notes, size). Refuses to start with less than 30 GB free on the output drive.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / "pipeline" / ".venv" / "Scripts" / "python.exe"
OUT = ROOT / "work" / "bench" / "corpus"


def clips() -> list[tuple[str, Path, str]]:
    out = [("user_night_crossing", ROOT / "input" / "Video_Project_8.mp4", "user clip"),
           ("user_walk_portrait_4k", ROOT / "input" / "walk_portrait_4k.mp4", "user clip")]
    for r in json.loads((ROOT / "work" / "corpus_candidates.json").read_text(encoding="utf-8")):
        p = ROOT / r["local"]
        out.append((p.stem.lower()[:40], p, f"{r['license']} - {r['artist']}"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(OUT).free
    if free < 30e9:
        raise SystemExit(f"refusing to build: only {free / 1e9:.1f} GB free on {OUT.anchor}")
    res_path = ROOT / "work" / "bench" / "corpus_results.json"
    results = json.loads(res_path.read_text()) if res_path.exists() else {}
    for slug, src, lic in clips():
        if args.only and slug not in args.only.split(","):
            continue
        if not src.exists():
            results[slug] = {"ok": False, "error": f"missing {src}"}
            continue
        t0 = time.perf_counter()
        proc = subprocess.run([str(PY), "-m", "gargantua", "build", str(src), "-o", str(OUT / f"{slug}.gvol"), "--json-progress"],
                              capture_output=True, text=True, cwd=ROOT)
        lines = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.startswith("{")]
        done = [ln for ln in lines if ln.get("stage") == "done"]
        plan = next((ln for ln in lines if ln.get("stage") == "plan"), {})
        if proc.returncode != 0 or not done:
            err = next((ln.get("message") for ln in lines if ln.get("stage") == "error"), proc.stderr[-400:])
            results[slug] = {"ok": False, "source": str(src), "license": lic, "error": err, "exit": proc.returncode}
        else:
            s = done[-1]["summary"]
            results[slug] = {"ok": True, "source": str(src.relative_to(ROOT)).replace("\\", "/"), "license": lic,
                             "seconds": round(time.perf_counter() - t0, 1), "bytes": done[-1]["bytes"], "plan": plan.get("msg"),
                             "notes": s["plan_notes"], "quality": s["quality"]["grade"], "reasons": s["quality"]["reasons"],
                             "category": s["category"], "camera": s["camera"], "timings_s": s["timings_s"]}
        res_path.write_text(json.dumps(results, indent=1))
        r = results[slug]
        print(f"{slug:42s} {'OK ' if r['ok'] else 'ERR'} {r.get('quality', r.get('error', ''))!s:10.60s} {r.get('category', '')} "
              f"{r.get('camera', '')} {r.get('seconds', '')}s", flush=True)


if __name__ == "__main__":
    main()
