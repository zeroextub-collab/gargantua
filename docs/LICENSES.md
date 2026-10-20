# Licenses

GARGANTUA itself is MIT licensed (`LICENSE`). This file lists every third-party component, how it is used,
and what it bundles. Checked 2026-10-14/17 from the installed packages (`package-lock.json`, the venv's
`*.dist-info`, and the OpenCV / numpy wheels' bundled license files). Nothing below is vendored into the
repository; all of it is installed by `npm ci` / `uv sync`.

## Shipped in the built viewer (`viewer/dist`)

| Component | Version | License | Notes |
|---|---|---|---|
| three.js (incl. `examples/jsm` OrbitControls, UnrealBloomPass, FullScreenQuad; fly mode uses its own controller) | 0.186.1 | MIT | bundled into the viewer JS |
| IBM Plex Mono (@fontsource/ibm-plex-mono) | 5.3.0 | OFL-1.1 | font files bundled as assets |
| Instrument Serif (@fontsource/instrument-serif) | 5.3.0 | OFL-1.1 | font files bundled as assets |

Everything else in the viewer (ray-marcher, blue-noise generator, line renderer, director, UI) is original code.

## Development / build tools (npm, not shipped)

| Package | Version | License |
|---|---|---|
| @types/node | 22.20.4 | MIT |
| @types/three | 0.186.0 | MIT |
| playwright-core | 1.63.0 | Apache-2.0 |
| typescript | 7.0.2 | Apache-2.0 |
| vite | 8.3.1 | MIT |

Transitive npm packages (66): MIT x30, Apache-2.0 x22, MPL-2.0 x12, ISC x1, BSD-3-Clause x1.
The 12 MPL-2.0 packages are `lightningcss` and its per-platform binaries (Vite's CSS minifier, a build-time
tool; MPL-2.0 is file-level copyleft and applies only to modifications of those files, which this project
does not make or distribute). `fsevents` (macOS-only, has an install script) is never installed on Windows.
All npm installs use `--ignore-scripts`; the supply-chain audit is in `docs/evidence/supply-chain/`.

## Python pipeline (`pipeline/`, uv venv)

| Package | Version | License |
|---|---|---|
| colorama | 0.4.6 | BSD License |
| iniconfig | 2.3.1 | MIT |
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| opencv-python-headless | 4.14.0.94 | Apache 2.0 |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| pluggy | 1.6.0 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |
| pytest | 9.1.1 | MIT |
| ruff | 0.16.9 | MIT |

### What the binary wheels bundle

- **opencv-python-headless 4.14.0.94 (Windows, abi3)**: `cv2.pyd` = OpenCV (Apache-2.0 since 4.5.0) with statically linked
  permissive libraries (libjpeg-turbo, libpng, zlib, libwebp, OpenJPEG, ...; their notices are in the wheel's
  `LICENSE-3RD-PARTY.txt`), plus `opencv_videoio_ffmpeg4140_64.dll` = FFmpeg under **LGPL-2.1**. GARGANTUA never
  calls OpenCV's video I/O (decoding goes through the ffmpeg CLI), so that DLL is present but unused. The
  headless wheel contains **no Qt** (Qt is only in non-headless Linux/macOS wheels) and **nothing GPL**.
- **numpy 2.4.6 (Windows)**: bundles OpenBLAS + LAPACK (BSD-3-Clause / BSD-3-Clause-Open-MPI) and the GCC runtime
  (GPL-3.0-or-later **with the GCC Runtime Library Exception 3.1**, which permits use from non-GPL code), plus the
  Microsoft C++ runtime (`msvcp140`), redistributable.

## External programs (invoked, not bundled)

| Program | Version used | License | Use |
|---|---|---|---|
| ffmpeg / ffprobe (gyan.dev full build) | 8.1.2 | GPL-3.0 build (libx264, libx265 enabled) | decoding, tone-mapping, export encoding. Called as a separate process; not distributed with this repo. Users supply their own ffmpeg. |
| Google Chrome | 155.0.8059.79 | proprietary (Chromium BSD) | headless rendering for export/bench via playwright-core `channel: 'chrome'`; no browser is downloaded |

## Reference material and clips

The reference reel (`refs/`) is third-party footage used only for analysis; it is never committed or shipped,
and no frame, logo or asset from it is used in the implementation. Bench clips and their licenses:
`docs/CLIP_LICENSES.md`.

## Third-party code

No code was copied from other repositories. No third-party repositories were cloned.
