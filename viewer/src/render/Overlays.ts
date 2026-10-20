import * as THREE from "three";
import { ThickLines } from "./ThickLines.ts";
import { transmittance, type DensityProfile } from "./transmittance.ts";

const SUB = 24; // subdivisions per edge so transmittance can vary along an edge

type V3 = [number, number, number];

function boxEdges(box: V3, scale: number): [V3, V3][] {
  const [hx, hy, hz] = box.map((v) => (v * scale) / 2);
  const c: V3[] = [];
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) c.push([x, y, z]);
  const e: [V3, V3][] = [];
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++) {
      const diff = [0, 1, 2].filter((k) => c[i][k] !== c[j][k]).length;
      if (diff === 1) e.push([c[i], c[j]]);
    }
  return e;
}

/** Wireframe, slice frame (guide lines), playback cursor frame, camera-path worldline and time labels. */
export class Overlays {
  readonly group = new THREE.Group();
  readonly wire: ThickLines;
  readonly guides: ThickLines;
  readonly cursor: ThickLines;
  readonly camPath: ThickLines;
  readonly labels = new THREE.Group();
  private wireSegs: [V3, V3][] = [];
  private box: V3 = [2, 1, 2];

  constructor() {
    this.wire = new ThickLines(12 * SUB, 1.0, 0.5);
    this.guides = new ThickLines(5 * SUB, 1.3, 1.6);
    this.cursor = new ThickLines(4 * SUB, 1.4, 1.2);
    this.camPath = new ThickLines(4096, 2.0, 1.4);
    this.group.add(this.wire.mesh, this.guides.mesh, this.cursor.mesh, this.camPath.mesh, this.labels);
  }

  setResolution(w: number, h: number) {
    for (const l of [this.wire, this.guides, this.cursor, this.camPath]) l.setResolution(w, h);
  }

  setBox(box: V3, wireScale: number, duration: number) {
    this.box = box;
    this.wireSegs = [];
    for (const [a, b] of boxEdges(box, wireScale))
      for (let s = 0; s < SUB; s++) {
        const f0 = s / SUB;
        const f1 = (s + 1) / SUB;
        this.wireSegs.push([
          [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0, a[2] + (b[2] - a[2]) * f0],
          [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1, a[2] + (b[2] - a[2]) * f1],
        ]);
      }
    this.writeSegs(this.wire, this.wireSegs);
    this.buildLabels(duration);
  }

  private writeSegs(l: ThickLines, segs: [V3, V3][]) {
    segs.forEach(([a, b], i) => {
      l.a.set(a, i * 3);
      l.b.set(b, i * 3);
    });
    l.count = segs.length;
    l.touch();
  }

  private colorize(l: ThickLines, segs: [V3, V3][], cam: V3, prof: DensityProfile, rgb: V3, alpha: number) {
    segs.forEach(([a, b], i) => {
      const ta = transmittance(cam, a, prof, 20);
      const tb = transmittance(cam, b, prof, 20);
      l.colA.set([rgb[0], rgb[1], rgb[2], alpha * ta], i * 4);
      l.colB.set([rgb[0], rgb[1], rgb[2], alpha * tb], i * 4);
    });
    l.touch(true);
  }

  private frameSegs(z: number, centreLine: boolean, inset = 1.0): [V3, V3][] {
    const [hx, hy] = [(this.box[0] * inset) / 2, (this.box[1] * inset) / 2];
    const corners: V3[] = [[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]];
    const lines: [V3, V3][] = corners.map((c, i) => [c, corners[(i + 1) % 4]]);
    if (centreLine) lines.push([[0, -hy, z], [0, hy, z]]);
    const out: [V3, V3][] = [];
    for (const [a, b] of lines)
      for (let s = 0; s < SUB; s++) {
        const f0 = s / SUB, f1 = (s + 1) / SUB;
        out.push([
          [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0, z],
          [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1, z],
        ]);
      }
    return out;
  }

