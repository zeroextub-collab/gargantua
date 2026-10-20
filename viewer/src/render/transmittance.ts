// Transmittance between two points through the cube's density, on the CPU. Used to fade wireframe edges and
// guide lines that sit behind smoke or solid voxels (the shader has no depth for them). It uses the same
// sigma(t) model as the ray-marcher with the mean field, which is exact for REEL mode (field = 1).

export interface DensityProfile {
  box: [number, number, number]; // W, H, D (centred at the origin; front face at z = +D/2 is t = 0)
  sigmaSmoke: number; // per world unit
  sigmaSolid: number;
  tau: number; // time threshold
  tauDir: number; // +1: solid where t >= tau ; -1: solid where t <= tau
  field: number; // mean density field multiplier (RAW: 1)
  reveal?: number; // optional time cursor: no density beyond it
}

function segBox(a: number[], b: number[], half: number[]): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] < -half[k] || a[k] > half[k]) return null;
      continue;
    }
    let ta = (-half[k] - a[k]) / d;
    let tb = (half[k] - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

export function sigmaAt(z: number, p: DensityProfile): number {
  const D = p.box[2];
  const t = 0.5 - z / D; // 0 at the front face
  if (p.reveal !== undefined && t > p.reveal) return 0;
  const later = p.tau >= 0.999 ? false : p.tau <= 0.001 ? true : t >= p.tau; // ends of the range are exact
  const solid = p.tauDir >= 0 ? later : !later;
  return (solid ? p.sigmaSolid : p.sigmaSmoke) * p.field;
}

export function transmittance(from: number[], to: number[], p: DensityProfile, samples = 24): number {
  const half = [p.box[0] / 2, p.box[1] / 2, p.box[2] / 2];
  const span = segBox(from, to, half);
  if (!span) return 1;
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const [t0, t1] = span;
  const dt = (t1 - t0) / samples;
  let optical = 0;
  for (let i = 0; i < samples; i++) {
    const s = t0 + (i + 0.5) * dt;
    const z = from[2] + (to[2] - from[2]) * s;
    optical += sigmaAt(z, p) * dt * len;
  }
  return Math.exp(-optical);
}
