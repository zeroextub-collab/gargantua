// Render volumes at fixed poses for contact sheets: the reel's own timestamps (via the director) plus
// SEPARATED-mode and worldline views. One PNG per (volume, pose) in work/contact/<name>/<pose>.png.
//   node tools/bench/contact.mjs [--size 874x880] [--samples 32] name=path.gvol name2=path2.gvol ...
//   (no volume arguments: every .gvol in work/bench/volumes, work/bench/corpus and work/volumes)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, launch, openViewer, serve } from "../lib/serve.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const [W, H] = opt("size", "874x880").split("x").map(Number);
const SAMPLES = Number(opt("samples", 32));
let vols = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split("=")));
if (!Object.keys(vols).length) {
  for (const dir of ["work/bench/volumes", "work/bench/corpus", "work/volumes"]) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".gvol") && !f.includes("_S.")) vols[basename(f, ".gvol")] = join(d, f);
  }
}
// reel timestamps (docs/REEL_ANALYSIS.md timeline) + extra views
const POSES = [
  { name: "r00.0_solid", t: 0.0, patch: { worldlines: false } },
  { name: "r01.7_dissolve", t: 1.7, patch: { worldlines: false } },
  // the reel's own timestamps (an earlier version nudged these to 4.0 / 5.6 / 7.4 / 10.2, which hid a timing
  // mismatch in the director sequence)
  { name: "r03.8_topdown", t: 3.8, patch: { worldlines: false } },
  { name: "r05.4_headon", t: 5.4, patch: { worldlines: false } },
  { name: "r07.2_inside", t: 7.2, patch: { worldlines: false } },
  { name: "r10.3_back", t: 10.3, patch: { worldlines: false } },
  { name: "x_separated", t: 3.5, patch: { worldlines: false, sep: 1, tau: 1, plate: 0.25 } },
  { name: "x_worldlines", t: 3.5, patch: { worldlines: true, sep: 1, tau: 1, plate: 0.12, wlColor: "direction" } },
];
const srv = await serve(Object.fromEntries(Object.entries(vols).map(([k, v]) => [`${k}.gvol`, v])));
const browser = await launch();
const report = {};
for (const [name] of Object.entries(vols)) {
  const out = join(ROOT, "work", "contact", name);
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const { page, errors } = await openViewer(browser, srv.url, `${name}.gvol`, W, H);
  for (const p of POSES) {
    const url = await page.evaluate(([t, patch, s]) => window.__gargantua.directorSnapshot(t, patch, s), [p.t, p.patch, SAMPLES]);
    writeFileSync(join(out, `${p.name}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
  report[name] = { seconds: (Date.now() - t0) / 1000, errors };
  console.log(`${name}: ${POSES.length} poses in ${report[name].seconds.toFixed(1)} s${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
  await page.close();
}
await browser.close();
srv.close();
writeFileSync(join(ROOT, "work", "contact", "report.json"), JSON.stringify(report, null, 1));
