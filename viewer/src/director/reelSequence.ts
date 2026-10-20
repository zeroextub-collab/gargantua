// The reel's beat sheet (docs/REEL_ANALYSIS.md section 6) as director keys, expressed relative to the box
// so it works for any clip aspect. tau: time threshold (solid where t >= tau). guides: slice-frame layer.
// inside: 1 while the camera is inside the box (used by tests and the UI).
//
// viewAspect: output width / height. The framing distances were measured ON THE REEL, whose frame is 874x880
// (aspect 0.993): there the solid box spans 0.90 of the frame width and 0.60 of its height (t = 0,
// work/p1/frames/f_0000.png). Wider outputs keep that vertical share (fit 1); narrower ones (9:16 Instagram)
// pull every OUTSIDE shot back by the aspect ratio so the box keeps the reel's share of the frame width.
// Inside shots are never pushed back (that would move the camera out of the box).
import type { Key } from "./Director.ts";

export const REEL_ASPECT = 874 / 880;

/** Distance multiplier for outside shots at a given output aspect (shared with the viewer's camera presets). */
export function framingFit(viewAspect: number): number {
  // the horizontal half-FOV tangent scales with the aspect at a fixed vertical FOV, so the width share is kept
  // by scaling the distance by the same ratio. (An earlier rule took 16:9 as the reference and left the box at
  // 0.60 x 0.44 of the reel-aspect frame, 0.67x the reel's size.)
  return viewAspect < REEL_ASPECT ? REEL_ASPECT / viewAspect : 1;
}

export function reelSequence(box: [number, number, number], viewAspect = 16 / 9): Key[] {
  const [W, H, D] = box;
  const diag = Math.hypot(W, H, D);
  const fit = framingFit(viewAspect);
  const o = (d: number) => d * fit; // outside distance
  // hero pose fitted to the reel's t = 0 silhouette at 874x880 (tools/bench/fit_frame.mjs): elevation 16 deg,
  // distance 1.68 x diagonal -> box 0.910 x 0.609 of the frame vs the reel's 0.903 x 0.610. The other outside
  // distances keep their measured ratios to it.
  const out = o(1.68 * diag);
  const hero = { az: 34, el: 16, dist: out, target: [0, -0.02 * H, 0] as [number, number, number], fov: 35, roll: 0 };
  return [
    { t: 0.0, cam: hero, params: { tau: 0, guides: 0, inside: 0 } },
    { t: 0.8, cam: { az: 36 }, params: { tau: 0 }, ease: "linear" },
    { t: 1.7, cam: { az: 38 }, params: { tau: 0.85 }, ease: "inOut" },
    { t: 2.5, cam: { az: 40 }, params: { tau: 0 }, ease: "inOut" },
    { t: 2.8, params: { tau: 0 }, ease: "linear" },
    { t: 3.5, cam: { az: 42 }, params: { tau: 0.9 }, ease: "inOut" },
    // a fast rise to top-down (reel 3.6-3.8 s: box rolled ~45 deg), then a spin over the top: looking down from
    // azimuth a puts the back slab at screen angle a, and the reel shows it top-right (3.8), top (4.3), top-left
    // (4.6), then left (4.8) as the camera drops to the side and swings head-on (5.0). Times read off the reel
    // frames at 10 fps (work/p1/frames f_0034-f_0050).
    { t: 3.8, cam: { az: 45, el: 82, dist: o(1.5 * diag) }, params: { tau: 0.95 }, ease: "inOut" }, // diamond, 0.9 of the frame
    { t: 4.3, cam: { az: 0, el: 85, dist: o(1.85 * diag) }, ease: "linear" }, // square-on, 0.6 of the width
    { t: 4.6, cam: { az: -45, el: 75 }, ease: "linear" },
    { t: 4.8, cam: { az: -80, el: 35, dist: o(1.5 * diag) }, params: { guides: 1 }, ease: "inOut" },
    // swing across the front (slab centre-right at 5.0, right at 5.2), then hold head-on down the time axis with
    // the slice frame visible (5.4-5.7, box ~0.67 of the width)
    { t: 5.0, cam: { az: -5, el: 12, dist: o(1.6 * diag), target: [0, 0, 0] }, ease: "inOut" },
    { t: 5.2, cam: { az: 38, el: 8, dist: o(1.75 * diag) }, ease: "inOut" },
    { t: 5.4, cam: { az: 0, el: 2, dist: o(2.0 * diag) }, ease: "inOut" },
    { t: 5.7, cam: { dist: o(1.95 * diag) }, ease: "linear" },
    // the reel jump-cuts inside the box at 5.8 and then pushes slowly deeper through the smoke
    { t: 5.82, cam: { az: 2, el: 3, dist: 0.45 * D, target: [0, 0, -0.02 * D] }, params: { inside: 1, tau: 1 }, ease: "out" }, // reel 5.8-9.6: smoke all around, no slab
    { t: 6.6, cam: { az: 4, el: 4, dist: 0.32 * D, target: [0, 0, -0.08 * D] }, ease: "inOut" },
    { t: 8.2, cam: { az: -8, el: -3, dist: 0.26 * D, target: [0.04 * W, 0, -0.18 * D] }, ease: "inOut" },
    { t: 9.6, cam: { az: 6, el: 3, dist: 0.24 * D, target: [-0.03 * W, 0.02 * H, -0.12 * D] }, ease: "inOut" },
    // fly out to the solid hero orbit: from the back-left round to the start pose
    { t: 10.0, cam: { az: 225, el: 26, dist: o(1.56 * diag), target: [0, 0, 0] }, params: { inside: 0, guides: 0, tau: 0 }, ease: "out" },
    { t: 11.2, cam: { az: 394, el: 16, dist: out, target: hero.target }, ease: "inOut" },
  ];
}
