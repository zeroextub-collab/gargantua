// Minimal static server for the built viewer (viewer/dist) plus named .gvol files, for headless tools.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

export const ROOT = resolve(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "viewer", "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };

export function ensureBuilt() {
  if (!existsSync(join(DIST, "index.html"))) execFileSync("npm run build", { cwd: ROOT, stdio: "inherit", shell: true });
}

/** volumes: { "name.gvol": "abs/path.gvol" } -> served at /volumes/name.gvol */
export async function serve(volumes) {
  ensureBuilt();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"python":false}');
    if (url.pathname === "/api/volumes") return void res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
    if (url.pathname.startsWith("/volumes/")) {
      const p = volumes[decodeURIComponent(url.pathname.slice(9))];
      if (!p || !existsSync(p)) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(p).size });
      return void createReadStream(p).pipe(res);
    }
    const file = join(DIST, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export async function launch() {
  return chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"] });
}

/** Open the viewer on one volume at a fixed drawing-buffer size; resolves when the volume is on the GPU. */
export async function openViewer(browser, base, volName, w, h, extra = "") {
  const page = await browser.newPage({ viewport: { width: Math.min(w, 1600), height: Math.min(h, 1000) }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?vol=/volumes/${encodeURIComponent(volName)}&w=${w}&h=${h}${extra}`);
  await page.waitForFunction(() => window.gargantua?.layer, null, { timeout: 300000 });
  await page.evaluate(() => window.__gargantua.pause(true));
  return { page, errors };
}
