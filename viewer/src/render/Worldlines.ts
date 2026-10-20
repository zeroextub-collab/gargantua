import type { Gvol } from "../io/gvol.ts";
import { ThickLines } from "./ThickLines.ts";

export type WorldlineColor = "direction" | "speed" | "sampled";

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as const)[((i % 6) + 6) % 6].slice() as [number, number, number];
}

// warm "ember" ramp for speed: dark red -> orange -> pale yellow
function ember(x: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, x));
  return [Math.min(1, 0.35 + 1.2 * c), Math.min(1, 0.08 + 1.1 * c * c), Math.min(1, 0.05 + 0.9 * c ** 3)];
}

/** KLT worldlines as glowing additive (x, y, t) polylines with a LOD cap. */
export class Worldlines {
  readonly lines: ThickLines;
  readonly trackCount: number;
  private segStart: Uint32Array; // first segment index of each track
  private trackOf: Uint32Array; // track index of each segment
  private starts: Uint32Array;
  private lens: Uint32Array;
  private colors: Uint8Array;
  private speeds: Float32Array;
  private pts: Float32Array;
  private dir: Float32Array;

  constructor(g: Gvol, box: [number, number, number], step = 2) {
    const frames = g.header.plan.frames;
    this.starts = (g.section("track_start") as Uint32Array) ?? new Uint32Array();
    this.lens = (g.section("track_len") as Uint32Array) ?? new Uint32Array();
    this.colors = (g.section("track_color") as Uint8Array) ?? new Uint8Array();
    this.speeds = (g.section("track_speed") as Float32Array) ?? new Float32Array();
    this.pts = (g.section("track_points") as Float32Array) ?? new Float32Array();
    this.trackCount = this.lens.length;
    let segs = 0;
    for (const l of this.lens) segs += Math.max(0, Math.ceil((l - 1) / step));
    this.lines = new ThickLines(Math.max(1, segs), 1.25, 1.6);
    this.segStart = new Uint32Array(this.trackCount + 1);
    this.trackOf = new Uint32Array(Math.max(1, segs));
    this.dir = new Float32Array(this.trackCount);
    const [W, H, D] = box;
    let off = 0, s = 0;
    for (let k = 0; k < this.trackCount; k++) {
      this.segStart[k] = s;
      const n = this.lens[k];
      const t0 = this.starts[k];
      const P = (i: number) => {
        const x = this.pts[(off + i) * 2], y = this.pts[(off + i) * 2 + 1];
        return [(x - 0.5) * W, (0.5 - y) * H, (0.5 - (t0 + i) / Math.max(frames - 1, 1)) * D];
      };
      const last = n - 1;
      const dx = this.pts[(off + last) * 2] - this.pts[off * 2];
      const dy = this.pts[(off + last) * 2 + 1] - this.pts[off * 2 + 1];
      this.dir[k] = Math.atan2(dy * H, dx * W);
      for (let i = 0; i < last; i += step) {
        const j = Math.min(i + step, last);
        this.lines.a.set(P(i), s * 3);
        this.lines.b.set(P(j), s * 3);
        this.lines.time.set([(t0 + i) / (frames - 1), (t0 + j) / (frames - 1)], s * 2);
        this.trackOf[s] = k;
        s++;
      }
      off += n;
    }
    this.segStart[this.trackCount] = s;
    this.lines.count = s;
    this.lines.touch();
    this.setColor("direction");
  }

  setColor(mode: WorldlineColor) {
    const vmax = [...this.speeds].sort((a, b) => a - b)[Math.floor(this.speeds.length * 0.95)] || 1;
    const per: [number, number, number][] = [];
    for (let k = 0; k < this.trackCount; k++) {
      if (mode === "direction") per.push(hsv((this.dir[k] / (2 * Math.PI) + 1) % 1, 0.62, 1));
      else if (mode === "speed") per.push(ember(this.speeds[k] / vmax));
      else {
        const c = [this.colors[k * 3], this.colors[k * 3 + 1], this.colors[k * 3 + 2]].map((v) => v / 255);
        const m = Math.max(...c, 0.05);
        per.push(c.map((v) => Math.min(1, (v / m) * 0.85 + 0.15)) as [number, number, number]);
      }
    }
    const n = this.segStart[this.trackCount];
    for (let s = 0; s < n; s++) {
      const k = this.trackOf[s];
      const [r, g, b] = per[k];
      // fade in/out along each track so ends do not pop
      const a0 = 0.9;
      this.lines.colA.set([r, g, b, a0], s * 4);
      this.lines.colB.set([r, g, b, a0], s * 4);
    }
    this.lines.touch(true);
  }

  /** Draw the first `tracks` tracks (sorted by length x speed in the pipeline). */
  setLimit(tracks: number) {
    const k = Math.max(0, Math.min(this.trackCount, Math.floor(tracks)));
    this.lines.count = this.segStart[k];
  }

  dispose() {
    this.lines.dispose();
  }
}
