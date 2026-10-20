// Reel Replica Test renders (P4): fixed views of the synthetic overhead crossing in REEL and SEPARATED mode.
//   node tools/bench/replica_render.mjs   -> work/replica/*.png (scored by tools/bench/replica_score.py)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, launch, openViewer, serve } from "../lib/serve.mjs";

const VOL = join(ROOT, "work", "bench", "volumes", "sparse_overhead.gvol");
const OUT = join(ROOT, "work", "replica");
mkdirSync(OUT, { recursive: true });
const srv = await serve({ "rep.gvol": VOL });
const browser = await launch();
const { page, errors } = await openViewer(browser, srv.url, "rep.gvol", 874, 880);
const quiet = { wire: false, guides: false, labels: false, worldlines: false, bloom: 0, grain: 0, vignette: 0, plate: 0, flicker: 0 };
const front0 = await page.evaluate(() => window.__gargantua.presetCam("front"));
// near-orthographic head-on camera (4 deg FOV, pulled back to keep the size): every time slice projects at the
// same scale, so the head-on smoke image registers exactly with the source frames
const front = { ...front0, fov: 4, dist: front0.dist * Math.tan((17.5 * Math.PI) / 180) / Math.tan((2 * Math.PI) / 180) };
const reel = await page.evaluate(() => window.__gargantua.presetCam("reel"));
const views = {
  headon_solid: [front, { tau: 0, sep: 0 }],
  headon_smoke: [front, { tau: 1, sep: 0 }],
  oblique_solid: [reel, { tau: 0, sep: 0 }],
  oblique_smoke: [reel, { tau: 1, sep: 0 }],
  dissolve_reel: [reel, { tau: 0.85, sep: 0 }],
  dissolve_separated: [reel, { tau: 0.85, sep: 1 }],
  dissolve_reel_display: [reel, { ...{}, tau: 0.85, sep: 0, wire: true, guides: true, guideOpacity: 1, bloom: 0.03, grain: 0.035, vignette: 0.35 }],
};
for (const [name, [cam, patch]] of Object.entries(views)) {
  const url = await page.evaluate(([c, p]) => window.__gargantua.snapshot(c, p, 48), [cam, { ...quiet, ...patch }]);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
}
await browser.close();
srv.close();
console.log(`wrote ${Object.keys(views).length} views to ${OUT}${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
