# GARGANTUA — PROGRESS

Read this first every session. A browser-based space-time cube viewer (x, y, t) for clips of up to 15 s.
Not a trained model, and never described as one. Every number below was produced by a command listed here,
in the session that wrote it (last full run: 2026-10-17).

| Phase | Status | Gate evidence |
|---|---|---|
| P0 Environment and inputs | DONE 2026-10-14 | `docs/evidence/p0/`, section P0 below |
| P1 Reel analysis | DONE | `docs/REEL_ANALYSIS.md` (H1-H4 with frame evidence; section 8 tested by rendering) |
| P2 Ingest + clip analyzer | DONE | clip 8 grades **OK**, walk_portrait_4k grades **Poor** with 4 correct reasons |
| P3 Renderer core (REEL) | DONE | `docs/BENCH.md` §3: smallest tier >= 714 fps, largest >= 72 fps moving |
| P4 Gargantua Bench | DONE | 9 synthetic clips with truth, 14 licensed real clips + your 2, Reel Replica Test PASS |
| P5 Evidence field / SEPARATED | DONE | hybrid background no worse than median anywhere, better on the 3 dense scenes |
| P6 Worldlines | DONE | coverage 0.90-1.00 of true movers, velocity error 0.20-0.41 px/frame |
| P7 Camera motion | DONE | path error 0.006 px (drift) / 0.026 px (pan); clip 8 drift stabilised (sharpness x1.91) |
| P8 Look Director | DONE | calibrated to the reel at its own poses: +2% / -2% on both fitted measurements |
| P9 Director + controls | DONE | reel sequence retimed from the reel frames; 72/72 UI checks, 0 console errors |
| P10 Export | DONE | see P10: 1080x1920 and 3840x2160, 60 fps, H.264 yuv420p, audio, deterministic |
| P11 Tests / README / licenses | DONE | 58 pytest + 25 node tests + 72 UI checks pass; README limits; `docs/LICENSES.md` |

