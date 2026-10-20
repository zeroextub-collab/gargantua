// Fit the Look Director's two reel constants by rendering (P3/P8):
//   1. exposure: the solid front face, seen head-on, must reproduce the source frame's mean brightness;
//   2. tauTarget: at the reel's start framing with the dissolve cut at 85%, the smoke-only region must show
//      the reel's measured smoke/pavement display ratio (0.253, docs/REEL_ANALYSIS.md section 3).
// Uses the synthetic overhead crossing (the reel-like scene). Writes docs/evidence/p3/calibration.json.
//   node tools/bench/calibrate.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, launch, openViewer, serve } from "../lib/serve.mjs";

const VOL = join(ROOT, "work", "bench", "volumes", "sparse_overhead.gvol");
const MP4 = join(ROOT, "work", "bench", "synthetic", "sparse_overhead.mp4");
const TARGET_RATIO = 0.253;
const W = 874, H = 880; // the reel's recording size, so framing matches
const GW = 96, GH = 96;

// source brightness: mean BT.709 luma of frame 0 (what the solid front face shows)
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", MP4, "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 });
let srcLuma = 0;
for (let i = 0; i < raw.length; i += 3) srcLuma += 0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2];
srcLuma /= raw.length / 3;

const srv = await serve({ "cal.gvol": VOL });
const browser = await launch();
const { page, errors } = await openViewer(browser, srv.url, "cal.gvol", W, H);
const EDGE = Number(process.argv[2] ?? 0.05);
const DISPLAY = (process.argv[3] ?? "linear") === "display";
const base = { edgeSoft: EDGE, displayBlend: DISPLAY, smoke: true, wire: false, guides: false, labels: false, worldlines: false, plate: 0, bloom: 0, grain: 0, vignette: 0, sep: 0, flicker: 0, autoDensity: true };
const grid = (cam, patch) => page.evaluate(([c, p, gw, gh]) => window.__gargantua.lumaGrid(c, p, 24, gw, gh), [cam, { ...base, ...patch }, GW, GH]);
const mean = (a, idx) => idx.reduce((s, i) => s + a[i], 0) / Math.max(idx.length, 1);

// ---- 1. exposure: head-on solid front face vs. source frame 0 --------------------------------------
const front = await page.evaluate(() => window.__gargantua.presetCam("front"));
let lo = 0.3, hi = 3, exposure = 1, faceLuma = 0;
for (let it = 0; it < 14; it++) {
  exposure = Math.sqrt(lo * hi);
  const g = await grid(front, { tau: 0, exposure });
  const inside = g.map((v, i) => [v, i]).filter(([v]) => v > 8).map(([, i]) => i);
  // central 60% of the face only (avoid the box edge and wireframe-free border cells)
  const xs = inside.map((i) => i % GW), ys = inside.map((i) => Math.floor(i / GW));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const core = inside.filter((i) => { const x = i % GW, y = Math.floor(i / GW); return x > x0 + 0.2 * (x1 - x0) && x < x1 - 0.2 * (x1 - x0) && y > y0 + 0.2 * (y1 - y0) && y < y1 - 0.2 * (y1 - y0); });
  faceLuma = mean(g, core);
  if (faceLuma > srcLuma) hi = exposure; else lo = exposure;
}

