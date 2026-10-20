# Reel analysis (P1)

Target: `refs/reel.mp4`, a silent screen recording of an Instagram reel, 874x880, 30 fps CFR, 12.93 s,
388 frames. The cube content runs **0.0 to 11.0 s**. From 11.1 s the recording shows a profile page, which
is ignored per spec.

**How every number here was produced**

```bash
ffmpeg -i refs/reel.mp4 -vf fps=10 -start_number 0 work/p1/frames/f_%04d.png    # 129 frames
pipeline/.venv/Scripts/python tools/p1/reel_measure.py                            # ~15 s
```
Raw results: `work/p1/measure/measurements.json`. Overlays and crops: `work/p1/measure/`. Timeline sheets:
`work/p1/sheets/`. All reel-derived images stay under `work/`, which is gitignored. They are third-party
frames and are never committed. Frame references below use reel time in seconds (`t=1.7` means
`f_0017.png`).

---

## 1. Timeline of states (10 fps, cube part)

`crisp` is the fraction of box pixels with strong local detail and luma > 90. Solid faces score about 0.65
to 0.72. Pure smoke scores about 0.07 to 0.14.

| Reel time | Camera | Density state | crisp | What is on screen |
|---|---|---|---|---|
| 0.0-0.7 | static 3/4 view (front-right, above) | **solid** | 0.67-0.72 | Front face = first frame (red coat walker). Right face = rightmost image column over time. Top face = top row over time (streaky). |
| 0.8-1.7 | static | **dissolve**: smoke grows from the front, a solid cut plane recedes toward the back | 0.58 to 0.32 | The cut face shows a *later* frame. The source clip moves to a top-down view during this sweep. |
| 1.8-2.4 | static | **re-solidify** (cut plane returns to the front) | 0.43 to 0.65 | Same view as 0.0 |
| 2.5-2.7 | static | solid | 0.67 | |
| 2.8-3.5 | static | dissolve again | 0.59 to 0.28 | |
| 3.6-4.7 | orbit to near **top-down**, box rolled ~45° | smoke + thin solid slab at the far end | 0.11-0.21 | Smoke shows **dark curved streaks**: walkers' paths in the (x, t) plane, integrated over y |
| 4.8-5.7 | moves to **head-on** (looking down the time axis from the front) | smoke + far slab | 0.22-0.48 | The slab frame is seen *through* the smoke. Static stripes are sharp, walkers ghost. A bright rectangle plus a vertical centre line appear. |
| 5.8-9.6 | **flies inside** the box | smoke all around | 0.07-0.31 | Red smear of the coat, ghosted crowd, thin white guide lines crossing the view |
| 9.7-11.0 | **hero orbit** outside, from back-left round to the start pose | **solid** | 0.65-0.70 | Back face = last frame, **mirrored** ("STOP" reads reversed) |

The full per-frame series is in `measurements.json` → `timeline`.

## 2. What each view shows (geometry)

- **Time runs along box depth.** The front face is the first frame (t=0) and the back face is the last frame. Evidence: the front face at t=0.0 and 11.0 shows the opening shot (street-level walker in red). The face seen from behind at t=9.7-10.3 shows the closing top-down shot with "STOP" painted on the road, mirror-reversed.
- **Side faces are space-time slices.** The right face is x=max over time and the top face is y=0 over time. Anything that moves smears into streaks, which is why the top face looks like brushed metal.
- **The dissolve cut face is the frame at the threshold time τ.** As τ sweeps back, the cut face plays the clip forward. At t=1.2-1.7 it already shows the top-down shot.
- **Views along the time axis** (t=4.8-5.7, head-on) keep the image position fixed while time varies along each ray. So static content stays registered and sharp, and movers average into ghosts.
- **Views across the time axis** (t=3.6-4.7, top-down) integrate one spatial axis. Static detail such as stripes washes into uniform haze, and each moving walker draws a dark curve: its worldline seen in the x-t plane.

## 3. Opacity model (my reading)

The look is consistent with plain front-to-back emission-absorption ray-marching of the **raw video colours**:

