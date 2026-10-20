// Render the director sequence at given times next to the reel's frames at the same times (10 fps frames in
// work/p1/frames, not committed). Writes work/contact/strip_<name>.jpg via tools/bench/compose_strip.py.
//   node tools/bench/director_strip.mjs [vol.gvol] [t1,t2,...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, launch, openViewer, serve } from "../lib/serve.mjs";

const VOL = process.argv[2] ?? join(ROOT, "work", "bench", "volumes", "sparse_overhead.gvol");
const TIMES = (process.argv[3] ?? "3.4,3.5,3.6,3.7,3.8,4.0,4.3,4.6,4.7,4.8,4.9,5.0").split(",").map(Number);
const OUT = join(ROOT, "work", "contact", "strip");
mkdirSync(OUT, { recursive: true });
const srv = await serve({ "s.gvol": VOL });
const browser = await launch();
const { page, errors } = await openViewer(browser, srv.url, "s.gvol", 874, 880);
for (const t of TIMES) {
  const url = await page.evaluate((t) => window.__gargantua.directorSnapshot(t, { worldlines: false }, 8), t);
  writeFileSync(join(OUT, `t${t.toFixed(1)}.png`), Buffer.from(url.split(",")[1], "base64"));
}
console.log(`${TIMES.length} frames${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
await browser.close();
srv.close();
