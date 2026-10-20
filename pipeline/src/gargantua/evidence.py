"""Evidence field A(x, y, t): how much each voxel belongs to something moving.

Fused cues
    background   temporal median, temporal MODE (most frequent quantised colour) and a sliding-window mode
    confidence   support = fraction of frames that agree with the chosen background colour
    motion       frame-difference energy min(|f_t - f_t-k|, |f_t - f_t+k|) and dense optical-flow magnitude
    blend        confident pixels use distance-from-background, unconfident pixels use motion
    flicker      brightness change that optical flow cannot explain (animated screens, emissive signs)
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

CHUNK = 16384  # pixels per chunk for the per-pixel temporal statistics


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _flat(frames: np.ndarray) -> np.ndarray:
    t, h, w, c = frames.shape
    return frames.reshape(t, h * w, c)


# ------------------------------------------------------------------------------------------- backgrounds
def bg_median(frames: np.ndarray) -> np.ndarray:
    _, h, w, c = frames.shape
    flat = _flat(frames)
    out = np.empty((h * w, c), np.uint8)
    for s in range(0, h * w, CHUNK):
        out[s : s + CHUNK] = np.round(np.median(flat[:, s : s + CHUNK], axis=0)).astype(np.uint8)
    return out.reshape(h, w, c)


def _mode_codes(codes: np.ndarray, weights: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Per column of codes (T, n): the value with the largest total weight (count when weights is None),
    via a sort and run sums in sorted order."""
    t, n = codes.shape
    if weights is None:
        s = np.sort(codes, axis=0)
        w = None
    else:
        order = np.argsort(codes, axis=0, kind="stable")
        s = np.take_along_axis(codes, order, 0)
        w = np.take_along_axis(weights, order, 0).astype(np.int32)
    start = np.ones_like(s, dtype=bool)
    start[1:] = s[1:] != s[:-1]
    idx = np.arange(t, dtype=np.int32)[:, None]
    run_start = np.maximum.accumulate(np.where(start, idx, 0), axis=0)
    if w is None:
        score = idx - run_start + 1
    else:
        cw = np.cumsum(w, axis=0)
        before = np.take_along_axis(cw, np.maximum(run_start - 1, 0), 0)
        score = cw - np.where(run_start > 0, before, 0)
    end = score.argmax(axis=0)
    cols = np.arange(n)
    return s[end, cols], score[end, cols]


def _run_position_weights(code: np.ndarray, cap: int) -> np.ndarray:
    """1 for the first `cap` frames of every temporal run of identical codes, else 0: a colour then
    scores by how many separate visits it gets, not by one long dwell."""
    t = code.shape[0]
    start = np.ones_like(code, dtype=bool)
    start[1:] = code[1:] != code[:-1]
    idx = np.arange(t, dtype=np.int32)[:, None]
    run_start = np.maximum.accumulate(np.where(start, idx, 0), axis=0)
    return (idx - run_start) < cap