Repository: **prepared, not initialised** (the user's decision, 2026-10-17: no git init, no push for now).
`.gitignore` already excludes `input/`, `refs/`, the user's folders, every video file, `work/` and `*.gvol`.
`LICENSE` is MIT.

---

## Commands (Windows 11, Git Bash; Python = `pipeline/.venv/Scripts/python`)

```bash
npm ci --ignore-scripts && (cd pipeline && uv sync)          # install
npm run dev                                                  # viewer + local pipeline server, http://127.0.0.1:5178
pipeline/.venv/Scripts/python -m gargantua build input/Video_Project_8.mp4 -o work/volumes/clip8.gvol
pipeline/.venv/Scripts/python -m gargantua analyze input/walk_portrait_4k.mp4
node tools/export/export.mjs --vol work/volumes/clip8.gvol --preset portrait --fps 60 --samples 12 \
     --audio input/Video_Project_8.mp4 --check-determinism --out work/export/clip8_reel_1080x1920_60fps.mp4
# tests
(cd pipeline && uv run pytest && uv run ruff check src tests ../bench ../tools)
npm test && npm run typecheck && node tools/e2e/ui_check.mjs
# bench (in this order; each step reads the previous one's output)
pipeline/.venv/Scripts/python bench/run_bench.py
pipeline/.venv/Scripts/python bench/build_corpus.py          # refuses to start below 30 GB free on D:
node tools/bench/perf.mjs --out tiers work/volumes/clip8_S.gvol work/volumes/walk4k_S.gvol work/volumes/clip8.gvol work/volumes/walk4k.gvol
node tools/bench/perf.mjs --quick --out corpus work/bench/corpus/*.gvol
node tools/bench/calibrate.mjs                               # look constants (writes docs/evidence/p3/calibration.json)
node tools/bench/replica_render.mjs && pipeline/.venv/Scripts/python tools/bench/replica_score.py
node tools/bench/fit_frame.mjs                               # hero framing vs the reel silhouette
node tools/bench/director_strip.mjs && pipeline/.venv/Scripts/python tools/bench/compose_strip.py 3.4,3.8,4.3,4.8,5.4,5.8
pipeline/.venv/Scripts/python tools/bench/flicker_regions.py work/volumes/clip8.gvol
node tools/bench/contact.mjs && pipeline/.venv/Scripts/python tools/bench/compose_sheet.py work/contact/sheet_user.jpg clip8 walk4k --extra
pipeline/.venv/Scripts/python bench/report.py                # docs/BENCH.md
```

---

## Phase results

### P1 Reel analysis
`docs/REEL_ANALYSIS.md`. H1 (raw colour smoke, no background subtraction) supported; H2 (time-threshold
density) supported and made specific (solid where t >= tau, the cut face shows frame tau); H3 (mirrored from
behind) supported, not corrected; H4: pure black background, ~1 px wireframe, no outer glow measured, the guide
lines are a slice frame on the cut face plus a centre line. Box: front W/H 1.81, depth 1.04 x width, vertical
FOV ~35° (PnP on 3 solid frames).

### P2 Ingest + analyzer
Ingest handles trim (UI dialog in the viewer, `--start` on the CLI), fps resampling to <= 30, VFR, rotation,
odd SAR, HDR (zscale tone map), corrupt frames and missing audio; every case has a generated test clip
(`pipeline/tests/conftest.py`). Your clips (final build):

| clip | volume | camera | grade | reasons |
|---|---|---|---|---|
| Video_Project_8 | 960x540x422 (M) | drift, stabilised | OK | camera drifts slightly (10.6 px max excursion, scale 3.6%, rotation 0.9°) |
| walk_portrait_4k | 720x1280x279 (L) | hand-held | **Poor** | large camera motion (2.2% of the diagonal per second); forward/zoom motion (scale 49%); strong parallax (1.07 per mille residual); raw frames shown unaligned |

### P3 Renderer (1920x1080, RTX 5070, headless Chrome 155)
`docs/BENCH.md` §3, `docs/evidence/p3/perf_*.json`. Worst-case all-smoke state:

| volume | tier | moving fps | idle refinement fps | VRAM in use |
|---|---|---|---|---|
| clip8_S | 640x360x422 | 714 | 455 | 601 MB |
| walk4k_S | 360x640x279 | 1000 | 556 | 439 MB |
| clip8 | 960x540x422 | 72 | 46 | 1213 MB |
| walk4k | 720x1280x279 | 90 | 52 | 1187 MB |

Every animated view (orbit, fly, director playback, reveal playback) renders at the moving quality. All 16
real clips: moving >= 56 fps. One corpus volume (wp25, 836x720x450, 1.08 GB) refines at 26 fps when idle;
`--tier M` gives it 70 fps. Idle figures vary ~±25% with how the orbit is sampled (the quick corpus pass reads
the night clip at 35 fps idle, the full pass at 46).

### P4 Bench
9 synthetic clips (`pipeline/src/gargantua/synth.py`) and 16 real clips (14 Wikimedia Commons clips with
licenses read and recorded in `docs/CLIP_LICENSES.md`, plus your 2). Contact sheets at the reel's own
timestamps next to the reel: `work/contact/sheet_{user,synthetic,corpus_1,corpus_2}.jpg` (not committed:
they contain reel frames). Reel Replica Test (`docs/evidence/p4/replica.json`): **PASS** — static sharpness
smoke/solid 0.551 head-on vs 0.021 oblique; movers ghost (ratio 0.581 < 0.75); stripe energy 0.103 REEL vs
0.0073 SEPARATED; haze hue 91.6° vs pavement 84.6°.

### P5 Evidence field
Background MAE (0-255), median → hybrid: dense_crowd 4.64 → 1.03, dense_crowd_dark 25.93 → 22.24,
crowd_grows 3.30 → 1.02, equal on the sparse scenes. Mode works down to ~20% background visibility; every
estimator fails below ~10%. Trails recall/precision: sparse 0.98/0.97, dense 0.81/0.80, dark crowd 0.41/0.65.
Animated screens: synthetic IoU 0.84 (bench) / 0.92 (test clip); on your night clip 4 hand-labelled screens
are 85-94% covered, the crowd and a lit facade 0% (`docs/evidence/p5/flicker_regions_clip8.json`).

### P6 Worldlines
Coverage 0.90-1.00 of true movers, velocity error 0.20-0.41 px/frame, unmatched 0.00-0.12. On clip 8, 0% of
worldline points fall on detected screens. Lines inside the solid part of the cube are hidden (exact
transmittance per vertex); in smoke they show.

### P7 Camera motion
Synthetic path error 0.006 px (drift) and 0.026 px (pan); parallax classified hand-held. Clip 8: drift,
stabilisation kept because it is measurably sharper (Laplacian variance 38.5 → 112.1, temporal std 22.8 →
16.4). Walk: raw frames, camera path drawn as a worldline (scaled into the box when the pan is wider than the
frame), warning in the UI.

### P8 Look Director
`docs/evidence/p3/calibration.json`: exposure 0.7565 (solid face 148.44 = source 148.44); optical depth
0.2791 linear light; top-down haze 0.378 vs reel 0.371, 1.7 s band 0.247 vs reel 0.253, inside view 0.72 vs
0.56 (unfitted diagnostic). Night rule: emissive boost and bloom only when luma p50 < 70, scaled down when
bright pixels cover more than 3.5% of the frame. Presets per category, saved/loaded as JSON.

### P9 Director + controls
Hero framing fitted to the reel's t = 0 silhouette (0.910 x 0.609 of the frame vs the reel's 0.903 x 0.610);
the 3.6-5.8 s camera (rise to top-down, spin over the top, swing, head-on hold, jump-cut inside) retimed from
the reel frames. `node tools/e2e/ui_check.mjs`: 72/72 checks, 0 console errors (every toggle, segment, slider,
preset, director, fly mode, trim dialog, quick ingest, touch orbit/pinch, progress bar, mobile layout,
compositing regression).

