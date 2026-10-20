// Hooks for headless automation (Playwright): deterministic export frames, perf probes, fixed-pose snapshots.
import type { App } from "../main.ts";
import type { CamKey } from "../director/Director.ts";
import type { Params } from "../app/state.ts";

export interface PerfResult {
  quality: "interactive" | "idle";
  width: number;
  height: number;
  frames: number;
  wallMsMedian: number; // CPU+GPU per frame, synchronised by a 1-pixel readPixels (gl.finish does not block in Chrome)
  wallMsP95: number;
  gpuVolumeMsMedian: number; // timer query around the volume pass
  fpsFromWall: number;
  vramEstimateMB: number;
  plausible: boolean; // a 1080p ray-march under 1 ms means the measurement itself is broken
  timerAgrees: boolean; // GPU timer within 0.3x-1.5x of the synchronised wall time
}

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
function p95(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
}

export function installAutomation(app: App) {
  const gl = () => app.renderer.getContext() as WebGL2RenderingContext;
  const ready = async () => {
    for (let i = 0; i < 600 && !app.layer; i++) await new Promise((r) => setTimeout(r, 100));
    if (!app.layer) throw new Error("no volume loaded");
  };

  /** Displayed sRGB luma statistics of the cube pixels (luma > thresh) currently on the canvas. */
  const readStats = (thresh: number) => {
    const g = gl();
    const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    const hist = new Float64Array(256);
    let s = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      if (l > thresh) { s += l; n++; hist[Math.min(255, Math.round(l))]++; }
    }
    let acc = 0, median = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { median = v; break; } }
    return { mean: n ? s / n : 0, median, frac: n / (w * h) };
  };

  const api = {
    ready,
    pause(on = true) {
      app.paused = on;
    },
    setSize(w: number, h: number) {
      app.fixedSize = [w, h];
      app.resize();
    },
    directorDuration: () => app.director?.duration ?? 0,
    set(patch: Partial<Params>) {
      app.store.set(patch, "automation");
    },
    /** Render frame i of the reel sequence at `fps`, accumulate `samples` jittered passes, read it back and
     * POST the raw RGBA (bottom-up rows) to `sink`. Deterministic: noise, grain and jitter are seeded by i. */
    async renderFrame(i: number, fps: number, samples: number, sink: string, timeScale = 1) {
      app.paused = true;
      app.store.set({ directorPlaying: false, playing: false }, "automation");
      app.frameIndex = i;
      app.applyDirector(i / fps / timeScale); // timeScale > 1 stretches the sequence (slower camera, same choreography)
      app.camera.updateMatrixWorld();
      app.pipeline.resetAccumulation();
      app.dirtyOverlay = true;
      for (let s = 0; s < samples; s++) app.renderFrame(false, samples, s === samples - 1); // composite once
      const g = gl();
      const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
      const r = await fetch(`${sink}?i=${i}&w=${w}&h=${h}`, { method: "POST", body: px });
      if (!r.ok) throw new Error(`frame sink refused frame ${i}: ${r.status}`);
      return { w, h };
    },
    /** Render a fixed camera + parameter set, fully refined; returns a PNG data URL (contact sheets). */
    async snapshot(cam: CamKey, patch: Partial<Params>, samples = 48): Promise<string> {
      app.paused = true;
      app.store.set({ directorPlaying: false, playing: false, ...patch }, "automation");
      app.tween = null;
      app.applyCam(cam);
      app.camera.updateMatrixWorld();
      app.pipeline.resetAccumulation();
      app.dirtyOverlay = true;
      for (let s = 0; s < samples; s++) app.renderFrame(false, samples);
      return app.renderer.domElement.toDataURL("image/png");
    },
    /** Render a fixed view fully refined and return the mean displayed sRGB luma (0-255) per grid cell. */
    async lumaGrid(cam: CamKey, patch: Partial<Params>, samples = 32, gw = 96, gh = 54): Promise<number[]> {
      app.paused = true;
      app.store.set({ directorPlaying: false, playing: false, ...patch }, "automation");
      app.tween = null;
      app.applyCam(cam);
      app.camera.updateMatrixWorld();
      app.pipeline.resetAccumulation();
      app.dirtyOverlay = true;
      for (let s = 0; s < samples; s++) app.renderFrame(false, samples);
      const g = gl();
      const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
      const sum = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
      for (let y = 0; y < h; y++) {
        const gy = Math.min(gh - 1, Math.floor(((h - 1 - y) / h) * gh)); // readPixels rows are bottom-up
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const k = gy * gw + Math.min(gw - 1, Math.floor((x / w) * gw));
          sum[k] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          cnt[k]++;
        }
      }
      return Array.from(sum, (s, k) => s / Math.max(cnt[k], 1));
    },
    /** Render the reel sequence's state at time t (camera + tau + guides) plus `patch`; PNG data URL. */
    async directorSnapshot(t: number, patch: Partial<Params> = {}, samples = 32): Promise<string> {
      app.paused = true;
      app.store.set({ directorPlaying: false, playing: false }, "automation");
      app.tween = null;
      app.applyDirector(t);
      app.store.set(patch, "automation");
      app.camera.updateMatrixWorld();
      app.pipeline.resetAccumulation();
      app.dirtyOverlay = true;
      for (let s = 0; s < samples; s++) app.renderFrame(false, samples, s === samples - 1);
      return app.renderer.domElement.toDataURL("image/png");
    },
    /** Mean displayed sRGB luma of the cube pixels (luma > thresh) at director time t, and their frame share. */
    async directorLuma(t: number, patch: Partial<Params> = {}, samples = 24, thresh = 12) {
      await api.directorSnapshot(t, patch, samples);
      // the snapshot's composite was presented after the await: composite again so the pixels can be read back
      app.pipeline.composite(app.overlayScene, app.camera, { moving: false, maxAccum: samples, bloom: app.store.params.bloom,
        exposure: app.store.params.exposure, vignette: app.store.params.vignette, grain: app.store.params.grain, frameIndex: app.frameIndex }, null, app.worldlineScene);
      return readStats(thresh);
    },
    /** Same statistics for an explicit camera (e.g. the head-on "front" preset). */
    async viewLuma(cam: CamKey, patch: Partial<Params> = {}, samples = 24, thresh = 12) {
      await api.snapshot(cam, patch, samples);
      app.pipeline.composite(app.overlayScene, app.camera, { moving: false, maxAccum: samples, bloom: app.store.params.bloom,
        exposure: app.store.params.exposure, vignette: app.store.params.vignette, grain: app.store.params.grain, frameIndex: app.frameIndex }, null, app.worldlineScene);
      return readStats(thresh);
    },
    directorCam: (t: number) => app.director?.evaluate(t).cam ?? null,
    presetCam: (name: string) => app.presetCam(name),
    box: () => app.box,
    /** Orbit the camera for `frames` frames at a fixed quality and time every frame (gl.finish => vsync-free). */
    async perf(quality: "interactive" | "idle", frames = 180, patch: Partial<Params> = {}): Promise<PerfResult> {
      app.paused = true;
      await ready();
      app.store.set({ directorPlaying: false, playing: false, ...patch }, "automation");
      const g = gl();
      const base = app.presetCam("reel");
      const wall: number[] = [];
      const px = new Uint8Array(4);
      app.pipeline.timer.samples.length = 0;
      app.stepScaleOverride = quality === "interactive" ? 2 : 1;
      for (let f = 0; f < frames + 10; f++) {
        app.applyCam({ ...base, az: base.az + (f * 360) / frames, el: base.el + 10 * Math.sin(f / 20) });
        app.camera.updateMatrixWorld();
        app.pipeline.resetAccumulation();
        app.dirtyOverlay = true;
        const t0 = performance.now();
        // interactive = what the user sees while orbiting; idle = full-resolution, full-step pass
        app.renderFrame(quality === "interactive", 1);
        g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); // synchronous: waits for the GPU (finish() does not)
        if (f >= 10) wall.push(performance.now() - t0);
        if (f % 10 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      for (let k = 0; k < 20; k++) {
        app.pipeline.timer.poll();
        await new Promise((r) => setTimeout(r, 20));
      }
      app.stepScaleOverride = null;
      const wm = median(wall);
      const gm = median(app.pipeline.timer.samples);
      return {
        quality,
        width: g.drawingBufferWidth,
        height: g.drawingBufferHeight,
        frames,
        wallMsMedian: wm,
        wallMsP95: p95(wall),
        gpuVolumeMsMedian: gm,
        fpsFromWall: 1000 / wm,
        vramEstimateMB: app.vramMB(),
        plausible: wm >= 1.0,
        timerAgrees: gm > 0.3 * wm && gm < 1.5 * wm,
      };
    },
  };
  (window as unknown as { __gargantua: typeof api }).__gargantua = api;
  const qs = new URLSearchParams(location.search);
  if (qs.has("w") && qs.has("h")) api.setSize(Number(qs.get("w")), Number(qs.get("h")));
}