```
C = Σ_i  T_i · (1 − exp(−σ(t_i) · Δs)) · rgb(x_i, y_i, t_i),   T_{i+1} = T_i · exp(−σ(t_i) · Δs)
σ(t) = σ_solid  for t ≥ τ      (solid: the first sample is nearly opaque, so faces show crisp texels)
σ(t) = σ_smoke  for t < τ      (smoke: low extinction, the whole depth contributes)
```
Composited over pure black. There is no evidence of background subtraction (H1, below). The threshold
edge is hard (the cut face is sharp-edged at t=0.8-1.7). The smoke thins toward the box boundary over
roughly 40-80 px at this zoom (soft inner falloff, section H4).

### Optical-depth estimate (`optical_depth_t1.7`)
Region: smoke-only rays at t=1.7, with only black behind them. Reference: the pavement on the solid front
face at t=0.0.

| | value |
|---|---|
| smoke luma (sRGB 8-bit) | 52.2 |
| pavement luma (sRGB 8-bit) | 206.0 |
| opacity if blended in display space | 0.253 → **τ ≈ 0.29** along those rays |
| opacity if blended in linear light | 0.056 → τ ≈ 0.06 |

Which blending space the reel's app uses was unknown at this point. It was then measured by rendering:
section 8 shows that linear-light blending fits better. The density is fitted *by rendering*, not taken
from this single region.

## 4. Hypotheses

### H1: interior smoke is the raw video colour, with no background subtraction. **Supported.**
- **Haze colour = pavement colour, darkened.** In CIELAB, the pavement at t=0.0 has hue 69.5° and chroma 7.0 (L* 82.5). The smoke at t=1.7 has hue 55.9° and chroma 3.3 (L* 21.7). Same warm-grey hue family, desaturated and dark, as expected for a low-opacity layer over black. Background subtraction would give near-black or mover-coloured smoke instead.
- **The red coat stays red inside the smoke.** Saturated-red pixel fraction of the whole frame: 0.26% at t=0.0 (solid, small figure), 2.6-2.9% at t=6.6, 7.2 and 9.0 (inside the smoke), and 0.0% at t=3.8 (top-down, coat not in view).
- **Stripes remain visible inside the smoke.** This is visual evidence: `crop_stripes_smoke_t1.2.png` and `crop_smoke_t1.7.png` show the periodic zebra banding, faint. The high-pass amplitude is 3.9 luma in smoke versus 26.7 on the solid face. My periodicity *metric* is not reliable: its peak sits at the band edge for all three regions. So this point rests on the crops, not on that number.
- **Static sharp, movers ghost.** Seen in head-on views (t=4.8-5.7): stripes are crisp and walkers doubled. **Correction to the spec's wording:** static content is sharpest when viewed *along* the time axis. In strongly oblique or top-down views (t=3.6-4.7) static detail washes out and movers become dark x-t curves. This is the expected behaviour of integrating raw colour.

### H2: solid ↔ smoke through a time-threshold density change, partial states possible. **Supported and made specific.**
- σ is high for t ≥ τ and low for t < τ. The solid part is always the *later* part of the clip. The cut face shows frame τ.
- Measured sweeps (crisp fraction): solid 0.67 at 0.0-0.7 → 0.32 at 1.2-1.7 → back to 0.65 at 2.4-2.7 → 0.28 at 3.2-3.5.
- A thin solid slab at the far end persists through 3.6-5.7 (top-down and head-on views).

### H3: viewing a face from behind shows mirrored content. **Supported.**
At t=9.7-10.3 the back face shows the last frame with "STOP" reversed (`refs/still_182136.png` shows the
same). This falls out of ray-marching a volume and is **not** corrected.

