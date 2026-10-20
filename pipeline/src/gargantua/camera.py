"""Global camera motion: per-frame similarity + homography from KLT tracks with RANSAC, classification
(static / drift / pan / handheld) and stabilisation for static or drifting cameras."""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

LK = {"winSize": (21, 21), "maxLevel": 3, "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)}


@dataclass
class CameraMotion:
    cls: str  # static | drift | pan | handheld
    to_ref: np.ndarray  # (T, 2, 3) full-res affine mapping frame t -> reference frame
    from_first: np.ndarray  # (T, 2, 3) frame 0 -> frame t (full res)
    ref: int
    metrics: dict
    reasons: list[str] = field(default_factory=list)
    path: np.ndarray | None = None  # (T, 2) frame-centre position in reference-frame pixels (camera path)


def _to3(m: np.ndarray) -> np.ndarray:
    return np.vstack([m, [0, 0, 1]])


def _features(gray: np.ndarray) -> np.ndarray | None:
    p = cv2.goodFeaturesToTrack(gray, maxCorners=800, qualityLevel=0.005, minDistance=7, blockSize=7)
    return None if p is None or len(p) < 12 else p


def _tracked(a_img: np.ndarray, b_img: np.ndarray, p0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    p1, st, _ = cv2.calcOpticalFlowPyrLK(a_img, b_img, p0, None, **LK)
    pb, st2, _ = cv2.calcOpticalFlowPyrLK(b_img, a_img, p1, None, **LK)
    fb = np.linalg.norm((p0 - pb).reshape(-1, 2), axis=1)
    good = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 0.5)
    return p0.reshape(-1, 2)[good], p1.reshape(-1, 2)[good]


def _similarity(a: np.ndarray, b: np.ndarray, thresh: float) -> np.ndarray | None:
    """RANSAC similarity a->b. A tight threshold keeps slow movers out of the static consensus."""
    if len(a) < 12:
        return None
    m, _ = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=thresh, maxIters=3000,
                                       confidence=0.995)
    return m


def _pair_metrics(prev: np.ndarray, cur: np.ndarray) -> tuple[float, float, float] | None:
    """Consecutive frames: similarity inlier ratio, homography inlier ratio (1 px) and image motion =
    median displacement the RANSAC similarity induces at the feature positions (robust to movers,
    and it captures forward motion, whose expansion barely moves the frame centre)."""
    p0 = _features(prev)
    if p0 is None:
        return None
    a, b = _tracked(prev, cur, p0)
    if len(a) < 12:
        return None
    m, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=1.0, maxIters=2000)
    _, inl_h = cv2.findHomography(a, b, cv2.RANSAC, 1.0)
    if m is None or inl is None or inl_h is None:
        return None
    disp = np.linalg.norm(a @ m[:, :2].T + m[:, 2] - a, axis=1)
    return float(inl.mean()), float(inl_h.mean()), float(np.median(disp))


def _parallax_residual(a_img: np.ndarray, b_img: np.ndarray) -> float | None:
    """Over a long baseline, fit one homography and take the 40th-percentile reprojection error of all
    tracked points: near zero for a rotating/static camera or a flat scene, large when depth varies and
    the camera translates. The low percentile ignores movers as long as they are under ~60% of points."""
    p0 = _features(a_img)
    if p0 is None:
        return None
    a, b = _tracked(a_img, b_img, p0)
    if len(a) < 20:
        return None
    hm, _ = cv2.findHomography(a, b, cv2.RANSAC, 1.5)
    if hm is None:
        return None
    proj = cv2.perspectiveTransform(a.reshape(-1, 1, 2), hm).reshape(-1, 2)
    return float(np.percentile(np.linalg.norm(proj - b, axis=1), 40))


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    pad = np.pad(x, ((k, k), (0, 0)), mode="edge")
    ker = np.ones(2 * k + 1) / (2 * k + 1)
    return np.stack([np.convolve(pad[:, j], ker, mode="valid") for j in range(x.shape[1])], 1)


