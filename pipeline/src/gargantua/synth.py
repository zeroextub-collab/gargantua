"""Synthetic clips with exact ground truth, for tests and the Gargantua Bench.

Every scene returns frames (T, H, W, 3) uint8 RGB plus a truth dict:
    background  (H, W, 3) uint8   true static background in frame coordinates (static-camera scenes)
    masks       (T, H, W) bool    true mover pixels
    centers     (N, T, 2) float32 mover centres in frame pixels (nan when off screen)
    cam         (T, 2, 3) float32 affine mapping world -> frame for each frame
    screens     (H, W) bool       flicker/emissive regions (flicker scene only)
    meta        dict              scene parameters
Scenes are deterministic for a given seed.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

W0, H0, FPS = 640, 360, 30.0


def _texture(h: int, w: int, rng: np.random.Generator, base=(118, 116, 110)) -> np.ndarray:
    """Static, feature-rich background: soft noise + rectangles + lines (corners for KLT)."""
    img = np.empty((h, w, 3), np.float32)
    img[:] = base
    for sigma, amp in ((40, 22), (10, 12), (2, 6)):
        n = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), sigma)
        n /= n.std() + 1e-6
        img += amp * n[..., None]
    for _ in range((h * w) // 9000):
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        c = tuple(float(v) for v in rng.integers(40, 220, 3))
        cv2.rectangle(img, (x, y), (x + int(rng.integers(6, 40)), y + int(rng.integers(6, 40))), c, -1)
    for _ in range((h * w) // 20000):
        p1 = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        p2 = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        cv2.line(img, p1, p2, tuple(float(v) for v in rng.integers(30, 230, 3)), 2, cv2.LINE_AA)
    return np.clip(img, 0, 255).astype(np.uint8)


def _crossing(h: int, w: int, rng: np.random.Generator) -> np.ndarray:
    """Overhead crossing: warm asphalt, zebra stripes, kerb lines (the reel-like scene)."""
    img = np.empty((h, w, 3), np.float32)
    img[:] = (128, 124, 118)
    n = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 1.2)
    img += 7 * n[..., None]
    stripe_w, gap = max(6, w // 48), max(6, w // 48)
    band_top, band_bot = int(h * 0.30), int(h * 0.72)
    x = int(w * 0.06)
    while x < w * 0.94:
        cv2.rectangle(img, (x, band_top), (x + stripe_w, band_bot), (232, 230, 224), -1)
        x += stripe_w + gap
    cv2.rectangle(img, (0, int(h * 0.12)), (w, int(h * 0.14)), (220, 214, 200), -1)
    cv2.rectangle(img, (0, int(h * 0.88)), (w, int(h * 0.90)), (220, 214, 200), -1)
    cv2.putText(img, "STOP", (int(w * 0.68), int(h * 0.84)), cv2.FONT_HERSHEY_SIMPLEX, h / 260, (230, 228, 220), max(2, h // 120))
    return np.clip(img, 0, 255).astype(np.uint8)


def _blob_colors(n: int, rng: np.random.Generator, dark: bool) -> list[tuple[int, int, int]]:
    out = []
    for _ in range(n):
        if dark:
            v = int(rng.integers(25, 55))
            out.append((v + int(rng.integers(-6, 6)), v, v + int(rng.integers(-6, 6))))
        else:
            hsv = np.uint8([[[rng.integers(0, 180), rng.integers(120, 255), rng.integers(80, 240)]]])
            out.append(tuple(int(c) for c in cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)[0, 0]))
    return out


def _draw_blob(img, mask, c, axes, color, angle=0.0):
    cx, cy = c
    cv2.ellipse(img, (int(round(cx)), int(round(cy))), axes, angle, 0, 360, color, -1, cv2.LINE_AA)
    # two-tone detail gives KLT something to lock on to
    dark = tuple(int(v * 0.45) for v in color)
    cv2.ellipse(img, (int(round(cx)), int(round(cy - axes[1] * 0.35))), (max(2, axes[0] // 2), max(2, axes[1] // 3)), angle, 0, 360,
                dark, -1, cv2.LINE_AA)
    if mask is not None:
        cv2.ellipse(mask, (int(round(cx)), int(round(cy))), axes, angle, 0, 360, 1, -1)


def _render(world_bg, movers, cam, size, shadow=False, screens=None, rng=None):
    """movers: list of (positions (T,2) in world px, axes, color). cam: (T,2,3) world->frame."""
    w, h = size
    T = len(cam)
    frames = np.empty((T, h, w, 3), np.uint8)
    masks = np.zeros((T, h, w), bool)
    centers = np.full((len(movers), T, 2), np.nan, np.float32)
    for t in range(T):
        world = world_bg.copy()
        wmask = np.zeros(world.shape[:2], np.uint8)
        if shadow:  # all soft shadows in one layer, blended once
            sh = np.zeros(world.shape[:2], np.uint8)
            for pos, axes, _ in movers:
                p = pos[t]
                if not np.isnan(p).any():
                    cv2.ellipse(sh, (int(p[0] + axes[0] * 0.8), int(p[1] + axes[1] * 0.5)), axes, 0, 0, 360, 255, -1, cv2.LINE_AA)
            k = cv2.GaussianBlur(sh, (0, 0), 1.5).astype(np.float32)[..., None] / 255.0 * 0.45
            world = (world * (1 - k) + np.array([60, 58, 56], np.float32) * k).astype(np.uint8)
        for i, (pos, axes, color) in enumerate(movers):
            p = pos[t]
            if np.isnan(p).any():
                continue
            _draw_blob(world, wmask, p, axes, color)
            fp = cam[t] @ np.array([p[0], p[1], 1.0])
            if 0 <= fp[0] < w and 0 <= fp[1] < h:
                centers[i, t] = fp
        if screens is not None:
            screens(world, t)
        frames[t] = cv2.warpAffine(world, cam[t], (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        masks[t] = cv2.warpAffine(wmask, cam[t], (w, h), flags=cv2.INTER_NEAREST) > 0
    return frames, masks, centers


def _linear_paths(n, T, rng, region, speed=(0.8, 2.5), wobble=0.0):
    x0, y0, x1, y1 = region
    paths = []
    for _ in range(n):
        start = np.array([rng.uniform(x0, x1), rng.uniform(y0, y1)])
        ang = rng.uniform(0, 2 * math.pi)
        v = rng.uniform(*speed) * np.array([math.cos(ang), math.sin(ang)])
        t = np.arange(T)[:, None]
        p = start + v * t
        if wobble:
            p[:, 1] += wobble * np.sin(t[:, 0] / rng.uniform(8, 20) + rng.uniform(0, 6))
        # bounce inside the region
        for k, (lo, hi) in enumerate(((x0, x1), (y0, y1))):
            span = hi - lo
            q = (p[:, k] - lo) % (2 * span)
            p[:, k] = lo + np.where(q > span, 2 * span - q, q)
        paths.append(p.astype(np.float32))
    return paths


def _static_cam(T, margin=0):
    cam = np.zeros((T, 2, 3), np.float32)
    cam[:, 0, 0] = cam[:, 1, 1] = 1
    cam[:, 0, 2] = cam[:, 1, 2] = -margin
    return cam


def sparse_blobs(seed=1, T=180, size=(W0, H0)):
    rng = np.random.default_rng(seed)
    w, h = size
    bg = _texture(h, w, rng)
    paths = _linear_paths(6, T, rng, (40, 40, w - 40, h - 40), wobble=6)
    cols = _blob_colors(6, rng, dark=False)
    movers = [(p, (12, 20), c) for p, c in zip(paths, cols, strict=True)]
    cam = _static_cam(T)
    frames, masks, centers = _render(bg, movers, cam, size)
    return frames, {"background": bg, "masks": masks, "centers": centers, "cam": cam, "meta": {"scene": "sparse_blobs", "fps": FPS}}


def dense_crowd(seed=2, T=240, size=(W0, H0), dark=False, n=230):
    """Crowd band in the lower 60%: the background there is visible less than half the time."""
    rng = np.random.default_rng(seed)
    w, h = size
    bg = _texture(h, w, rng, base=(96, 96, 100))
    band = (0, int(h * 0.4), w, h)
    paths = []
    for _ in range(n):
        y = rng.uniform(band[1] + 10, band[3] - 10)
        x = rng.uniform(0, w)
        v = rng.choice([-1, 1]) * rng.uniform(0.6, 2.0)
        p = np.stack([(x + v * np.arange(T)) % (w + 60) - 30, y + 3 * np.sin(np.arange(T) / rng.uniform(6, 15))], 1)
        paths.append(p.astype(np.float32))
    cols = _blob_colors(n, rng, dark=dark)
    movers = [(p, (int(rng.integers(9, 15)), int(rng.integers(16, 26))), c) for p, c in zip(paths, cols, strict=True)]
    cam = _static_cam(T)
    frames, masks, centers = _render(bg, movers, cam, size)
    return frames, {"background": bg, "masks": masks, "centers": centers, "cam": cam,
                    "meta": {"scene": "dense_crowd_dark" if dark else "dense_crowd", "fps": FPS,
                             "bg_visible_frac_band": float(1 - masks[:, band[1]:].mean())}}


def flicker_screens(seed=3, T=180, size=(W0, H0)):
    rng = np.random.default_rng(seed)
    w, h = size
    bg = _texture(h, w, rng, base=(40, 40, 46))  # night
    rects = [(40, 30, 200, 110), (260, 20, 380, 90), (450, 40, 600, 150)]
    screen_mask = np.zeros((h, w), bool)
    for x0, y0, x1, y1 in rects:
        screen_mask[y0:y1, x0:x1] = True
    content = [rng.integers(30, 255, (T // 15 + 2, 3)) for _ in rects]

    def screens(img, t):
        for k, (x0, y0, x1, y1) in enumerate(rects):
            a, b = content[k][t // 15], content[k][t // 15 + 1]
            f = (t % 15) / 15.0 if k != 1 else 0.0  # screen 1 hard-cuts, the others fade
            col = (1 - f) * a + f * b
            img[y0:y1, x0:x1] = col
            # moving text-like bars inside the screen: content change without object motion
            yy = y0 + (t * 3 + k * 17) % max(1, (y1 - y0))
            img[yy:yy + 4, x0:x1] = 255 - col

    paths = _linear_paths(5, T, rng, (30, 180, w - 30, h - 30), wobble=4)
    cols = _blob_colors(5, rng, dark=False)
    movers = [(p, (11, 19), c) for p, c in zip(paths, cols, strict=True)]
    cam = _static_cam(T)
    frames, masks, centers = _render(bg, movers, cam, size, screens=screens)
    true_bg = bg.copy()
    return frames, {"background": true_bg, "masks": masks, "centers": centers, "cam": cam, "screens": screen_mask,
                    "meta": {"scene": "flicker_screens", "fps": FPS}}


def _moving_cam(T, margin, kind, rng):
    cam = np.zeros((T, 2, 3), np.float32)
    t = np.arange(T)
    if kind == "drift":
        tx = margin + 0.12 * t + 0.6 * np.sin(t / 37.0)
        ty = margin + 0.05 * t
        rot = np.radians(0.004 * t)
        sc = np.ones(T)
    elif kind == "pan":
        tx = margin + 2.2 * t
        ty = margin + 0.25 * t
        rot = np.zeros(T)
        sc = np.ones(T)
    else:
        raise ValueError(kind)
    c, s = np.cos(rot) * sc, np.sin(rot) * sc
    # frame = R * (world - offset): cam maps world -> frame
    cam[:, 0, 0], cam[:, 0, 1], cam[:, 1, 0], cam[:, 1, 1] = c, s, -s, c
    cam[:, 0, 2] = -(c * tx + s * ty)
    cam[:, 1, 2] = -(-s * tx + c * ty)
    return cam


def camera_scene(kind: str, seed=4, T=180, size=(W0, H0)):
    rng = np.random.default_rng(seed)
    w, h = size
    margin = 40
    world_w = w + 2 * margin + (int(2.4 * T) if kind == "pan" else 60)
    world_h = h + 2 * margin + (int(0.3 * T) if kind == "pan" else 40)
    bg = _texture(world_h, world_w, rng)
    cam = _moving_cam(T, margin, kind, rng)
    # movers live in world coordinates so they move with the scene
    paths = _linear_paths(6, T, rng, (margin + 40, margin + 40, world_w - margin - 40, world_h - margin - 40), wobble=5)
    cols = _blob_colors(6, rng, dark=False)
    movers = [(p, (12, 20), c) for p, c in zip(paths, cols, strict=True)]
    frames, masks, centers = _render(bg, movers, cam, size)
    return frames, {"masks": masks, "centers": centers, "cam": cam, "world": bg, "meta": {"scene": kind, "fps": FPS}}


def parallax_scene(seed=5, T=180, size=(W0, H0)):
    """Forward walk: near layer expands fast, far layer slowly, plus hand shake. No single homography fits."""
    rng = np.random.default_rng(seed)
    w, h = size
    far = _texture(h, w, rng, base=(150, 160, 175))
    near = _texture(h, w, rng, base=(110, 100, 90))
    near_mask = np.zeros((h, w), np.uint8)
    cv2.rectangle(near_mask, (0, 0), (int(w * 0.28), h), 1, -1)
    cv2.rectangle(near_mask, (int(w * 0.72), 0), (w, h), 1, -1)
    cv2.rectangle(near_mask, (0, int(h * 0.75)), (w, h), 1, -1)
    frames = np.empty((T, h, w, 3), np.uint8)
    cam = np.zeros((T, 2, 3), np.float32)
    for t in range(T):
        shake = np.array([2.5 * math.sin(t / 3.1) + rng.normal(0, 0.6), 2.0 * math.sin(t / 4.3 + 1) + rng.normal(0, 0.6)])
        s_far, s_near = 1 + 0.0012 * t, 1 + 0.006 * t
        def m(s, sh):
            return np.array([[s, 0, (1 - s) * w / 2 + sh[0]], [0, s, (1 - s) * h / 2 + sh[1]]], np.float32)
        f = cv2.warpAffine(far, m(s_far, shake * 0.4), (w, h), borderMode=cv2.BORDER_REFLECT)
        nr = cv2.warpAffine(near, m(s_near, shake), (w, h), borderMode=cv2.BORDER_REFLECT)
        nm = cv2.warpAffine(near_mask, m(s_near, shake), (w, h), flags=cv2.INTER_NEAREST).astype(bool)
        f[nm] = nr[nm]
        frames[t] = f
        cam[t] = m(s_far, shake * 0.4)
    return frames, {"cam": cam, "meta": {"scene": "parallax", "fps": FPS}}


def sparse_overhead(seed=6, T=240, size=(960, 540)):
    """Reel-like overhead crossing with a handful of walkers (one in red) and soft shadows."""
    rng = np.random.default_rng(seed)
    w, h = size
    bg = _crossing(h, w, rng)
    n = 9
    paths = []
    for _ in range(n):
        vertical = rng.random() < 0.6
        if vertical:
            x = rng.uniform(w * 0.1, w * 0.9)
            y0 = rng.uniform(-40, h * 0.2) if rng.random() < 0.5 else rng.uniform(h * 0.8, h + 40)
            v = (h * 0.9 / T) * (1 if y0 < h / 2 else -1) * rng.uniform(0.7, 1.2)
            p = np.stack([x + 6 * np.sin(np.arange(T) / 9.0), y0 + v * np.arange(T)], 1)
        else:
            y = rng.uniform(h * 0.3, h * 0.72)
            x0 = rng.uniform(-40, w * 0.1) if rng.random() < 0.5 else rng.uniform(w * 0.9, w + 40)
            v = (w * 0.8 / T) * (1 if x0 < w / 2 else -1) * rng.uniform(0.7, 1.2)
            p = np.stack([x0 + v * np.arange(T), y + 4 * np.sin(np.arange(T) / 7.0)], 1)
        paths.append(p.astype(np.float32))
    cols = _blob_colors(n, rng, dark=True)
    cols[0] = (200, 30, 36)  # the red coat
    movers = [(p, (9, 13), c) for p, c in zip(paths, cols, strict=True)]
    cam = _static_cam(T)
    frames, masks, centers = _render(bg, movers, cam, size, shadow=True)
    return frames, {"background": bg, "masks": masks, "centers": centers, "cam": cam,
                    "meta": {"scene": "sparse_overhead", "fps": FPS, "red_walker": 0}}


def crowd_grows(seed=7, T=240, size=(W0, H0)):
    """Like the user's night clip: the street starts nearly empty and a dark-clothed crowd fills the lower
    half over time, so the background is visible as one long early run and then rarely."""
    rng = np.random.default_rng(seed)
    w, h = size
    bg = _texture(h, w, rng, base=(70, 70, 76))
    band = (0, int(h * 0.45), w, h)
    n = 200
    paths = []
    for k in range(n):
        y = rng.uniform(band[1] + 10, band[3] - 10)
        x = rng.uniform(0, w)
        v = rng.choice([-1, 1]) * rng.uniform(0.5, 1.6)
        p = np.stack([(x + v * np.arange(T)) % (w + 60) - 30, y + 3 * np.sin(np.arange(T) / rng.uniform(6, 15))], 1).astype(np.float32)
        arrive = int(T * min(0.95, (k / n) ** 0.7 * 0.9))  # arrivals ramp up over the clip
        p[:arrive] = np.nan
        paths.append(p)
    cols = _blob_colors(n, rng, dark=True)
    movers = [(p, (int(rng.integers(9, 14)), int(rng.integers(16, 24))), c) for p, c in zip(paths, cols, strict=True)]
    cam = _static_cam(T)
    frames, masks, centers = _render(bg, movers, cam, size)
    return frames, {"background": bg, "masks": masks, "centers": centers, "cam": cam,
                    "meta": {"scene": "crowd_grows", "fps": FPS, "bg_visible_frac_band": float(1 - masks[:, band[1]:].mean())}}


SCENES = {
    "sparse_blobs": sparse_blobs,
    "dense_crowd": dense_crowd,
    "dense_crowd_dark": lambda **k: dense_crowd(dark=True, **k),
    "flicker_screens": flicker_screens,
    "drift": lambda **k: camera_scene("drift", **k),
    "pan": lambda **k: camera_scene("pan", **k),
    "parallax": parallax_scene,
    "sparse_overhead": sparse_overhead,
    "crowd_grows": crowd_grows,
}