// ---- 2. smoke density: one clean reel target -------------------------------------------------------------
// Top-down view (reel t=3.8-4.2): rays cross the box height through smoke and exit to black. Reel HAZE median
// (cube pixels with low local detail, so the crisp solid slab is excluded): 76.3, 79.5, 77.6, 59.1 (camera
// moving), 78.9 -> median 77.6. Reference: the reel's solid front face at t=0.0, median 209.4 (PnP face polygon,
// eroded). Target ratio 0.371. The render matches it haze-for-haze: tau = 1 (all smoke, no slab).
// Rejected attempts, kept for the record: (a) the 1.7 s lower-left region sits in the edge falloff and
// under-reads density; (b) whole-cube means include the slab, whose apparent size differs between poses;
// (c) an inside-view target sees the bright far slab and is not comparable to the reel's inside frames.
const TARGET = 77.6 / 209.4;
// The cube region is defined GEOMETRICALLY (silhouette of a solid render at the same pose), never by a brightness
// threshold: thin haze can sit below any threshold, and a thresholded median then measures stray bright pixels.
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const topCam = await page.evaluate(() => window.__gargantua.directorCam(4.0));
const silTop = await grid(topCam, { tau: 0, exposure });
const silIdx = silTop.map((v, i) => [v, i]).filter(([v]) => v > 20).map(([, i]) => i);
const frontGrid = await grid(front, { tau: 0, exposure });
const frontIdx = frontGrid.map((v, i) => [v, i]).filter(([v]) => v > 20).map(([, i]) => i);
const frontMedian = median(frontIdx.map((i) => frontGrid[i]));
const silShare = silIdx.length / (GW * GH);
// Second clean target: the reel's inside view (t=6.6-9.0), haze median 117.8 (13 frames, 114.7-121.8): no slab
// visible, the whole frame is haze -> ratio 117.8 / 209.4 = 0.563. Render: director t=7.4 with tau = 1.
const TARGET_IN = 117.8 / 209.4;
const inCam = await page.evaluate(() => window.__gargantua.directorCam(7.4));
const silIn = await grid(inCam, { tau: 0, exposure });
const silInIdx = silIn.map((v, i) => [v, i]).filter(([v]) => v > 5).map(([, i]) => i);
const measure = async (s) => {
  const hz = await grid(topCam, { tau: 1, exposure, densityScale: s });
  const hi = await grid(inCam, { tau: 1, exposure, densityScale: s });
  const rt = median(silIdx.map((i) => hz[i])) / frontMedian;
  const ri = median(silInIdx.map((i) => hi[i])) / frontMedian;
  return { s, rt, ri, err: Math.log(rt / TARGET) ** 2 + Math.log(ri / TARGET_IN) ** 2 };
};
// Joint fit on two reel measurements at different geometries: the top-down haze (median, geometric silhouette)
// and the 1.7 s band (smoke over black vs the solid face at the same cells; the reel's band x 0.09-0.38,
// y 0.41-0.73 of the cube's bounding box). No single uniform density meets both exactly with this content; the
// residual is reported as the calibration's uncertainty. The inside view is reported, not fitted (see above).
const reelCam = await page.evaluate(() => window.__gargantua.presetCam("reel"));
const solidReel = await grid(reelCam, { tau: 0, exposure });
const insideReel = solidReel.map((v, i) => [v, i]).filter(([v]) => v > 25).map(([, i]) => i);
const rbx = insideReel.map((i) => i % GW), rby = insideReel.map((i) => Math.floor(i / GW));
const [qx0, qx1, qy0, qy1] = [Math.min(...rbx), Math.max(...rbx), Math.min(...rby), Math.max(...rby)];
const bandRatio = async (s) => {
  const dz = await grid(reelCam, { tau: 0.85, exposure, densityScale: s });
  const sk = await grid(reelCam, { tau: 1, exposure, densityScale: s });
  const reg = insideReel.filter((i) => {
    const rx = (i % GW - qx0) / (qx1 - qx0), ry = (Math.floor(i / GW) - qy0) / (qy1 - qy0);
    return rx > 0.09 && rx < 0.38 && ry > 0.41 && ry < 0.73 && Math.abs(dz[i] - sk[i]) < 1.5;
  });
  return { r: mean(dz, reg) / mean(solidReel, reg), cells: reg.length };
};
const joint = async (s) => {
  const m = await measure(s);
  const b = await bandRatio(s);
  return { ...m, rb: b.r, cells: b.cells, err: Math.log(m.rt / TARGET) ** 2 + Math.log(b.r / TARGET_RATIO) ** 2 };
};
let ga = Math.log(0.05), gb = Math.log(60);
const phi = (Math.sqrt(5) - 1) / 2;
let gc = gb - phi * (gb - ga), gd = ga + phi * (gb - ga);
let jc = await joint(Math.exp(gc)), jd = await joint(Math.exp(gd));
for (let it = 0; it < 20; it++) {
  if (jc.err < jd.err) { gb = gd; gd = gc; jd = jc; gc = gb - phi * (gb - ga); jc = await joint(Math.exp(gc)); }
  else { ga = gc; gc = gd; jc = jd; gd = ga + phi * (gb - ga); jd = await joint(Math.exp(gd)); }
}
const fitRes = jc.err < jd.err ? jc : jd;
const scale = fitRes.s;
const top = { median: fitRes.rt * frontMedian };
const frontStats = { median: frontMedian };
const best = { r: [{ name: "topdown_3.8 (fitted)", ratio: TARGET, achieved: fitRes.rt }, { name: "band_1.7 (fitted)", ratio: TARGET_RATIO, achieved: fitRes.rb },
  { name: "inside_7.2 (diagnostic, not fitted)", ratio: TARGET_IN, achieved: fitRes.ri }], err: fitRes.err };
