import { test } from "node:test";
import assert from "node:assert/strict";
import { blueNoise } from "../src/render/blueNoise.ts";
import { transmittance } from "../src/render/transmittance.ts";
import { autoDensity, boxDims, evidenceGain } from "../src/look/LookDirector.ts";

test("blue noise is a permutation of ranks (uniform histogram)", () => {
  const { ranks } = blueNoise(32, 7);
  const seen = new Uint8Array(32 * 32);
  for (const r of ranks) seen[r]++;
  assert.ok(seen.every((v) => v === 1));
});

test("blue noise has far less low-frequency power than white noise", () => {
  const n = 32;
  const { ranks } = blueNoise(n, 3);
  const white = Float64Array.from({ length: n * n }, (_, i) => ((i * 2654435761) >>> 0) % (n * n));
  const lowPower = (a: ArrayLike<number>) => {
    let s = 0;
    const mean = (n * n - 1) / 2;
    for (let fy = 0; fy <= 2; fy++)
      for (let fx = 0; fx <= 2; fx++) {
        if (fx === 0 && fy === 0) continue;
        let re = 0, im = 0;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            const ph = (2 * Math.PI * (fx * x + fy * y)) / n;
            re += (a[y * n + x] - mean) * Math.cos(ph);
            im -= (a[y * n + x] - mean) * Math.sin(ph);
          }
        s += re * re + im * im;
      }
    return s;
  };
  assert.ok(lowPower(ranks) < 0.2 * lowPower(white), `${lowPower(ranks)} vs ${lowPower(white)}`);
});

const box: [number, number, number] = [2, 1, 2];
const base = { box, sigmaSmoke: 0.5, sigmaSolid: 0.5, tau: 0, tauDir: 1, field: 1 };

test("transmittance through uniform density over length L is exp(-sigma L)", () => {
  // from outside, through the whole depth along the time axis (z), to just behind the box
  const t = transmittance([0, 0, 5], [0, 0, -1.0], base, 64);
  assert.ok(Math.abs(t - Math.exp(-0.5 * 2)) < 1e-3, String(t));
});

test("transmittance is 1 for a segment that misses the box", () => {
  assert.equal(transmittance([5, 5, 5], [5, 4, 5], base, 16), 1);
});

test("a solid region (t >= tau) blocks the view behind it", () => {
  const prof = { ...base, sigmaSmoke: 0.1, sigmaSolid: 400, tau: 0.5 };
  assert.ok(transmittance([0, 0, 5], [0, 0, -0.99], prof, 128) < 1e-3);
  assert.ok(transmittance([0, 0, 5], [0, 0, 0.5], prof, 128) > 0.9); // stops inside the smoke part
});

test("auto density hits the target optical depth along the time axis", () => {
  const sigma = autoDensity(0.8, 2.08, 1.0);
  assert.ok(Math.abs(sigma * 2.08 - 0.8) < 1e-9);
});

test("evidence gain normalises the mean field to ~1 and is bounded", () => {
  assert.ok(Math.abs(evidenceGain(0.17) * 0.17 - 1) < 1e-9);
  assert.equal(evidenceGain(0.0001), 20);
});

test("box dims keep the clip aspect on the front face and depth = ratio x width", () => {
  const [w, h, d] = boxDims(16 / 9, 1.04, 2);
  assert.equal(w, 2);
  assert.ok(Math.abs(h - 1.125) < 1e-9);
  assert.ok(Math.abs(d - 2.08) < 1e-9);
  const [pw, ph] = boxDims(9 / 16, 1.0, 2); // portrait: height is the long side, capped at 2
  assert.ok(ph === 2 && Math.abs(pw - 1.125) < 1e-9);
});

test("tau = 1 means all smoke: no solid back wall (and tau = 0 means all solid)", () => {
  const prof = { ...base, sigmaSmoke: 0.1, sigmaSolid: 400, tau: 1 };
  // a ray that ends exactly on the back face must not be blocked by a solid sliver there
  assert.ok(transmittance([0, 0, 5], [0, 0, -1.04], prof, 256) > 0.75);
  const solid = { ...base, sigmaSmoke: 0.1, sigmaSolid: 400, tau: 0 };
  assert.ok(transmittance([0, 0, 5], [0, 0, 0.9], solid, 256) < 1e-3); // a point just inside the front face
});

test("emissive boost: full for small night lights, proportionally less when bright pixels are areas", async () => {
  const { emissiveGainFor } = await import("../src/look/LookDirector.ts");
  assert.equal(emissiveGainFor(0.0298), 1); // user's night crossing: point lights and screens keep the full glow
  assert.ok(Math.abs(emissiveGainFor(0.0981) - 0.357) < 0.01); // clipped sky in a time-lapse
  assert.equal(emissiveGainFor(undefined), 1);
  assert.equal(emissiveGainFor(0), 1);
});
