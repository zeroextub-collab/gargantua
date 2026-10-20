// Renderer performance in the installed Chrome (headless; Chrome picks the RTX 5070 - verified in P0).
//   node tools/bench/perf.mjs [--w 1920] [--h 1080] [--quick] [--out name] path/a.gvol path/b.gvol ...
// Frame time is synchronised with a 1-pixel readPixels (gl.finish does not block in Chrome) and cross-checked
// against the GPU timer query. States: solid / dissolve / smoke (worst case: full-length rays) / separated;
// --quick measures only solid + smoke. Writes docs/evidence/p3/perf_<out>_<w>x<h>.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ROOT, launch, openViewer, serve } from "../lib/serve.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (k) => {
  const i = args.indexOf(`--${k}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const W = Number(opt("w", 1920));
const H = Number(opt("h", 1080));
const quick = flag("quick");
const outName = opt("out", "run");
const vols = args.map((a) => resolve(ROOT, a));
const OUT = join(ROOT, "docs", "evidence", "p3");
mkdirSync(OUT, { recursive: true });

const vram = () => {
  try {
    return Number(execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"]).toString().trim().split("\n")[0]);
  } catch {
    return NaN;
  }
};
// nvidia-smi is global: wait until the previous page's memory is released before taking a baseline
const settle = async () => {
  let last = vram();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = vram();
    if (Math.abs(now - last) < 16) return now;
    last = now;
  }
  return last;
};
const STATES = quick
  ? { solid: { tau: 0 }, smoke: { tau: 1 } }
  : { solid: { tau: 0 }, dissolve: { tau: 0.85, guideOpacity: 1 }, smoke: { tau: 1 }, separated: { tau: 1, sep: 1 } };
const srv = await serve(Object.fromEntries(vols.map((v) => [basename(v), v])));
const rows = [];
for (const v of vols) {
  // a fresh browser per volume: Chrome pools freed GPU memory until the next allocation, so a shared browser
  // makes the global nvidia-smi delta unattributable (it read negative for every second volume)
  const before = await settle();
  const browser = await launch();
  const { page, errors } = await openViewer(browser, srv.url, basename(v), W, H);
  await page.waitForTimeout(1000);
  const loaded = await settle();
  const meta = await page.evaluate(() => {
    // vramMB: the viewer's own estimate of its textures + render targets
    const g = window.gargantua;
    const gl = g.renderer.getContext();
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return { gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?", dims: g.layer.stats.dims, voxelMB: g.layer.stats.bytesGPU / 1e6, estimateMB: g.vramMB() };
  });
  const runs = {};
  for (const [name, patch] of Object.entries(STATES)) {
    // frame counts are computed here: page.evaluate bodies run in the browser and cannot see node variables
    const [nMove, nIdle] = quick ? [90, 45] : [180, 90];
    runs[name] = {
      interactive: await page.evaluate(([p, n]) => window.__gargantua.perf("interactive", n, p), [patch, nMove]),
      idle: await page.evaluate(([p, n]) => window.__gargantua.perf("idle", n, p), [patch, nIdle]),
    };
  }
  const res = { volume: basename(v), ...meta, viewport: [W, H], runs, vram_used_mb: { before, after_load: loaded, delta: loaded - before }, errors };
  rows.push(res);
  await page.close();
  await browser.close();
  const s = runs.smoke;
  console.log(`${basename(v)} ${meta.dims.join("x")}: smoke ${s.interactive.fpsFromWall.toFixed(0)} fps moving / ${s.idle.fpsFromWall.toFixed(0)} fps idle`
    + ` (timer ${s.idle.timerAgrees ? "agrees" : "DISAGREES"}), solid ${runs.solid.idle.fpsFromWall.toFixed(0)} fps, VRAM +${res.vram_used_mb.delta} MB${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
}
srv.close();
writeFileSync(join(OUT, `perf_${outName}_${W}x${H}.json`), JSON.stringify(rows, null, 1));