// diagnostic: the earlier 1.7 s lower-left ratio at the fitted density
const reel = await page.evaluate(() => window.__gargantua.presetCam("reel"));
const solid = await grid(reel, { tau: 0, exposure });
const diss = await grid(reel, { tau: 0.85, exposure, densityScale: scale });
const smk = await grid(reel, { tau: 1, exposure, densityScale: scale });
const inside = solid.map((v, i) => [v, i]).filter(([v]) => v > 25).map(([, i]) => i);
const xs = inside.map((i) => i % GW).sort((p, q) => p - q), ys = inside.map((i) => Math.floor(i / GW)).sort((p, q) => p - q);
const mx = xs[Math.floor(xs.length / 2)], my = ys[Math.floor(ys.length / 2)];
// the reel's region (x 130-340, y 420-580 of the 874x880 frame) in coordinates relative to the cube's bounding
// box at t=1.7 (box spans x 60-800, y 210-720): x 0.09-0.38, y 0.41-0.73. Same relative band here, smoke-only rays.
const bx = inside.map((i) => i % GW), by = inside.map((i) => Math.floor(i / GW));
const [bx0, bx1, by0, by1] = [Math.min(...bx), Math.max(...bx), Math.min(...by), Math.max(...by)];
const region = inside.filter((i) => {
  const rx = (i % GW - bx0) / (bx1 - bx0), ry = (Math.floor(i / GW) - by0) / (by1 - by0);
  return rx > 0.09 && rx < 0.38 && ry > 0.41 && ry < 0.73 && Math.abs(diss[i] - smk[i]) < 1.5;
});
void mx; void my;
const ratio = mean(diss, region) / mean(solid, region);
const tauTargetBase = await page.evaluate(() => window.gargantua.look?.tauTarget ?? null);
await browser.close();
srv.close();
const res = {
  edge_soft: EDGE,
  blending: DISPLAY ? "display" : "linear",
  method: "render-and-compare on work/bench/volumes/sparse_overhead.gvol at the reel's recording size",
  source_frame0_mean_luma: +srcLuma.toFixed(2),
  exposure: { fitted: +exposure.toFixed(4), rendered_face_luma: +faceLuma.toFixed(2) },
  density: { fitted_density_scale: +scale.toFixed(4), targets: best.r.map((x) => ({ pose: x.name, reel: +x.ratio.toFixed(3), render: +x.achieved.toFixed(3) })),
    front_face_median: +frontStats.median.toFixed(2), topdown_haze_median: +top.median.toFixed(2), topdown_silhouette_share: +silShare.toFixed(3),
    reel_topdown_cube_share: 0.443, objective: +best.err.toFixed(5),
    tauTarget_base: tauTargetBase, tauTarget_fitted: tauTargetBase ? +(tauTargetBase * scale).toFixed(4) : null,
    diagnostic_1p7s_lowerleft: { reel: TARGET_RATIO, render: +ratio.toFixed(4), cells: region.length } },
  errors,
};
mkdirSync(join(ROOT, "docs", "evidence", "p3"), { recursive: true });
writeFileSync(join(ROOT, "docs", "evidence", "p3", "calibration.json"), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
if (best.err > 0.6 || silShare < 0.15 || silShare > 0.85) {
  console.error("CALIBRATION FAILED: the two reel targets cannot both be met (objective too high) or the cube was not visible");
  process.exit(1);
}
