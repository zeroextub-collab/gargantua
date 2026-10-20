"""Worldlines: KLT feature tracks (goodFeaturesToTrack + pyramidal Lucas-Kanade) with a forward-backward
check and re-seeding, turned into (x, y, t) polylines of things that actually move."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .camera import CameraMotion

LK = {"winSize": (15, 15), "maxLevel": 3, "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)}


@dataclass
class Track:
    start: int  # first frame index
    points: np.ndarray  # (n, 2) float32, x / W and y / H in [0, 1]
    color: tuple[int, int, int]
    speed: float  # mean full-res px per frame (camera-compensated when a camera model is given)


def _detect(gray: np.ndarray, mask: np.ndarray | None, n: int, min_dist: int) -> np.ndarray:
    p = cv2.goodFeaturesToTrack(gray, maxCorners=n, qualityLevel=0.01, minDistance=min_dist, blockSize=5, mask=mask)
    return np.zeros((0, 2), np.float32) if p is None else p.reshape(-1, 2).astype(np.float32)


def track(
    frames: np.ndarray,
    max_tracks: int = 1500,
    min_len: int = 10,
    reseed_every: int = 4,
    fb_thresh: float = 0.8,
    min_motion_px: float = 4.0,
    camera: CameraMotion | None = None,
    max_width: int = 960,
    max_active: int = 4000,
    exclude_mask: np.ndarray | None = None,
) -> list[Track]:
    """exclude_mask: (H, W) in [0, 1]; tracks that spend most of their life inside it (animated screens)
    are dropped, since changing screen content is not an object moving."""
    t, h, w, _ = frames.shape
    s = min(1.0, max_width / w)
    sw, sh = int(round(w * s)), int(round(h * s))
    grays = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (sw, sh), interpolation=cv2.INTER_AREA) for f in frames]
    min_dist = max(4, int(round(6 * s)))

    pos = _detect(grays[0], None, max_active // 2, min_dist)
    ids = list(range(len(pos)))
    tracks: list[list] = [[0, [p.copy()]] for p in pos]
    for i in range(1, t):
        if len(pos):
            p0 = pos.reshape(-1, 1, 2)
            p1, st, _ = cv2.calcOpticalFlowPyrLK(grays[i - 1], grays[i], p0, None, **LK)
            pb, st2, _ = cv2.calcOpticalFlowPyrLK(grays[i], grays[i - 1], p1, None, **LK)
            fb = np.linalg.norm((p0 - pb).reshape(-1, 2), axis=1)
            p1 = p1.reshape(-1, 2)
            ok = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < fb_thresh)
            ok &= (p1[:, 0] >= 0) & (p1[:, 0] < sw) & (p1[:, 1] >= 0) & (p1[:, 1] < sh)
            new_pos, new_ids = [], []
            for k in np.nonzero(ok)[0]:
                tracks[ids[k]][1].append(p1[k].copy())
                new_pos.append(p1[k])
                new_ids.append(ids[k])
            pos = np.array(new_pos, np.float32).reshape(-1, 2)
            ids = new_ids
        if i % reseed_every == 0 and len(pos) < max_active:
            mask = np.full((sh, sw), 255, np.uint8)
            for p in pos:
                cv2.circle(mask, (int(p[0]), int(p[1])), min_dist, 0, -1)
            fresh = _detect(grays[i], mask, max_active - len(pos), min_dist)
            for p in fresh:
                ids.append(len(tracks))
                tracks.append([i, [p.copy()]])
            pos = np.vstack([pos, fresh]) if len(fresh) else pos

    excl = None
    if exclude_mask is not None:  # grow the screen mask a little: tracks hug the borders of changing content
        r = max(3, int(round(0.012 * w)))
        excl = cv2.dilate((exclude_mask > 0.5).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    out: list[Track] = []
    for start, pts in tracks:
        if len(pts) < min_len:
            continue
        p = np.array(pts, np.float32) / s  # full-res px
        rel = p
        if camera is not None:  # judge motion in the reference frame so camera motion is not "movement"
            m = camera.to_ref[start : start + len(p)]
            rel = np.einsum("tij,tj->ti", m[:, :, :2], p) + m[:, :, 2]
        disp = np.linalg.norm(rel - rel[0], axis=1).max()
        # A mover TRAVELS: over a 10-frame window it covers >= 0.3 px/frame. A static corner that jitters
        # 0.3-0.5 px every frame (noise, compression, stabilisation interpolation) random-walks to ~1.3 px over
        # the same window, and a corner dragged by a passer-by moves on only a few frames.
        win = min(10, len(rel) - 1)
        travel = np.linalg.norm(rel[win:] - rel[:-win], axis=1) / win
        if disp < min_motion_px or (travel > 0.3).mean() < 0.6 or np.median(travel) < 0.3:
            continue
        if excl is not None:
            ii = np.clip(np.round(p).astype(int), 0, [w - 1, h - 1])
            if excl[ii[:, 1], ii[:, 0]].mean() > 0.35:
                continue
        if len(p) >= 5:  # light temporal smoothing removes sub-pixel KLT jitter
            pad = np.pad(p, ((2, 2), (0, 0)), mode="edge")
            p = np.stack([np.convolve(pad[:, j], np.ones(5) / 5, mode="valid") for j in range(2)], 1)
        speed = float(np.median(travel))  # sustained speed, not jitter
        idx = np.clip(np.round(p[::3]).astype(int), 0, [w - 1, h - 1])
        fr = np.arange(start, start + len(p))[::3]
        col = frames[fr, idx[:, 1], idx[:, 0]].mean(0)
        norm = np.clip(p / np.array([w, h], np.float32), 0, 1).astype(np.float32)
        out.append(Track(int(start), norm, (int(col[0]), int(col[1]), int(col[2])), speed))
    out.sort(key=lambda tr: len(tr.points) * tr.speed, reverse=True)
    return out[:max_tracks]


def pack_tracks(tracks: list[Track]) -> dict[str, np.ndarray]:
    """Flat arrays for the .gvol: per-track start/length/colour/speed + concatenated points."""
    if not tracks:
        return {}
    lengths = np.array([len(tr.points) for tr in tracks], np.uint32)
    return {
        "track_start": np.array([tr.start for tr in tracks], np.uint32),
        "track_len": lengths,
        "track_color": np.array([tr.color for tr in tracks], np.uint8),
        "track_speed": np.array([tr.speed for tr in tracks], np.float32),
        "track_points": np.concatenate([tr.points for tr in tracks]).astype(np.float32),
    }


def match_to_truth(tracks: list[Track], centers: np.ndarray, w: int, h: int, radius: float = 35.0) -> dict:
    """Assign each track to the true mover it stays closest to; report coverage and velocity error.
    KLT follows a corner on the object, not its centre, so accuracy is judged on displacement.
    radius: the synthetic movers are up to 40 px tall, so edge corners sit 20-34 px from the centre
    (measured); 35 px = largest semi-axis + 15 px."""
    n_obj, _, _ = centers.shape
    matched = np.zeros(n_obj, bool)
    vel_err, disp_err = [], []
    unmatched = 0
    for tr in tracks:
        p = tr.points * np.array([w, h], np.float32)
        span = slice(tr.start, tr.start + len(p))
        c = centers[:, span]  # (N, n, 2)
        d = np.linalg.norm(c - p[None], axis=2)
        mean_d = np.nanmean(np.where(np.isnan(d), np.nan, d), axis=1)
        mean_d = np.where(np.isnan(mean_d), np.inf, mean_d)
        k = int(np.argmin(mean_d))
        if mean_d[k] > radius:
            unmatched += 1
            continue
        matched[k] = True
        ck = c[k]
        valid = ~np.isnan(ck).any(1)
        if valid.sum() < 3:
            continue
        dv = np.diff(p[valid], axis=0) - np.diff(ck[valid], axis=0)
        vel_err.extend(np.linalg.norm(dv, axis=1).tolist())
        disp_err.append(float(np.linalg.norm((p[valid][-1] - p[valid][0]) - (ck[valid][-1] - ck[valid][0]))))
    visible = (~np.isnan(centers).any(2)).sum(1) >= 20
    return {
        "tracks": len(tracks),
        "coverage": float(matched[visible].mean()) if visible.any() else 0.0,
        "unmatched_frac": unmatched / max(len(tracks), 1),
        "velocity_err_px_median": float(np.median(vel_err)) if vel_err else float("inf"),
        "displacement_err_px_median": float(np.median(disp_err)) if disp_err else float("inf"),
    }
