// In-browser fallback when no pipeline server is available (e.g. a static build): decode the video with an
// HTMLVideoElement, frame by frame via seeking, into an RGBA volume with no evidence field. REEL mode only.
import type { Gvol, GvolHeader } from "./gvol.ts";
import type { Progress } from "./loader.ts";

const MAX_AXIS = 2048;

export async function quickIngest(file: File, onProgress: Progress, start = 0, maxSeconds = 15, fps = 30): Promise<Gvol> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error(`the browser cannot decode ${file.name} (try the pipeline: npm run dev)`));
    });
    const t0 = Math.max(0, start);
    const dur = Math.min(maxSeconds, (video.duration || 0) - t0);
    if (!video.videoWidth || !(video.duration > 0)) throw new Error(`${file.name}: no decodable video track`);
    if (!(dur > 0)) throw new Error(`start ${t0.toFixed(2)}s is outside ${file.name} (duration ${video.duration.toFixed(2)}s)`);
    const aspect = video.videoWidth / video.videoHeight;
    const short = 360;
    let w = aspect >= 1 ? short * aspect : short;
    let h = aspect >= 1 ? short : short / aspect;
    const s = Math.min(1, MAX_AXIS / Math.max(w, h));
    w = Math.max(4, Math.round((w * s) / 4) * 4);
    h = Math.max(4, Math.round((h * s) / 4) * 4);
    const frames = Math.max(2, Math.floor(dur * fps));
    const vol = new Uint8Array(w * h * frames * 4);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((res) => {
        video.onseeked = () => res();
        video.currentTime = t0 + Math.min(dur - 1e-3, i / fps + 1e-3);
      });
      ctx.drawImage(video, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const off = i * w * h * 4;
      for (let p = 0; p < w * h; p++) {
        vol[off + p * 4] = px[p * 4];
        vol[off + p * 4 + 1] = px[p * 4 + 1];
        vol[off + p * 4 + 2] = px[p * 4 + 2];
        vol[off + p * 4 + 3] = 0;
      }
      if (i % 4 === 0) onProgress(i / frames, `decoding in the browser ${i}/${frames}`);
    }
    const header = {
      format: "gvol",
      version: 1,
      sections: { volume: { offset: 0, bytes: vol.byteLength, dtype: "u8", shape: [frames, h, w, 4] } },
      plan: { start: t0, duration: dur, fps, frames, width: w, height: h, tier: "browser", tonemap: false,
        notes: ["quick in-browser ingest (fixed 30 fps sampling, no evidence field, no worldlines)",
          ...(t0 > 0 || video.duration > maxSeconds + 1 / fps ? [`clip is ${video.duration.toFixed(2)}s; trimmed to ${t0.toFixed(2)}-${(t0 + dur).toFixed(2)}s`] : [])] },
      source: { path: file.name, display_width: video.videoWidth, display_height: video.videoHeight },
      analysis: { category: "unknown", tags: [], quality: { grade: "—", reasons: ["quick in-browser ingest: run the Python pipeline (npm run dev, then drop the clip) for the quality score, SEPARATED mode and worldlines"] }, camera: { class: "unknown" }, stats: {} },
      camera: { class: "unknown", reasons: [] },
      look: {},
    } as unknown as GvolHeader;
    return { header, buffer: vol.buffer, section: (n: string) => (n === "volume" ? vol : undefined) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