### P10 Export
Command: see "Commands" above (`--preset portrait` / `--preset 4k`, `--samples 12`, `--audio`, `--check-determinism`).
Logs: `work/export/portrait.log`, `work/export/4k.log`; frames checked by eye at the reel's beat times
(`work/export/portrait_sheet.jpg`, `work/export/4k_sheet.jpg`).

| file | size | video | audio | determinism | decode | render time |
|---|---|---|---|---|---|---|
| `work/export/clip8_reel_1080x1920_60fps.mp4` | 28.8 MB | H.264 High, yuv420p, 1080x1920, 60/1, 673 frames, 11.217 s | AAC LC, mean -20.6 dB (source -21 dB) | frame 316 re-rendered: SHA-1 identical | 0 errors | 325 s |
| `work/export/clip8_reel_3840x2160_60fps.mp4` | 98.2 MB | H.264 High, yuv420p, 3840x2160, 60/1, 673 frames, 11.217 s | AAC LC, mean -20.6 dB | frame 316 re-rendered: SHA-1 identical | 0 errors | 1119 s |

An earlier export of the same sequence showed no cube at all (only worldlines and the wireframe) even though
ffprobe, the decode check and the hash all passed; only looking at the frames found it (final-pass table).

### P11
58 pytest, 25 node tests, 72 UI checks, ruff clean, typecheck clean. README "Honest limits" lists the weak
clip types. `docs/LICENSES.md` audited (OpenCV 4.14 wheel: Apache-2.0; it also bundles an FFmpeg DLL under
LGPL-2.1 that GARGANTUA never calls, since decoding goes through the ffmpeg CLI). Supply chain (`docs/evidence/supply-chain/`): no known advisory on any
direct or locked transitive dependency.

---

## Final pass (2026-10-17): defects found and fixed

