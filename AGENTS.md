# AGENTS.md — using GARGANTUA from an AI agent

GARGANTUA turns a video clip (up to 15 s) into a space-time cube: an (x, y, time) volume rendered in the
browser, and records cinematic camera moves through it as a video. It is classical computer vision plus a
WebGL2 ray-marcher. **It is not a trained model; never describe it as AI-generated footage.**

This file is for coding agents (Claude Code, Codex, Cursor, …) driving the project on a user's behalf.

## Setup (once)

Requirements: Node 22+, Python 3.11 with [uv](https://docs.astral.sh/uv/), `ffmpeg`/`ffprobe` on PATH,
Google Chrome installed (the exporter drives the installed Chrome headlessly; nothing is downloaded).

```bash
npm ci --ignore-scripts
uv sync --project pipeline
npm run build                      # viewer/dist, needed by the exporter
```

## The three commands an agent needs

```bash
# 1. Is the clip suitable? (prints a grade Excellent / OK / Poor with reasons; exit 2 = cannot ingest)
uv run --project pipeline python -m gargantua analyze clip.mp4 --json

# 2. Build the volume (.gvol). Longer clips: pick a window with --start (seconds); default first 15 s.
uv run --project pipeline python -m gargantua build clip.mp4 -o work/volumes/clip.gvol [--start 12.5]

# 3. Record the reel camera sequence to video (deterministic, 60 fps H.264 yuv420p)
node tools/export/export.mjs --vol work/volumes/clip.gvol --preset portrait --duration 30 --clean \
     --out work/export/clip_reel.mp4
```

Export options: `--preset portrait|1080p|4k` (1080x1920, 1920x1080, 3840x2160) or `--size WxH`;
`--duration S` stretches the ~11 s reel choreography to S seconds; `--clean` = the reel look with no
overlays (REEL mode, no worldlines, labels, camera path or cursor) — use it for anything published;
`--audio clip.mp4` muxes the source audio; `--samples N` (default 12) trades speed for smoothness;
`--check-determinism` re-renders one frame and compares hashes.

Interactive viewer: `npm run dev` → http://127.0.0.1:5178, drop a video or `.gvol` on the page.

## Rules for agents

1. **Read the grade before promising a result.** Best: static camera, daylight, scene seen from above
   with a few movers. Hand-held, walking or panning footage smears (grade Poor, and the reasons say why);
   night scenes come out dark; dense crowds look muddy in REEL mode. Tell the user, don't oversell.
2. **Check output by looking at frames**, not only by ffprobe: extract a few frames
   (`ffmpeg -i out.mp4 -vf "select='not(mod(n,150))',tile=6x2" -frames:v 1 sheet.jpg`) and inspect them.
   Container checks passed once on an export that contained no cube at all.
3. **Exit codes are meaningful.** `build`/`analyze` exit 2 with a printed reason when a clip cannot be
   ingested. The exporter exits 2 when the cube does not render (for example a volume too large for the
   GPU); rebuild with a lower `--tier` (S, M) instead of retrying.
4. **Volume size.** Automatic tier choice stays under ~1.1 GB and renders. A forced `--tier L` on a 15 s
   landscape clip (≈1.66 GB) has been observed to upload without error yet not draw.
5. **Disk and time.** A 15 s 1080p volume is ~0.9 GB; a 30 s 1080p export renders in ~15 min on an
   RTX 5070 (4K ≈ 4x longer). Check free space first; volumes and renders go to `work/` (gitignored).
6. **Licenses.** Never commit or publish input footage you do not have rights to. Renders of CC BY /
   CC BY-SA clips must credit the author (and BY-SA renders inherit BY-SA). See `docs/CLIP_LICENSES.md`.
7. **Never install, update or remove GPU drivers** as part of using this project.

## Verifying changes to the code

```bash
uv run --project pipeline pytest            # pipeline (58 tests; real-clip tests skip without input/)
uv run --project pipeline ruff check pipeline/src pipeline/tests bench tools
npm test && npm run typecheck               # viewer logic
node tools/e2e/ui_check.mjs                 # every UI control in headless Chrome (needs a bench volume:
                                            #   uv run --project pipeline python bench/run_bench.py)
```

Measured results, limits and the full method: `README.md`, `docs/BENCH.md`, `PROGRESS.md`.