def classify(m: dict) -> tuple[str, list[str]]:
    """Thresholds are in pixels per 1000 px of image diagonal (resolution independent), validated on the
    synthetic static / drift / pan / parallax scenes (tests/test_camera.py) and the two user clips."""
    reasons = []
    if m["valid_frac"] < 0.5:
        reasons.append(f"camera motion could only be measured on {m['valid_frac']:.0%} of frames (too few trackable features)")
    if m["excursion"] < 0.003 and m["motion"] < 0.1 and m["scale_change"] < 0.01:
        return "static", reasons
    if m["excursion"] < 0.10 and m["motion"] < 0.6 and m["parallax"] < 1.0 and m["scale_change"] < 0.06 and m["jitter"] < 0.8:
        reasons.append(f"camera drifts slightly ({m['excursion_px']:.1f} px max excursion, scale {m['scale_change']:.1%}, "
                       f"rotation {abs(m['rotation_deg']):.1f} deg)")
        return "drift", reasons
    if m["motion"] >= 0.6 and m["parallax"] < 1.0 and m["scale_change"] < 0.06 and m["jitter"] < 1.0:
        reasons.append(f"camera pans {m['motion'] * m['fps'] / 10:.1f}% of the frame diagonal per second; static content will smear along the time axis")
        return "pan", reasons
    if m["motion"] >= 0.6:
        reasons.append(f"large camera motion: the image moves {m['motion'] * m['fps'] / 10:.1f}% of its diagonal per second")
    if m["scale_change"] >= 0.06:
        reasons.append(f"forward or zoom camera motion: image scale changes {m['scale_change']:.0%} over the clip")
    if m["parallax"] >= 1.0:
        reasons.append(f"strong parallax: one homography leaves a {m['parallax']:.2f} per-mille-of-diagonal residual over "
                       f"{m['parallax_baseline']} frames (scene depth cannot be aligned)")
    if m["jitter"] >= 0.8:
        reasons.append(f"hand-held shake: {m['jitter_px']:.1f} px frame-to-frame jitter")
    if not reasons:
        reasons.append("camera motion too large or irregular for drift correction")
    return "handheld", reasons


def estimate_motion(frames: np.ndarray, fps: float, max_width: int = 640) -> CameraMotion:
    t, h, w, _ = frames.shape
    s = min(1.0, max_width / w)
    sw, sh = int(round(w * s)), int(round(h * s))
    grays = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (sw, sh), interpolation=cv2.INTER_AREA) for f in frames]
    # Path: match every frame directly to a keyframe (no frame-to-frame chaining, so no drift
    # accumulates); re-anchor only when the keyframe no longer overlaps well.
    first = [np.eye(3)]
    key, key_feats = 0, _features(grays[0])
    inl_s, inl_h, motion_px, valid, par = [], [], [], [], []
    K = int(max(2, min(20, t // 4)))  # parallax grows with baseline; 20 frames separates walk (1.27) from clip 8 (0.07)
    for i in range(1, t):
        pm = _pair_metrics(grays[i - 1], grays[i])
        if pm:
            inl_s.append(pm[0])
            inl_h.append(pm[1])
            motion_px.append(pm[2])
        if i >= K and i % 3 == 0:
            r = _parallax_residual(grays[i - K], grays[i])
            if r is not None:
                par.append(r)
        m = None
        for attempt in range(2):
            if key_feats is not None:
                a, b = _tracked(grays[key], grays[i], key_feats)
                if len(a) >= max(12, 0.4 * len(key_feats)):
                    m = _similarity(a, b, 0.5)
            if m is not None or attempt == 1 or key == i - 1:
                break
            key, key_feats = i - 1, _features(grays[i - 1])  # re-anchor and retry once
        if m is not None:
            first.append(_to3(m) @ first[key])
            valid.append(True)
            shift = np.hypot(m[0, 2], m[1, 2])
            if shift > 0.25 * sw:
                key, key_feats = i, _features(grays[i])
        else:
            first.append(first[-1].copy())
            valid.append(False)
    S, Si = np.diag([1 / s, 1 / s, 1.0]), np.diag([s, s, 1.0])
    first_full = np.array([(S @ a @ Si)[:2] for a in first], np.float64)
    # centre displacement in frame t of a point that sat at the centre of frame 0
    c = np.array([w / 2, h / 2, 1.0])
    d = np.array([a @ c for a in first_full]) - c[:2]
    # image motion per frame from the robust keyframe path: mean displacement of the frame corners and centre
    # between consecutive frames (captures pans and zooms; movers cannot bias it the way a per-pair fit can)
    # The probe tracks are smoothed over +/-4 frames first: per-frame estimation noise (about 1 px on a night
    # scene full of changing screens) must not read as motion; real pans and zooms persist through smoothing.
    probe = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1], [w / 2, h / 2, 1]], np.float64).T
    tracks_xy = np.stack([a @ probe for a in first_full])  # (T, 2, 5)
    sm = _smooth(tracks_xy.reshape(t, -1), 4).reshape(t, 2, 5) if t > 9 else tracks_xy
    path_motion = np.linalg.norm(np.diff(sm, axis=0), axis=1).mean(axis=1).tolist() or [0.0]
    diag = float(np.hypot(w, h))
    norm = 1000.0 / diag
    step = np.linalg.norm(np.diff(d, axis=0), axis=1) if t > 1 else np.zeros(1)
    jit = d - _smooth(d, 4) if t > 9 else np.zeros_like(d)
    sc = np.array([np.sqrt(abs(np.linalg.det(a[:, :2]))) for a in first_full])
    rot = np.degrees(np.arctan2(first_full[-1][1, 0], first_full[-1][0, 0]))
    metrics = {
        "excursion": float(np.linalg.norm(d, axis=1).max() / diag),
        "excursion_px": float(np.linalg.norm(d, axis=1).max()),
        "speed": float(np.median(step) * norm),
        "speed_px": float(np.median(step)),
        "motion": float(np.median(path_motion) * norm),
        "motion_px": float(np.median(path_motion)),
        "pair_motion_px": float(np.median(motion_px) / s) if motion_px else 0.0,
        "parallax": float(np.median(par) / s * norm) if par else 0.0,
        "parallax_px": float(np.median(par) / s) if par else 0.0,
        "parallax_baseline": K,
        "fps": fps,
        "jitter": float(np.linalg.norm(jit, axis=1).std() * norm + np.abs(jit).mean() * norm),
        "jitter_px": float(np.abs(jit).mean() + np.linalg.norm(jit, axis=1).std()),
        "scale_change": float(abs(np.log(sc.max() / max(sc.min(), 1e-6)))),
        "rotation_deg": float(rot),
        "inlier_sim": float(np.median(inl_s)) if inl_s else 0.0,
        "inlier_h": float(np.median(inl_h)) if inl_h else 0.0,
        "valid_frac": float(np.mean(valid)) if valid else 1.0,
        "analysis_width": sw,
    }
    cls, reasons = classify(metrics)
    # reference frame: the one whose position is closest to the median position (smallest warps)
    ref = int(np.argmin(np.linalg.norm(d - np.median(d, axis=0), axis=1)))
    a_ref = _to3(first_full[ref])
    to_ref = np.array([(a_ref @ np.linalg.inv(_to3(a)))[:2] for a in first_full], np.float64)
    # camera path: where the centre of each frame lands in the reference frame
    path = np.array([m @ c for m in to_ref], np.float32)
    return CameraMotion(cls, to_ref.astype(np.float32), first_full.astype(np.float32), ref, metrics, reasons, path)