| defect | how it was found | fix | guard |
|---|---|---|---|
| Worldlines wiped the cube in every view and in exports | export frames showed only lines + wireframe | `autoClear` off while drawing on top of the copied volume | UI check: cube share unchanged with worldlines |
| Worldlines showed through the solid box | export frames at t = 0 | exact two-slab transmittance per vertex in the line shader | UI check: solid frame identical on/off, smoke frame brighter |
| Screen detector found 0% on the night clip (tuned on synthetic) | `flicker_frac` 0.0 in the rebuilt header | new cues: region-brightness change not explained by steady motion, relative brightness, hysteresis | pytest on the real clip (4 screens > 50%, crowd/facade < 5%) |
| No trim UI for clips over 15 s | spec re-read line by line | trim dialog with preview and 15 s window | unit test + UI check (Cancel / Build 3.5-18.5 s) |
| Hero framing 0.67x the reel's size; top-down spin missing; inside started late | contact sheet next to the reel | framing measured on the reel's own aspect; keys retimed from reel frames | projection property test |
| Calibration fitted against mismatched poses (-17% / +23%) | re-check after the director fix | re-fitted: +2% / -2% | `calibration.json`, `blend_test/` |
| `perf.mjs --quick` crashed; VRAM deltas read negative | running it | frame counts passed into the page; fresh browser per volume | — |
| Camera path drew across the whole screen for big pans | corpus contact sheet | scaled into the box when it overflows | — |
| Night clips with clipped sky bloomed out | corpus contact sheet | emissive boost and bloom scale with the bright-area share | unit test |

## Open problems / honest limits
See README "Honest limits". In short: the reel look needs a static scene with sparse movers; moving cameras
smear (parallax cannot be corrected); background estimation fails below ~10% visibility; dark uniform crowds
defeat the mode; old film with gate weave reads as hand-held; night scenes give dark smoke; inside-the-box
shots use one 35° lens while the reel's look wider; calibration is fitted on synthetic content; untested on
other GPUs and browsers.

## Environment gotchas (do not re-hit)
1. `python` on PATH is the hermes-agent venv; the project venv is `pipeline/.venv` (uv, Python 3.11.9).
2. C: is nearly full; caches live on D:. Playwright drives the installed Chrome (`channel: 'chrome'`).
3. ffmpeg `drawtext` segfaults without `fontfile='C\:/Windows/Fonts/consola.ttf'`.
4. Headless Chrome with a relative `--user-data-dir` exits 21 silently.
5. Chrome's `gl.finish()` does not block: time frames with a 1-pixel `readPixels`.
6. The desktop app's browser pane runs no animation frames and refuses pointer lock: verify in headless Chrome.
7. Python 3.11: no nested same-quote f-strings (3.12 only).
8. `page.evaluate` bodies cannot see node variables; pass them as arguments.
9. nvidia-smi VRAM is global and Chrome pools freed memory: measure per volume in a fresh browser.

---

## P0 — Environment and inputs (2026-10-14)

Evidence: `docs/evidence/p0/` (regenerate: `bash tools/p0/env_report.sh`).

The user's files live in `refernce video and image/` and `testing clip/`; the spec paths (`refs/reel.mp4`,
`refs/still_*.png`, `input/Video_Project_8.mp4`, `input/walk_portrait_4k.mp4`) are NTFS hardlinks to them.

| | reel.mp4 | Video_Project_8.mp4 | walk_portrait_4k.mp4 |
|---|---|---|---|
| Resolution | 874x880 | 1920x1080 | 2160x3840 (portrait, no rotation tag) |
| FPS | 30/1 CFR | 30/1 CFR | 30000/1001 CFR |
| Duration / frames | 12.933 s / 388 | 14.067 s / 422 | 9.309 s / 279 |
| Codec | H.264 Main yuv420p | H.264 Main yuv420p | H.264 High yuv420p, BT.709 tv |
| Audio | AAC, digital silence | AAC stereo 48 kHz | none |

Environment: Windows 11 Pro 26200, Ryzen 7 9800X3D, 31 GB RAM, RTX 5070 12 GB (driver 610.62, untouched),
Node 22.22.3, Python 3.11.9 + uv 0.11.20, ffmpeg 8.1.2, Chrome 155.0.8059.79. WebGL2 via ANGLE D3D11 on the
RTX 5070, `MAX_3D_TEXTURE_SIZE` 2048. Disk at P0: C: 25 GB free, D: 208 GB free.
