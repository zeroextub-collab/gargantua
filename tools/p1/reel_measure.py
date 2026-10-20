"""P1 reel measurements. Every number in docs/REEL_ANALYSIS.md comes from this script.

Run:  pipeline/.venv/Scripts/python tools/p1/reel_measure.py
Input: work/p1/frames/f_%04d.png (reel at 10 fps, extracted by ffmpeg; see PROGRESS.md).
Output: work/p1/measure/*.png (overlays, crops) and work/p1/measure/measurements.json.

The reel frames are third-party content. They stay under work/ (gitignored) and are never committed.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FRAMES = ROOT / "work" / "p1" / "frames"
OUT = ROOT / "work" / "p1" / "measure"
FPS = 10.0
CUBE_END_S = 11.0  # from 11.1 s the reel shows a profile page (ignored per spec)


def load(i: int) -> np.ndarray:
    img = cv2.imread(str(FRAMES / f"f_{i:04d}.png"), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(FRAMES / f"f_{i:04d}.png")
    return img


def luma(img: np.ndarray) -> np.ndarray:
    b, g, r = (img[..., k].astype(np.float32) for k in range(3))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def box_mask(img: np.ndarray, thresh: float) -> np.ndarray:
    """Largest bright connected region (the cube); ignores the corner UI icon and cursor."""
    m = (luma(img) > thresh).astype(np.uint8)
    m[-60:, -60:] = 0  # mute icon of the screen recording
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return np.zeros_like(m, bool)
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == k


# --------------------------------------------------------------------------- timeline
def timeline(n_frames: int) -> list[dict]:
    rows = []
    for i in range(n_frames):
        t = i / FPS
        img = load(i)
        y = luma(img)
        m = box_mask(img, 12.0)
        area = float(m.mean())
        lap = cv2.Laplacian(y, cv2.CV_32F, ksize=3)
        # per-pixel local detail (abs Laplacian, smoothed) separates crisp faces from smoke
        detail = cv2.GaussianBlur(np.abs(lap), (0, 0), 3)
        crisp = m & (detail > 6.0) & (y > 90)
        rows.append(
            {
                "t": round(t, 1),
                "box_area_frac": round(area, 4),
                "mean_luma_in_box": round(float(y[m].mean()) if m.any() else 0.0, 1),
                "crisp_frac_of_box": round(float(crisp.sum() / max(m.sum(), 1)), 3),
                "edge_touch": bool(m[0, :].any() or m[-61, :].any() or m[:, 0].any() or m[:, -1].any()),
            }
        )
    return rows


# --------------------------------------------------------------------------- background
def background_stats(idx: list[int]) -> dict:
    vals = []
    for i in idx:
        img = load(i)
        m = box_mask(img, 12.0)
        # exclude the box, a 40 px glow margin, the corner icon and the cursor-prone centre
        far = ~cv2.dilate(m.astype(np.uint8), np.ones((81, 81), np.uint8)).astype(bool)
        far[-70:, -70:] = False
        vals.append(img[far].reshape(-1, 3))
    v = np.concatenate(vals).astype(np.float32)
    return {
        "frames": idx,
        "pixels": int(len(v)),
        "mean_bgr": [round(float(x), 2) for x in v.mean(0)],
        "p99_luma": round(float(np.percentile(0.0722 * v[:, 0] + 0.7152 * v[:, 1] + 0.2126 * v[:, 2], 99)), 2),
        "max_luma": round(float((0.0722 * v[:, 0] + 0.7152 * v[:, 1] + 0.2126 * v[:, 2]).max()), 2),
    }


# --------------------------------------------------------------------------- colour of the haze
def chroma_of(img: np.ndarray, mask: np.ndarray) -> dict:
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    px = lab[mask]
    L, a, b = px[:, 0] * 100 / 255, px[:, 1] - 128, px[:, 2] - 128
    hue = float(np.degrees(np.arctan2(b.mean(), a.mean())) % 360)
    return {
        "pixels": int(mask.sum()),
        "L_mean": round(float(L.mean()), 1),
        "a_mean": round(float(a.mean()), 2),
        "b_mean": round(float(b.mean()), 2),
        "chroma": round(float(np.hypot(a.mean(), b.mean())), 2),
        "hue_deg": round(hue, 1),
    }


def red_fraction(img: np.ndarray, mask: np.ndarray) -> float:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    red = ((h < 8) | (h > 170)) & (s > 70) & (v > 60)
    return float((red & mask).sum() / max(mask.sum(), 1))


# --------------------------------------------------------------------------- stripes inside smoke
def stripe_contrast(img: np.ndarray, rect: tuple[int, int, int, int]) -> dict:
    """Stripe periodicity: high-pass the region (removes smoke gradients), then find the strongest
    spectral peak with a period of 8-60 px over all orientations. ratio = peak / median spectrum in band;
    amp = RMS of the high-passed profile in luma units (how visible the stripes are)."""
    x0, y0, x1, y1 = rect
    y = luma(img)[y0:y1, x0:x1]
    y = y - cv2.GaussianBlur(y, (0, 0), 25)  # remove illumination / smoke gradients
    best = {"ratio": 0.0}
    for ang in range(0, 180, 3):
        rot = cv2.getRotationMatrix2D(((x1 - x0) / 2, (y1 - y0) / 2), ang, 1.0)
        r = cv2.warpAffine(y, rot, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        prof = r[r.shape[0] // 4 : 3 * r.shape[0] // 4].mean(0)
        prof = prof - prof.mean()
        n = len(prof)
        spec = np.abs(np.fft.rfft(prof * np.hanning(n)))
        k = np.arange(len(spec))
        band = (k >= n / 60) & (k <= n / 8)
        kb = k[band]
        ratio = float(spec[band].max() / (np.median(spec[band]) + 1e-6))
        if ratio > best["ratio"]:
            best = {"ratio": round(ratio, 1), "angle_deg": ang, "period_px": round(n / int(kb[spec[band].argmax()]), 1),
                    "amp_luma": round(float(prof.std()), 2)}
    return best


# --------------------------------------------------------------------------- box proportions (PnP fit)
def hexagon(img: np.ndarray) -> np.ndarray:
    m = box_mask(img, 40.0).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    hull = cv2.convexHull(max(cnts, key=cv2.contourArea))
    peri = cv2.arcLength(hull, True)
    for eps in np.linspace(0.002, 0.08, 200):
        poly = cv2.approxPolyDP(hull, eps * peri, True)
        if len(poly) == 6:
            return poly.reshape(6, 2).astype(np.float64)
    raise RuntimeError("silhouette did not reduce to a hexagon")


def box_corners(w: float, h: float, d: float) -> dict[str, np.ndarray]:
    out = {}
    for sx, sy, sz in itertools.product((-1, 1), repeat=3):
        out[("R" if sx > 0 else "L") + ("T" if sy > 0 else "B") + ("F" if sz > 0 else "K")] = np.array(
            [sx * w / 2, sy * h / 2, sz * d / 2]
        )
    return out


def silhouette_cycles() -> list[list[str]]:
    """Every 6-cycle of box corners that can be a perspective silhouette when three faces are visible.

    For a view seeing faces (X, Y, Z) the silhouette omits the corner shared by those faces and the
    opposite corner; the remaining six form the outline in cyclic order.
    """
    cycles = []
    for sx, sy, sz in itertools.product("LR", "TB", "FK"):
        near = sx + sy + sz
        far = {"L": "R", "R": "L"}[sx] + {"T": "B", "B": "T"}[sy] + {"F": "K", "K": "F"}[sz]
        rest = [a + b + c for a, b, c in itertools.product("LR", "TB", "FK") if a + b + c not in (near, far)]
        # order the six by walking edges (neighbours differ in exactly one letter)
        cyc = [rest[0]]
        while len(cyc) < 6:
            nxt = [c for c in rest if c not in cyc and sum(x != y for x, y in zip(c, cyc[-1], strict=True)) == 1]
            cyc.append(nxt[0])
        cycles.append(cyc)
    return cycles


def _solve(pts, cyc, aspect, depth, f, cx, cy):
    corners = box_corners(aspect, 1.0, depth * aspect)
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)
    obj = np.array([corners[c] for c in cyc])
    best = None
    for rot in range(6):
        for direction in (1, -1):
            order = [(rot + direction * k) % 6 for k in range(6)]
            img_pts = pts[order]
            ok, rvec, tvec = cv2.solvePnP(obj, img_pts, K, None, flags=cv2.SOLVEPNP_SQPNP)
            if not ok or tvec[2, 0] <= 0:
                continue
            proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
            err = float(np.sqrt(((proj.reshape(-1, 2) - img_pts) ** 2).sum(1).mean()))
            if best is None or err < best[0]:
                best = (err, order, rvec, tvec)
    return best


def fit_box(pts: np.ndarray, img_size: tuple[int, int], near: str) -> dict:
    """PnP fit of a W:H:D box to the 6-vertex silhouette. `near` is the corner shared by the three faces
    that are visibly in view (identified from face content), which fixes the vertex correspondence."""
    W, H = img_size
    cx, cy = W / 2, H / 2
    cyc = next(c for c in silhouette_cycles() if near not in c and len(set(c)) == 6
               and all(sum(x != y for x, y in zip(c[i], c[(i + 1) % 6], strict=True)) == 1 for i in range(6))
               and _far(near) not in c)
    best = None

    def consider(a, d, f):
        nonlocal best
        r = _solve(pts, cyc, a, d, f, cx, cy)
        if r and (best is None or r[0] < best["rms_px"]):
            best = {"rms_px": r[0], "aspect_w_over_h": float(a), "depth_over_w": float(d), "focal_px": float(f),
                    "near_corner": near, "cycle": cyc, "order": r[1], "rvec": r[2].ravel().tolist(),
                    "tvec": r[3].ravel().tolist()}

    for a in np.arange(1.2, 2.21, 0.05):
        for d in np.arange(0.4, 2.01, 0.05):
            for f in (450, 650, 900, 1250, 1700, 2300, 3200):
                consider(a, d, f)
    a0, d0, f0 = best["aspect_w_over_h"], best["depth_over_w"], best["focal_px"]
    for a in np.arange(a0 - 0.06, a0 + 0.061, 0.01):
        for d in np.arange(d0 - 0.06, d0 + 0.061, 0.01):
            for f in np.linspace(f0 * 0.75, f0 * 1.33, 9):
                consider(a, d, f)
    return best


def _far(c: str) -> str:
    return {"L": "R", "R": "L"}[c[0]] + {"T": "B", "B": "T"}[c[1]] + {"F": "K", "K": "F"}[c[2]]


def overlay_fit(img: np.ndarray, fit: dict, out: Path) -> None:
    W, H = img.shape[1], img.shape[0]
    K = np.array([[fit["focal_px"], 0, W / 2], [0, fit["focal_px"], H / 2], [0, 0, 1]], float)
    a, dep = fit["aspect_w_over_h"], fit["depth_over_w"]
    corners = box_corners(a, 1.0, dep * a)
    names = list(corners)
    proj, _ = cv2.projectPoints(np.array([corners[n] for n in names]), np.array(fit["rvec"]), np.array(fit["tvec"]), K, None)
    p = {n: tuple(int(round(v)) for v in proj[i, 0]) for i, n in enumerate(names)}
    vis = img.copy()
    for u, v in itertools.combinations(names, 2):
        if sum(x != y for x, y in zip(u, v, strict=True)) == 1:
            cv2.line(vis, p[u], p[v], (0, 255, 255), 1, cv2.LINE_AA)
    for n in names:
        cv2.putText(vis, n, p[n], cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 200, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out), vis)


# --------------------------------------------------------------------------- glow profile
def edge_profile(img: np.ndarray, x: int, y0: int, y1: int) -> list[float]:
    y = luma(img)
    return [round(float(y[r, x - 3 : x + 4].mean()), 1) for r in range(y0, y1)]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    n = len(list(FRAMES.glob("f_*.png")))
    res: dict = {"frames_total": n, "fps": FPS, "cube_end_s": CUBE_END_S}
    n_cube = int(CUBE_END_S * FPS) + 1
    res["timeline"] = timeline(n_cube)
    res["background"] = background_stats([0, 8, 17, 38, 54, 100, 110])

    # haze vs pavement (regions picked from the full-res frames, coordinates in the 874x880 frame)
    f0, f17 = load(0), load(17)
    pave = np.zeros(f0.shape[:2], bool)
    pave[540:615, 130:330] = True  # pavement + stripes on the solid front face, t=0.0 s
    smoke = np.zeros(f17.shape[:2], bool)
    smoke[420:580, 130:340] = True  # smoke-only region (black behind), t=1.7 s
    res["haze_vs_pavement"] = {"pavement_t0.0": chroma_of(f0, pave), "smoke_t1.7": chroma_of(f17, smoke)}
    cv2.imwrite(str(OUT / "crop_pavement_t0.0.png"), f0[540:615, 130:330])
    cv2.imwrite(str(OUT / "crop_smoke_t1.7.png"), f17[420:580, 130:340])

    # red coat survives inside the smoke (fly-inside frames) vs a frame without it in view
    whole = np.ones(f0.shape[:2], bool)
    res["red_fraction"] = {f"t{i / FPS:.1f}": round(red_fraction(load(i), whole), 4) for i in (0, 38, 66, 72, 90)}

    # stripes visible inside smoke: smoke-only lower region at 1.2 s vs. a flat region of pure smoke at 3.8 s
    res["stripes"] = {
        "smoke_bottom_t1.2": stripe_contrast(load(12), (90, 450, 330, 650)),
        "smoke_topdown_t3.8": stripe_contrast(load(38), (190, 320, 430, 520)),
        "solid_face_t0.0": stripe_contrast(f0, (130, 450, 330, 600)),
    }
    cv2.imwrite(str(OUT / "crop_stripes_smoke_t1.2.png"), load(12)[450:650, 90:330])

    # box proportions from the solid silhouettes at three camera poses
    fits = {}
    # near corner per frame, read from face content: t=0.0 and 11.0 show the first frame (front, F), the
    # right side and the top -> RTF; t=10.3 shows the last frame mirrored (back, K) with the box's left
    # side on image-right and the top -> LTK.
    for i, near in ((0, "RTF"), (103, "LTK"), (110, "RTF")):
        img = load(i)
        pts = hexagon(img)
        fit = fit_box(pts, (img.shape[1], img.shape[0]), near)
        fits[f"t{i / FPS:.1f}"] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in fit.items()}
        overlay_fit(img, fit, OUT / f"fit_t{i / FPS:.1f}.png")
    res["box_fit"] = fits

    # glow: luminance profile straight down across the bottom front edge into the black background
    res["glow_profile_t0.8_x300"] = edge_profile(load(8), 300, 600, 760)
    res["glow_profile_t0.0_x250"] = edge_profile(f0, 250, 620, 760)

    res["glow_profile_t0.8_x500"] = edge_profile(load(8), 500, 680, 840)
    res["glow_profile_t1.7_x640"] = edge_profile(load(17), 640, 560, 760)
    res["glow_profile_t0.0_x500"] = edge_profile(f0, 500, 680, 840)

    # optical depth along the rays of the smoke-only region at 1.7 s (black behind them).
    # Over black, displayed = (1 - T) * C_avg. C_avg is approximated by the pavement colour of the solid
    # face at 0.0 s, so 1 - T is an upper bound on opacity's complement only to the extent people darken C_avg.
    def srgb_to_lin(v):
        v = v / 255.0
        return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    sm = luma(f17)[420:580, 130:340].mean()
    pv = luma(f0)[540:615, 130:330].mean()
    a_disp = sm / pv
    a_lin = float(srgb_to_lin(np.array(sm)) / srgb_to_lin(np.array(pv)))
    res["optical_depth_t1.7"] = {
        "smoke_luma_srgb": round(float(sm), 1), "pavement_luma_srgb": round(float(pv), 1),
        "opacity_if_blended_in_display_space": round(float(a_disp), 3),
        "tau_display_space": round(float(-np.log(1 - a_disp)), 3),
        "opacity_if_blended_in_linear_light": round(a_lin, 3),
        "tau_linear_light": round(float(-np.log(1 - a_lin)), 3),
    }

    (OUT / "measurements.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "timeline"}, indent=1))


if __name__ == "__main__":
    main()
