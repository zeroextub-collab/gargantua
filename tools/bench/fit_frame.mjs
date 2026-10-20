// node tools/bench/fit_frame.mjs  (needs the synthetic bench volumes: bench/run_bench.py)
// Grid-search the hero camera (distance factor x elevation) so the solid box's silhouette share of the
// 874x880 frame matches the reel at t = 0 (width 0.903, height 0.610, measured on work/p1/frames/f_0000.png).
import { launch, openViewer, serve, ROOT } from "../lib/serve.mjs";
import { join } from "node:path";
const srv = await serve({ "so.gvol": join(ROOT, "work", "bench", "volumes", "sparse_overhead.gvol") });
const browser = await launch();
const { page } = await openViewer(browser, srv.url, "so.gvol", 874, 880);
const target = { w: 0.903, h: 0.61 };
const rows = [];
for (const el of [12, 14, 16, 18, 20, 23]) {
  for (const k of [1.62, 1.68, 1.74, 1.8, 1.86, 1.92]) {
    const r = await page.evaluate(async ([el, k]) => {
      const g = window.gargantua;
      const [W, H, D] = g.box;
      const diag = Math.hypot(W, H, D);
      const url = await window.__gargantua.snapshot({ az: 34, el, dist: k * diag, target: [0, -0.02 * H, 0], fov: 35 }, { tau: 0, worldlines: false, guides: false }, 2);
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = url; });
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const colN = new Uint32Array(c.width), rowN = new Uint32Array(c.height);
      for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) {
        const i = (yy * c.width + xx) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 10) { colN[xx]++; rowN[yy]++; }
      }
      const ext = (a) => { let lo = -1, hi = -1; a.forEach((v, i) => { if (v > 2) { if (lo < 0) lo = i; hi = i; } }); return (hi - lo + 1) / a.length; };
      return { w: ext(colN), h: ext(rowN) };
    }, [el, k]);
    const err = Math.hypot(r.w - target.w, r.h - target.h);
    rows.push({ el, k, ...r, err });
  }
}
rows.sort((a, b) => a.err - b.err);
for (const r of rows.slice(0, 6)) console.log(`el ${r.el} k ${r.k}: w ${r.w.toFixed(3)} h ${r.h.toFixed(3)} err ${r.err.toFixed(3)}`);
await browser.close(); srv.close();