### H4: thin wireframe, glow outside edges, pure black background, unknown guide lines. **Partly supported.**
- **Background:** pure black. Across 2,505,840 pixels away from the box (7 frames), mean BGR is (0, 0, 0) and max luma is 2/255.
- **Wireframe:** about 1 px light grey-blue lines on all 12 edges, visible through the smoke. On the solid box at t=0.0 the line sits about 8-10 px *outside* the content edge (profile `glow_profile_t0.0_x250`: face ends at index 47, line peak 20 at index 56), so the content is inset slightly or the line box is slightly larger.
- **Glow outside the edges: not observed.** At all five measured edge profiles (t=0.0 x=250/500, t=0.8 x=300/500, t=1.7 x=640), luma reaches ≤ 1 before the wireframe line and is 0 beyond it. What reads as glow is a **soft inner falloff**: the smoke fades from about 65-107 to 0 over 40-80 px inside the box near its edges. The renderer implements that falloff. Bloom and edge glow (required by the spec) are kept subtle and optional so they don't contradict the reel.
- **Guide lines: identified (hypothesis consistent with all frames).** A bright white rectangle plus a vertical centre line appear at 4.8-9.6. At t=5.4 the rectangle coincides exactly with the outline of the solid slab's cut face, and the vertical line splits it at x = W/2. Inside the box (t=5.8-9.6) their edges cross the view at the slab's depth. Reading: a **slice-frame marker** outlining the cross-section at the threshold time τ, with a centre guide. It is replicated as the "slice frame" layer (rectangle at τ plus a centre line), toggleable. The *purpose* of the centre line in the original app is unknown. It might be a slit or scan marker. It is replicated as a guide only.

## 5. Box proportions and camera (`box_fit`)
Six-vertex silhouettes of three solid frames, fitted by PnP over (W/H, D/W, focal length). The vertex
correspondence was fixed by the visible faces read from content. Overlays: `work/p1/measure/fit_*.png`.
The near vertical edge of each fit lands on the real face boundary.

| frame | silhouette RMS (px) | front W/H | depth D/W | focal (px, 874-px frame) |
|---|---|---|---|---|
| t=0.0 | 5.4 | 1.89 | 0.96 | 1398 |
| t=10.3 | 4.4 | 1.68 | 1.13 | 1391 |
| t=11.0 | 3.6 | 1.85 | 1.04 | 1300 |
| **mean** | | **1.81** (16:9 = 1.78) | **1.04** | ≈1360 → vertical FOV ≈ 35° |

**Defaults derived from this:** front face = the clip's own aspect, and depth D = 1.0 × front width
(override slider 0.4-2.0). Camera FOV is 35°.

## 6. Beat sheet → director sequence (P9)
| t (s) | beat | parameters |
|---|---|---|
| 0.0-0.8 | solid hold, 3/4 front-right-above | τ=0 (all solid) |
| 0.8-1.7 | dissolve | τ: 0 → 0.85 |
| 1.7-2.5 | re-solidify | τ: 0.85 → 0 |
| 2.8-3.5 | dissolve | τ: 0 → 0.9 |
| 3.6-4.7 | orbit to top-down, rolled | τ ≈ 0.95 (thin far slab) |
| 4.8-5.7 | head-on, slice frame visible | |
| 5.8-9.6 | fly inside, slow drift | slice frame visible |
| 9.7-11.0 | fly out to solid hero orbit, ending at the start pose | τ → 0 |

## 7. Assumptions and limits
- The reel's source footage is an overhead/high-angle crossing with sparse walkers. Its look relies on the static ground filling the frame. Clips without that property will not look the same in REEL mode (measured in P4/P8).
- Optical depth: the blending space is unknown, so the target comes from a render fit (section 3).
- The proportions come from three poses. The spread is ±0.1 in W/H and ±0.09 in D/W.
- The meaning of the vertical guide line is inferred, not known.
- The cursor and mute icon in the recording are UI artefacts and are excluded from the measurements.

---

## 8. Hypotheses tested by rendering (P3/P4)

Renders are produced by the GARGANTUA viewer in headless Chrome on the RTX 5070. Scripts:
`tools/bench/calibrate.mjs`, `tools/bench/replica_render.mjs` + `replica_score.py`, `tools/bench/contact.mjs`.
Evidence: `docs/evidence/p3/calibration.json`, `docs/evidence/p3/blend_test/`, `docs/evidence/p4/replica.json`.
Images are in `work/contact/` and `work/replica/` (not committed: some contain reel frames).

