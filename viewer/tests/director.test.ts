import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, camPosition } from "../src/director/Director.ts";
import { REEL_ASPECT, framingFit, reelSequence } from "../src/director/reelSequence.ts";

const keys = [
  { t: 0, cam: { az: 350, el: 10, dist: 4, target: [0, 0, 0] as [number, number, number], fov: 35 }, params: { tau: 0 } },
  { t: 2, cam: { az: 10 }, params: { tau: 1 }, ease: "linear" as const },
  { t: 4, params: { tau: 0.5 }, ease: "hold" as const },
];

test("returns exact keyframe values at key times", () => {
  const d = new Director(keys);
  assert.equal(d.evaluate(0).params.tau, 0);
  assert.equal(d.evaluate(2).params.tau, 1);
  assert.equal(d.evaluate(2).cam.az % 360, 10);
});

test("azimuth takes the short way round (350 -> 10 passes through 0, not 180)", () => {
  const mid = new Director(keys).evaluate(1).cam.az;
  const wrapped = ((mid % 360) + 360) % 360;
  assert.ok(Math.abs(wrapped - 0) < 1e-6 || Math.abs(wrapped - 360) < 1e-6, String(mid));
});

test("missing fields carry forward from the previous key", () => {
  const e = new Director(keys).evaluate(3);
  assert.equal(e.cam.dist, 4);
  assert.equal(e.cam.fov, 35);
});

test("hold easing keeps the previous value until the key time", () => {
  const d = new Director(keys);
  assert.equal(d.evaluate(3.9).params.tau, 1);
  assert.equal(d.evaluate(4).params.tau, 0.5);
});

test("clamps outside the timeline", () => {
  const d = new Director(keys);
  assert.equal(d.evaluate(-5).params.tau, 0);
  assert.equal(d.evaluate(99).params.tau, 0.5);
  assert.equal(d.duration, 4);
});

test("camPosition: el=0, az=0 puts the camera on +z at distance dist", () => {
  const p = camPosition({ az: 0, el: 0, dist: 3, target: [1, 0, 0], fov: 35 });
  assert.deepEqual(p.map((v) => Math.round(v * 1e6) / 1e6), [1, 0, 3]);
});

test("reel sequence follows the measured beat sheet: solid start, dissolve, inside, solid end", () => {
  const d = new Director(reelSequence([2, 1.125, 2.08]));
  assert.ok(d.duration >= 10.5 && d.duration <= 12, String(d.duration));
  assert.equal(d.evaluate(0.2).params.tau, 0); // all solid
  assert.ok(d.evaluate(1.6).params.tau > 0.6); // dissolved
  assert.ok(d.evaluate(7.5).params.inside === 1); // camera inside the box
  assert.equal(d.evaluate(d.duration).params.tau, 0); // solid hero end
});

// pinhole projection of the 8 box corners: share of the frame width / height the box covers
function boxShare(cam: { az: number; el: number; dist: number; target: [number, number, number]; fov: number }, box: [number, number, number], aspect: number) {
  const eye = camPosition(cam);
  const f = cam.target.map((v, k) => v - eye[k]);
  const fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  const r0 = [fw[2], 0, -fw[0]]; // right = forward x up(0,1,0), sign so +x is right on screen
  const rl = Math.hypot(...r0);
  const right = r0.map((v) => -v / rl);
  const up = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]];
  const ty = Math.tan(((cam.fov / 2) * Math.PI) / 180), tx = ty * aspect;
  const xs: number[] = [], ys: number[] = [];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    const p = [sx * box[0], sy * box[1], sz * box[2]].map((v, k) => v - eye[k]);
    const z = p[0] * fw[0] + p[1] * fw[1] + p[2] * fw[2];
    xs.push((p[0] * right[0] + p[1] * right[1] + p[2] * right[2]) / z / tx);
    ys.push((p[0] * up[0] + p[1] * up[1] + p[2] * up[2]) / z / ty);
  }
  return { w: (Math.max(...xs) - Math.min(...xs)) / 2, h: (Math.max(...ys) - Math.min(...ys)) / 2 };
}

test("framing: the hero shot keeps the reel's width share on narrow outputs and its height share on wide ones", () => {
  const box: [number, number, number] = [16 / 9, 1, 1.04 * 16 / 9];
  const hero = (aspect: number) => reelSequence(box, aspect)[0].cam as { az: number; el: number; dist: number; target: [number, number, number]; fov: number };
  const reel = boxShare(hero(REEL_ASPECT), box, REEL_ASPECT);
  const portrait = boxShare(hero(9 / 16), box, 9 / 16);
  const wide = boxShare(hero(16 / 9), box, 16 / 9);
  assert.ok(reel.w < 1 && reel.w > 0.8, `reel-aspect width share ${reel.w}`);
  assert.ok(Math.abs(portrait.w - reel.w) < 0.02, `9:16 width share ${portrait.w} vs reel ${reel.w}`);
  assert.ok(Math.abs(wide.h - reel.h) < 0.02, `16:9 height share ${wide.h} vs reel ${reel.h}`);
  assert.equal(framingFit(16 / 9), 1);
  assert.equal(framingFit(REEL_ASPECT), 1);
});
