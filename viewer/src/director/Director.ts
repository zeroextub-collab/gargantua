// Keyframed camera + parameter timeline. Pure (no three.js) so it is unit-testable and deterministic for export.

export interface CamKey {
  az: number; // degrees, 0 = looking from +z (front face), 90 = from +x (right side)
  el: number; // degrees above the horizontal
  dist: number; // world units from target
  target: [number, number, number];
  fov: number; // vertical, degrees
  roll?: number; // degrees
}

export type Ease = "linear" | "inOut" | "in" | "out" | "hold";

export interface Key {
  t: number;
  cam?: Partial<CamKey>;
  params?: Record<string, number>;
  ease?: Ease; // easing of the segment that ENDS at this key
}

interface FullKey {
  t: number;
  cam: CamKey;
  params: Record<string, number>;
  ease: Ease;
}

export interface Evaluated {
  cam: CamKey;
  params: Record<string, number>;
}

const DEFAULT_CAM: CamKey = { az: 30, el: 22, dist: 6, target: [0, 0, 0], fov: 35, roll: 0 };

function ease(e: Ease, x: number): number {
  switch (e) {
    case "linear":
      return x;
    case "in":
      return x * x * x;
    case "out":
      return 1 - (1 - x) ** 3;
    case "hold":
      return x >= 1 ? 1 : 0;
    default:
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export class Director {
  readonly keys: FullKey[];
  readonly duration: number;

  constructor(keys: Key[]) {
    if (!keys.length) throw new Error("Director needs at least one key");
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    const out: FullKey[] = [];
    let cam: CamKey = { ...DEFAULT_CAM };
    let params: Record<string, number> = {};
    let prevAz: number | undefined;
    for (const k of sorted) {
      cam = { ...cam, ...k.cam, target: (k.cam?.target ?? cam.target).slice() as [number, number, number] };
      // unwrap azimuth so consecutive keys differ by at most 180 degrees (short way round)
      if (prevAz !== undefined && k.cam?.az !== undefined) {
        let a = cam.az;
        while (a - prevAz > 180) a -= 360;
        while (a - prevAz < -180) a += 360;
        cam.az = a;
      }
      prevAz = cam.az;
      params = { ...params, ...k.params };
      out.push({ t: k.t, cam: { ...cam }, params: { ...params }, ease: k.ease ?? "inOut" });
    }
    // params introduced late are back-filled so every key defines every param
    const names = new Set(out.flatMap((k) => Object.keys(k.params)));
    for (const n of names) {
      const first = out.find((k) => n in k.params)!.params[n];
      for (const k of out) if (!(n in k.params)) k.params[n] = first;
    }
    this.keys = out;
    this.duration = out[out.length - 1].t;
  }

  evaluate(t: number): Evaluated {
    const ks = this.keys;
    if (t <= ks[0].t) return { cam: { ...ks[0].cam }, params: { ...ks[0].params } };
    const last = ks[ks.length - 1];
    if (t >= last.t) return { cam: { ...last.cam }, params: { ...last.params } };
    let i = 1;
    while (ks[i].t < t) i++;
    const a = ks[i - 1];
    const b = ks[i];
    const f = ease(b.ease, (t - a.t) / Math.max(b.t - a.t, 1e-9));
    const cam: CamKey = {
      az: lerp(a.cam.az, b.cam.az, f),
      el: lerp(a.cam.el, b.cam.el, f),
      dist: Math.exp(lerp(Math.log(a.cam.dist), Math.log(b.cam.dist), f)), // log: fly-ins feel even
      target: [0, 1, 2].map((j) => lerp(a.cam.target[j], b.cam.target[j], f)) as [number, number, number],
      fov: lerp(a.cam.fov, b.cam.fov, f),
      roll: lerp(a.cam.roll ?? 0, b.cam.roll ?? 0, f),
    };
    const params: Record<string, number> = {};
    for (const n of Object.keys(a.params)) params[n] = lerp(a.params[n], b.params[n], f);
    return { cam, params };
  }
}

export function camPosition(c: CamKey): [number, number, number] {
  const az = (c.az * Math.PI) / 180;
  const el = (c.el * Math.PI) / 180;
  return [
    c.target[0] + c.dist * Math.cos(el) * Math.sin(az),
    c.target[1] + c.dist * Math.sin(el),
    c.target[2] + c.dist * Math.cos(el) * Math.cos(az),
  ];
}