  update(o: {
    cam: V3;
    prof: DensityProfile;
    wire: boolean;
    guides: number; // 0..1 opacity of the slice frame at tau
    cursor: number | null; // time 0..1 of the playback cursor
    wireAlpha: number;
  }) {
    this.wire.mesh.visible = o.wire;
    if (o.wire) this.colorize(this.wire, this.wireSegs, o.cam, o.prof, [0.74, 0.79, 0.9], o.wireAlpha);
    const tau = o.prof.tau;
    // all smoke (tau = 1): the reel still shows the slice frame while flying inside (5.8-9.6 s); it sits on the
    // back face. All solid (tau = 0): the frame would lie on the solid front face, so it is hidden.
    const showGuides = o.guides > 0.01 && tau > 0.002;
    this.guides.mesh.visible = showGuides;
    if (showGuides) {
      const z = (0.5 - Math.min(tau, 0.999)) * this.box[2];
      const segs = this.frameSegs(z, true, 0.995);
      this.writeSegs(this.guides, segs);
      // the guide sits on the cut face: measure transmittance to a point just in front of it
      const prof = { ...o.prof, sigmaSolid: o.prof.sigmaSmoke };
      this.colorize(this.guides, segs, o.cam, prof, [1, 1, 1], o.guides);
    }
    this.cursor.mesh.visible = o.cursor !== null;
    if (o.cursor !== null) {
      const z = (0.5 - o.cursor) * this.box[2];
      const segs = this.frameSegs(z, false, 1.0);
      this.writeSegs(this.cursor, segs);
      this.colorize(this.cursor, segs, o.cam, { ...o.prof, sigmaSolid: o.prof.sigmaSmoke }, [1.0, 0.72, 0.42], 0.95);
    }
  }

  setCameraPath(path: Float32Array | undefined, frames: number, visible: boolean) {
    const n = path ? Math.min(path.length / 2, this.camPath.capacity + 1) : 0;
    this.camPath.mesh.visible = visible && n > 1;
    if (!path || n < 2) return;
    const [W, H, D] = this.box;
    // the path is where each frame's centre lands in the reference frame; a pan wider than the frame leaves the
    // box (it drew a line across the whole screen), so a path that overflows is scaled about the frame centre to
    // fit inside it. Paths that already fit keep their true positions.
    let reach = 0;
    for (let i = 0; i < n; i++) reach = Math.max(reach, Math.abs(path[i * 2] - 0.5), Math.abs(path[i * 2 + 1] - 0.5));
    const k = reach > 0.48 ? 0.48 / reach : 1;
    const pos = (i: number): V3 => [(path[i * 2] - 0.5) * k * W, (0.5 - path[i * 2 + 1]) * k * H, (0.5 - i / (frames - 1)) * D];
    for (let i = 0; i < n - 1; i++) {
      this.camPath.a.set(pos(i), i * 3);
      this.camPath.b.set(pos(i + 1), i * 3);
      this.camPath.colA.set([0.62, 0.86, 1.0, 1], i * 4);
      this.camPath.colB.set([0.62, 0.86, 1.0, 1], i * 4);
      this.camPath.time.set([i / (frames - 1), (i + 1) / (frames - 1)], i * 2);
    }
    this.camPath.count = n - 1;
    this.camPath.touch();
  }

  private buildLabels(duration: number) {
    this.labels.clear();
    const [W, H, D] = this.box;
    const make = (text: string, pos: V3, size = 0.045) => {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 64;
      const g = c.getContext("2d")!;
      g.font = "500 30px 'IBM Plex Mono', ui-monospace, monospace";
      g.fillStyle = "rgba(200,210,232,0.95)";
      g.textBaseline = "middle";
      g.fillText(text, 8, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.NoColorSpace;
      const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
      const s = new THREE.Sprite(m);
      s.scale.set(size * 4, size, 1);
      s.center.set(0, 0.5);
      s.position.set(...pos);
      this.labels.add(s);
    };
    const ticks = Math.max(2, Math.min(6, Math.round(duration / 2.5) + 1));
    for (let i = 0; i < ticks; i++) {
      const f = i / (ticks - 1);
      make(`${(f * duration).toFixed(1)}s`, [W / 2 + 0.04 * W, -H / 2, (0.5 - f) * D]);
    }
    make("t →", [W / 2 + 0.04 * W, -H / 2 - 0.12 * H, 0]);
    make("x", [0, -H / 2 - 0.1 * H, D / 2]);
    make("y", [-W / 2 - 0.09 * W, 0, D / 2]);
  }

  dispose() {
    for (const l of [this.wire, this.guides, this.cursor, this.camPath]) l.dispose();
  }
}