**H1, raw colour volume. Replicated and measured** on the synthetic overhead crossing, under the default linear blending (`docs/evidence/p4/replica.json`, verdict PASS):
- Static content stays sharp head-on, as measured on a near-orthographic head-on view (4° FOV). Brightness-normalised Laplacian variance, smoke ÷ solid: **0.551** head-on versus **0.021** oblique (26x).
- Movers ghost. Head-on smoke correlates 0.72 with the clip's time-mean frame. At walker pixels it differs from the time mean by 59.1 grey levels and from the actual frame by 101.8 (ratio **0.581**).
- Stripes stay visible inside the smoke. Spectral energy at the stripe frequency (19.2 px period at the reel framing) in the smoke-only band is **0.103** in REEL and **0.0073** in SEPARATED. SEPARATED keeps only the walkers' streaks, which are irregular. A first, frequency-blind modulation metric counted those streaks as stripes, and it was replaced.
- The haze takes the pavement's hue: hue 91.6° with chroma 2.45, against the pavement's 84.6° with chroma 6.17. This is the same pattern as the reel (56° versus 70°).

**Opacity model and blending space. Measured at the reel's own camera poses: both blendings fit the two reel
measurements within about 2%; the one unfitted check slightly favours linear light, which stays the default.**
The blending space is a switch (`displayBlend`). The density is fitted jointly to two reel measurements, the
top-down haze ÷ solid front face (0.371) and the 1.7 s smoke band (0.253), under both settings. The reel's
inside view (0.563) is then compared without being fitted (`docs/evidence/p3/blend_test/`):

| blending | fitted optical depth (full time axis) | joint objective | top-down | 1.7 s band | inside (unfitted) |
|---|---|---|---|---|---|
| **linear light** (default) | 0.2791 | 0.0010 | 0.378 (reel 0.371) | 0.247 (reel 0.253) | 0.72 (reel 0.563) |
| display space | 1.0737 | 0.0005 | 0.376 (reel 0.371) | 0.249 (reel 0.253) | 0.76 (reel 0.563) |

**Corrections recorded.**
1. An early version of this section claimed display space was favoured, with a 6% agreement. Those numbers
   came from a renderer bug: at τ = 1 the soft threshold edge left the last 0.25% of the time axis solid, so
   the back face rendered as an opaque wall. Daylight white paint was also being boosted as "emissive". Both
   are fixed and regression-tested (`viewer/tests/math.test.ts`).
2. The next version claimed linear light fitted clearly better (joint residual 0.074 against 0.157, with
   top-down -17% and band +23%). Those fits rendered the director's poses at the reel's timestamps, but the
   director did not yet follow the reel: at 3.8 s it was still mid-orbit (silhouette 0.25 of the frame against
   the reel's 0.44), its hero framing had been taken as 16:9 although it was measured on the reel's 874x880
   frame (box 0.60 x 0.44 of the frame against the reel's 0.90 x 0.61), and the top-down spin was missing.
   With the hero pose fitted to the reel's t = 0 silhouette (`tools/bench/fit_frame.mjs`: 0.910 x 0.609) and
   the 3.6-5.8 s camera retimed from the reel frames (`tools/bench/director_strip.mjs`), both blendings fit
   within 2% and the difference between them is small. The discriminating evidence is the unfitted inside
   view, and it is weak. The inside view cannot be a fitting target: the synthetic crossing's bimodal
   brightness (dark asphalt, white stripes) makes face-median normalisation non-transferable.

**H2, time threshold. Replicated.** `tau` drives solid-later / smoke-earlier exactly as measured. The cut
face shows frame τ, and the director reproduces the 0 → 0.85 → 0 → 0.9 sweeps
(`viewer/src/director/reelSequence.ts`).

**H3, mirrored from behind. Replicated, not corrected.** `work/h3_compare.png` shows "STOP" reading normally on
the front face and mirrored on the back face, as in the reel at t = 9.7-10.3.

**H4. Replicated as measured.** The background is pure black. The thin grey-blue wireframe sits 1.2% outside
the content, and its edges are faded by CPU-computed transmittance through the cube, so back edges vanish
behind a solid box and show faintly through smoke. The guide lines are replicated as the slice-frame layer:
a white rectangle on the cut face at τ plus a centre line. There is no glow outside the edges by default
(bloom is 0.03 in daylight scenes and only feeds emissive pixels in night scenes); most of the soft edge is
geometric, from short rays near the silhouette, plus a small explicit fade (5% of the shortest side).

**Exposure.** It is fitted so that the solid front face reproduces the source frame's mean brightness
(148.44 rendered against 148.44 source, exposure 0.7565).