def bg_mode(frames: np.ndarray, levels: int = 16, run_cap: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Temporal mode of quantised colour. Two grids offset by half a bin avoid splitting a colour that
    sits on a bin edge; the winning bin is refined to the mean of the frames that fell in it.
    run_cap: count at most this many frames per temporal run (visits instead of dwell time).
    Returns (background (H, W, 3) uint8, support (H, W) float32 in [0, 1])."""
    t, h, w, c = frames.shape
    step = 256 // levels
    flat = _flat(frames)
    bg = np.empty((h * w, c), np.uint8)
    support = np.empty(h * w, np.float32)
    for s in range(0, h * w, CHUNK):
        x = flat[:, s : s + CHUNK].astype(np.int16)
        best_code = best_count = best_grid = None
        grids = []
        for off in (0, step // 2):
            q = np.minimum((x + off) // step, levels - 1).astype(np.uint16)
            code = (q[..., 0] * levels + q[..., 1]) * levels + q[..., 2]
            grids.append(code)
            m, cnt = _mode_codes(code, _run_position_weights(code, run_cap) if run_cap else None)
            if best_count is None:
                best_code, best_count, best_grid = m, cnt, np.zeros_like(cnt)
            else:
                better = cnt > best_count
                best_code = np.where(better, m, best_code)
                best_count = np.where(better, cnt, best_count)
                best_grid = np.where(better, 1, best_grid)
        member = np.where(best_grid[None, :] == 0, grids[0] == best_code[None, :], grids[1] == best_code[None, :])
        cnt = member.sum(0, keepdims=True).astype(np.float32)
        mean = (x.astype(np.int32) * member[..., None]).sum(0) / np.maximum(cnt.T, 1)
        bg[s : s + CHUNK] = np.clip(np.round(mean), 0, 255).astype(np.uint8)
        support[s : s + CHUNK] = cnt.ravel() / t
    return bg.reshape(h, w, c), support.reshape(h, w)


def support_of(frames: np.ndarray, bg: np.ndarray, tol: int = 14) -> np.ndarray:
    """Fraction of frames whose colour is within tol (max channel difference) of bg, per pixel."""
    return support_visits(frames, bg, tol)[0]


def support_visits(frames: np.ndarray, bg: np.ndarray, tol: int = 14) -> tuple[np.ndarray, np.ndarray]:
    """(support, visits): fraction of frames within tol of bg, and the number of separate temporal
    runs in which the pixel matches bg."""
    _, h, w, c = frames.shape
    flat = _flat(frames)
    b = bg.reshape(h * w, c).astype(np.int16)
    sup = np.empty(h * w, np.float32)
    vis = np.empty(h * w, np.int32)
    for s in range(0, h * w, CHUNK):
        m = np.abs(flat[:, s : s + CHUNK].astype(np.int16) - b[None, s : s + CHUNK]).max(-1) <= tol
        sup[s : s + CHUNK] = m.mean(0)
        vis[s : s + CHUNK] = m[0].astype(np.int32) + (m[1:] & ~m[:-1]).sum(0)
    return sup.reshape(h, w), vis.reshape(h, w)


HYBRID_CANDIDATES = ("median", "mode", "mode_capped")


def bg_hybrid(frames: np.ndarray, tol: int = 14, run_cap: int = 8, visit_target: int = 4, min_support: float = 0.12
              ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per pixel, pick among median, mode and run-capped mode the colour with the best
    support x min(visits, visit_target) / visit_target. Background tends to recur in many separate
    gaps between passers-by; a single slow passer-by is one long visit. Where even the winner is
    seen in fewer than min_support of the frames nothing is reliable and the median is kept.
    Measured operating range (docs/BENCH.md): far better than the median when the background is
    visible 15-50% of the time, worse than the median below ~10%.
    Returns (background, support of the chosen colour, choice index into HYBRID_CANDIDATES)."""
    cands = [bg_median(frames), bg_mode(frames)[0], bg_mode(frames, run_cap=run_cap)[0]]
    scores, sups = [], []
    for c in cands:
        sup, vis = support_visits(frames, c, tol)
        sups.append(sup)
        scores.append(sup * np.minimum(vis, visit_target) / visit_target)
    choice = np.argmax(np.stack(scores), axis=0).astype(np.uint8)
    choice[np.choose(choice, sups) < min_support] = 0
    bg = np.choose(choice[..., None], cands)
    support = np.choose(choice, sups)
    return bg.astype(np.uint8), support.astype(np.float32), choice


def bg_sliding(frames: np.ndarray, fps: float, window_s: float = 3.0, hop_s: float = 1.0) -> np.ndarray:
    """Mode background in sliding windows, linearly interpolated per frame. (T, H, W, 3) uint8."""
    t = frames.shape[0]
    win = max(3, int(round(window_s * fps)))
    hop = max(1, int(round(hop_s * fps)))
    centers = list(range(0, t, hop))
    if centers[-1] != t - 1:
        centers.append(t - 1)
    bgs = []
    for c in centers:
        a, b = max(0, c - win // 2), min(t, c + win // 2 + 1)
        bgs.append(bg_mode(frames[a:b])[0].astype(np.float32))
    out = np.empty_like(frames)
    for i in range(t):
        k = np.searchsorted(centers, i, side="right") - 1
        k = min(k, len(centers) - 2) if len(centers) > 1 else 0
        if len(centers) == 1:
            out[i] = bgs[0]
            continue
        c0, c1 = centers[k], centers[k + 1]
        f = (i - c0) / max(c1 - c0, 1)
        out[i] = np.clip(np.round((1 - f) * bgs[k] + f * bgs[k + 1]), 0, 255).astype(np.uint8)
    return out


# ------------------------------------------------------------------------------------------- motion
def motion_energy(frames: np.ndarray, k: int = 2) -> np.ndarray:
    """min(|f_t - f_t-k|, |f_t - f_t+k|), max over channels. (T, H, W) uint8. The min suppresses the
    ghost a mover leaves at its old position."""
    t = frames.shape[0]
    out = np.empty(frames.shape[:3], np.uint8)
    for i in range(t):
        f = frames[i].astype(np.int16)
        ds = []
        if i - k >= 0:
            ds.append(np.abs(f - frames[i - k]).max(-1))
        if i + k < t:
            ds.append(np.abs(f - frames[i + k]).max(-1))
        out[i] = np.minimum.reduce(ds).astype(np.uint8) if ds else 0
    return out


@dataclass
class FlowResult:
    mag: np.ndarray  # (T, h, w) float16, full-resolution pixels per frame
    unexplained: np.ndarray  # (h, w) float32: share of the blurred-luma change NOT accompanied by steady motion
    region_std: np.ndarray  # (h, w) float32: temporal std of blurred luma after removing global exposure gain
    luma_peak: np.ndarray  # (h, w) float32: mean + 1.5 std of luma over time (a streaming stand-in for p95)
    scale: float

    def mag_full(self, i: int, size: tuple[int, int]) -> np.ndarray:
        return cv2.resize(self.mag[i].astype(np.float32), size, interpolation=cv2.INTER_LINEAR)


def _gray(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def flow_magnitude(frames: np.ndarray, max_width: int = 480) -> FlowResult:
    """Farneback flow between consecutive frames at reduced resolution, plus the per-pixel statistics the
    flicker detector uses. Streaming: memory does not grow with the clip beyond the flow magnitudes."""
    t, h, w, _ = frames.shape
    scale = min(1.0, max_width / w)
    sw, sh = max(8, int(round(w * scale))), max(8, int(round(h * scale)))
    grays = [cv2.resize(_gray(f), (sw, sh), interpolation=cv2.INTER_AREA) for f in frames]
    sigma = 3.0 * sw / 480
    blur = lambda g: cv2.GaussianBlur(g.astype(np.float32), (0, 0), sigma)  # noqa: E731
    # reference for the exposure gain: the temporal median of a few blurred frames; a frame's gain is the
    # median ratio to it over all pixels, which ignores anything covering under half the frame (crowds,
    # screens) but follows auto-exposure and lighting changes that move every pixel together
    ref = np.median(np.stack([blur(grays[i])[::4, ::4] for i in np.linspace(0, t - 1, min(t, 25)).astype(int)]), axis=0) + 8.0
    mag = np.zeros((t, sh, sw), np.float16)
    l1 = np.zeros((sh, sw), np.float64)
    l2 = np.zeros((sh, sw), np.float64)
    b1 = np.zeros((sh, sw), np.float64)
    b2 = np.zeros((sh, sw), np.float64)
    explained = np.zeros((sh, sw), np.float32)
    total = np.zeros((sh, sw), np.float32)
    prev = prev_b = None
    for i in range(t):
        g = grays[i].astype(np.float32)
        l1 += g
        l2 += g * g
        bi = blur(grays[i])
        bi /= float(np.median((bi[::4, ::4] + 8.0) / ref))
        b1 += bi
        b2 += bi * bi
        if i == 0:
            prev_b = bi
            continue
        fl = cv2.calcOpticalFlowFarneback(grays[i - 1], grays[i], None, 0.5, 3, 15, 3, 5, 1.2, 0)
        m = np.hypot(fl[..., 0], fl[..., 1])
        mag[i] = m / scale
        if i == 1:
            mag[0] = mag[1]
        if prev is not None:
            # a walker changes the brightness WHILE it moves steadily (two consecutive flows agree and are
            # not tiny); a screen changes it with no flow (fades, cuts) or erratic flow (new content)
            m0 = np.hypot(prev[..., 0], prev[..., 1])
            coh = np.hypot(fl[..., 0] + prev[..., 0], fl[..., 1] + prev[..., 1]) / (m + m0 + 1e-3)
            steady = np.clip((coh - 0.6) / 0.3, 0, 1) * np.clip((np.minimum(m, m0) - 0.3) / 0.7, 0, 1)
            db = np.abs(bi - prev_b)
            explained += db * steady
            total += db
        prev, prev_b = fl, bi
    unexplained = (1.0 - explained / (total + 1e-3)).astype(np.float32)
    std = lambda s1, s2: np.sqrt(np.maximum(s2 / t - (s1 / t) ** 2, 0)).astype(np.float32)  # noqa: E731
    luma_peak = (l1 / t + 1.5 * std(l1, l2)).astype(np.float32)
    return FlowResult(mag, unexplained, std(b1, b2), luma_peak, scale)


def flicker_mask(frames: np.ndarray, flow: FlowResult) -> np.ndarray:
    """Animated screens and signs: regions whose overall brightness keeps changing without steady motion
    to account for it, in the bright end of the frame. (H, W) float32 in [0, 1].

    Measured (tools/bench/flicker_regions.py): on the user's night clip the screens leave 0.84-0.96 of
    their change unexplained by steady motion and the crowd 0.22; synthetic screens 0.78, synthetic crowds
    0.03-0.66. An earlier cue (warp residual / change) held on synthetic screens but not on real ones:
    Farneback partly explains changing screen content, so real screens scored like crowds."""
    _, h, w, _ = frames.shape
    change = _smoothstep(10.0, 18.0, flow.region_std)
    # dense occluding crowds also leave 0.5-0.8 unexplained (synthetic crowd_grows, the user's crowd on the
    # bright crossing stripes), but stay near the frame's typical brightness; screens emit well above it
    erratic = _smoothstep(0.74, 0.86, flow.unexplained)
    p50, p75 = np.percentile(flow.luma_peak, [50, 75])
    rel = (flow.luma_peak - p50) / max(p75 - p50, 10.0)
    sw = flow.region_std.shape[1]
    k_open = max(3, int(round(5 * sw / 480)) | 1)
    min_area = 0.002 * flow.region_std.size

    def gated(*maps: np.ndarray) -> np.ndarray:
        return (cv2.GaussianBlur(np.prod(maps, axis=0).astype(np.float32), (0, 0), 2.0) > 0.35).astype(np.uint8)

    # hysteresis: strict gates decide WHETHER a region is a screen (seeds), relaxed gates how far it extends;
    # scrolling text inside a screen is real steady motion and would otherwise punch holes in it
    strong = cv2.morphologyEx(gated(change, erratic, _smoothstep(1.0, 2.0, rel)), cv2.MORPH_OPEN, np.ones((k_open, k_open), np.uint8))
    weak = gated(change, _smoothstep(0.55, 0.70, flow.unexplained), _smoothstep(0.5, 1.5, rel)) | strong
    weak = cv2.morphologyEx(weak, cv2.MORPH_OPEN, np.ones((k_open, k_open), np.uint8))
    weak = cv2.morphologyEx(weak, cv2.MORPH_CLOSE, np.ones((k_open * 3, k_open * 3), np.uint8))
    # a seed is ONE solid strict component: scattered strict pixels in a dense crowd add up, a screen is whole
    n_s, lab_s, stats_s, _ = cv2.connectedComponentsWithStats(strong, 8)
    seeds = np.isin(lab_s, [k for k in range(1, n_s) if stats_s[k, cv2.CC_STAT_AREA] >= min_area])
    n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(weak, 8)
    seeded = set(np.unique(lab[seeds]).tolist()) - {0}
    keep = np.zeros_like(weak)
    for k in range(1, n_lab):
        if k in seeded and stats[k, cv2.CC_STAT_AREA] >= min_area:
            # screens are convex quadrilaterals (also in perspective): the hull restores the edges and
            # holes that the blur/opening eroded
            cnts, _ = cv2.findContours((lab == k).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.fillPoly(keep, [cv2.convexHull(np.vstack(cnts))], 1)
    full = cv2.resize(keep.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    return np.clip(cv2.GaussianBlur(full, (0, 0), 1.5), 0, 1)


# ------------------------------------------------------------------------------------------- fusion
def _shifted(bg: np.ndarray, r: int) -> list[np.ndarray]:
    h, w = bg.shape[:2]
    pad = np.pad(bg, ((r, r), (r, r), (0, 0)), mode="edge")
    return [pad[r + dy : r + dy + h, r + dx : r + dx + w] for dy in range(-r, r + 1) for dx in range(-r, r + 1)]


def _tolerant_distance(f: np.ndarray, shifts: list[np.ndarray]) -> np.ndarray:
    """Distance to the best-matching background pixel within +/- r px: residual stabilisation error and
    lens wobble move sharp static edges by a pixel or so, which must not read as motion."""
    d = np.abs(f - shifts[0]).max(-1)
    for s in shifts[1:]:
        np.minimum(d, np.abs(f - s).max(-1), out=d)
    return d.astype(np.float32)


def evidence_field(
    frames: np.ndarray,
    bg: np.ndarray,
    support: np.ndarray,
    energy: np.ndarray,
    flow: FlowResult | None,
    flicker: np.ndarray | None,
    sliding: np.ndarray | None = None,
    tol_px: int = 1,
) -> np.ndarray:
    """A(x, y, t) as (T, H, W) uint8. High-confidence pixels: distance from the background (global, or
    the sliding-window background where that is closer). Low-confidence pixels: motion energy and flow.
    `flicker` is stored separately and applied in the viewer (keep / scenery / suppress), so it is not
    folded in here."""
    t, h, w, _ = frames.shape
    conf = _smoothstep(0.30, 0.65, support.astype(np.float32))
    shifts = _shifted(bg.astype(np.int16), tol_px)
    out = np.empty((t, h, w), np.uint8)
    for i in range(t):
        f = frames[i].astype(np.int16)
        d = _tolerant_distance(f, shifts)
        if sliding is not None:
            sl = sliding[i]
            if sl.shape[:2] != (h, w):  # sliding background may be computed at reduced resolution
                sl = cv2.resize(sl, (w, h), interpolation=cv2.INTER_LINEAR)
            d = np.minimum(d, np.abs(f - sl.astype(np.int16)).max(-1))
        a_bg = _smoothstep(14.0, 45.0, d)
        a_mot = _smoothstep(8.0, 32.0, energy[i].astype(np.float32))
        if flow is not None:
            # slow walkers in a dense crowd move 0.5-2 px/frame; 0.3-1.2 doubles crowd recall on the bench
            # (0.42 -> ~0.8) without touching sparse scenes, while staying above real-footage flow noise
            a_mot = np.maximum(a_mot, _smoothstep(0.3, 1.2, flow.mag_full(i, (w, h))))
        a = conf * a_bg + (1 - conf) * a_mot
        out[i] = np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return out