def stabilize(frames: np.ndarray, motion: CameraMotion) -> np.ndarray:
    t, h, w, _ = frames.shape
    out = np.empty_like(frames)
    for i in range(t):
        out[i] = cv2.warpAffine(frames[i], motion.to_ref[i].astype(np.float64), (w, h), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_REPLICATE)
    return out


def transform_error_px(to_ref: np.ndarray, cam: np.ndarray, w: int, h: int) -> float:
    """RMS distance (px) between estimated and true frame->reference mappings of the frame corners and
    centre, averaged over frames. The reference is the frame where the estimate is the identity."""
    eye = np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    ref = int(np.argmin([np.abs(m - eye).sum() for m in to_ref]))
    pts = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1], [w / 2, h / 2, 1]], np.float64).T
    cref = _to3(cam[ref].astype(np.float64))
    errs = []
    for i in range(len(to_ref)):
        true = (cref @ np.linalg.inv(_to3(cam[i].astype(np.float64))))[:2]
        errs.append(np.sqrt(((to_ref[i].astype(np.float64) @ pts - true @ pts) ** 2).sum(0).mean()))
    return float(np.mean(errs))


def sharpness_gain(frames: np.ndarray, stable: np.ndarray, support: np.ndarray | None = None) -> dict:
    """Does stabilisation make the static scene measurably sharper? Compares the Laplacian variance of
    the temporal mean image (blurred by drift) and the temporal std of the luma (lower is steadier)."""
    def stats(f):
        g = np.stack([cv2.cvtColor(x, cv2.COLOR_RGB2GRAY) for x in f[:: max(1, len(f) // 120)]]).astype(np.float32)
        mean = g.mean(0)
        h, w = mean.shape
        core = (slice(h // 10, h - h // 10), slice(w // 10, w - w // 10))
        sel = np.ones_like(mean, bool) if support is None else support > 0.6
        lap = cv2.Laplacian(mean, cv2.CV_32F)[core][sel[core]]
        return float(lap.var()), float(g.std(0)[core][sel[core]].mean())
    s0, d0 = stats(frames)
    s1, d1 = stats(stable)
    return {"mean_image_laplacian_var_before": s0, "after": s1, "sharpness_gain": s1 / max(s0, 1e-6) - 1,
            "temporal_std_before": d0, "temporal_std_after": d1}
