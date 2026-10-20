// Deterministic frame-by-frame export of the reel camera sequence through headless Chrome (Playwright) +
// ffmpeg (libx264, yuv420p). Each frame is rendered with a fixed number of jittered samples seeded by the
// frame index, read back as raw RGBA and piped into ffmpeg, so re-running gives the same pixels.
//
//   node tools/export/export.mjs --vol work/volumes/clip8.gvol --preset portrait --out work/export/clip8_portrait.mp4
//        [--fps 60] [--samples 12] [--size 1080x1920] [--audio input/Video_Project_8.mp4] [--check-determinism]
//        [--duration 30]   stretch the reel camera sequence to this many seconds (slower moves, same choreography)
//        [--clean]         the reel's own look for publishing: REEL mode, no worldlines, labels, camera path or cursor
//
// Presets: portrait = 1080x1920 (Instagram), 4k = 3840x2160. Needs `npm run build` output in viewer/dist
// (built automatically when missing). Prints ffprobe facts of the result.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const has = (k) => args.includes(`--${k}`);
const PRESETS = { portrait: [1080, 1920], "4k": [3840, 2160], "1080p": [1920, 1080] };
const preset = get("preset", "portrait");
const [W, H] = (get("size", null) ?? PRESETS[preset]?.join("x") ?? "1080x1920").split("x").map(Number);
const FPS = Number(get("fps", 60));
const SAMPLES = Number(get("samples", 12));
const vol = resolve(ROOT, get("vol", "work/volumes/clip8.gvol"));
const out = resolve(ROOT, get("out", `work/export/export_${W}x${H}.mp4`));
const audio = get("audio", null) ? resolve(ROOT, get("audio")) : null;
const limit = get("frames", null) ? Number(get("frames")) : null;
const duration = get("duration", null) ? Number(get("duration")) : null;
const CLEAN = { sep: 0, flicker: 0, worldlines: false, labels: false, cameraPath: false, showCursor: false, plate: 0 };
if (!existsSync(vol)) throw new Error(`volume not found: ${vol}`);
mkdirSync(dirname(out), { recursive: true });

const DIST = join(ROOT, "viewer", "dist");
if (!existsSync(join(DIST, "index.html")) || has("rebuild")) {
  console.log("[export] building the viewer (vite build)");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
}
const header = JSON.parse((() => {
  const b = readFileSync(vol).subarray(0, 1 << 20);
  return b.subarray(12, 12 + b.readUInt32LE(8)).toString("utf8");
})());

// ---- ffmpeg sink -----------------------------------------------------------------------------------
const ff = ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"];
if (audio) ff.push("-ss", String(header.plan?.start ?? 0), "-i", audio);
ff.push("-vf", "vflip", "-c:v", "libx264", "-preset", W * H > 4e6 ? "medium" : "slow", "-crf", "16", "-pix_fmt", "yuv420p",
  "-profile:v", "high", "-movflags", "+faststart");
if (audio) ff.push("-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k", "-shortest");
ff.push(out);
const enc = spawn("ffmpeg", ff, { stdio: ["pipe", "inherit", "inherit"] });
let frameBytes = 0;
const hashes = new Map();

// ---- static server + frame sink ----------------------------------------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/frame" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const buf = Buffer.concat(chunks);
      if (buf.length !== W * H * 4) {
        res.writeHead(400).end(`expected ${W * H * 4} bytes, got ${buf.length}`);
        return;
      }
      hashes.set(Number(url.searchParams.get("i")), createHash("sha1").update(buf).digest("hex"));
      if (!url.searchParams.has("probe")) {
        frameBytes += buf.length;
        if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
      }
      res.writeHead(200).end("ok");
    });
    return;
  }
  if (url.pathname === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"python":false}');
  // the viewer lists volumes when the health probe answers; a static host with no pipeline returns none
  if (url.pathname === "/api/volumes") return void res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  if (url.pathname === "/volumes/export.gvol") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(vol).size });
    return void createReadStream(vol).pipe(res);
  }
  const file = join(DIST, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const sink = `http://127.0.0.1:${port}/frame`;

// ---- render ------------------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`${m.type()}: ${m.text()}`));
page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`));
await page.goto(`http://127.0.0.1:${port}/?export=1&vol=/volumes/export.gvol&w=${W}&h=${H}`);
await page.waitForFunction(() => window.gargantua?.layer && window.gargantua?.director, null, { timeout: 300000 });
const gpu = await page.evaluate(() => {
  const gl = window.gargantua.renderer.getContext();
  const e = gl.getExtension("WEBGL_debug_renderer_info");
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?";
});
const dur = await page.evaluate(() => window.__gargantua.directorDuration());
// --duration stretches the whole director timeline: frame i shows the sequence at time (i / fps) / timeScale
const timeScale = duration ? duration / dur : 1;
if (has("clean")) await page.evaluate((p) => window.__gargantua.set(p), CLEAN);
// fail closed: a volume can fail to reach the GPU without any GL error (a 1.66 GB texture drew nothing at all),
// so render the solid opening pose once and require the cube to cover part of the frame
const renderCheck = await page.evaluate(() => window.__gargantua.directorLuma(0, {}, 2, 12));
if (!(renderCheck.frac > 0.02)) {
  console.error(`[export] the volume did not render (cube covers ${(renderCheck.frac * 100).toFixed(2)}% of the opening frame); rebuild it at a lower --tier`);
  process.exit(2);
}
const N = limit ?? Math.round(dur * timeScale * FPS) + 1;
console.log(`[export] ${N} frames ${W}x${H} @ ${FPS} fps, ${SAMPLES} samples/frame, on ${gpu}`);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  await page.evaluate(([i, fps, s, url, k]) => window.__gargantua.renderFrame(i, fps, s, url, k), [i, FPS, SAMPLES, sink, timeScale]);
  if (i % Math.max(1, Math.round(FPS)) === 0) process.stdout.write(`\r[export] frame ${i}/${N} (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
}
let determinism = null;
if (has("check-determinism")) {
  const k = Math.min(N - 1, Math.round(N * 0.47));
  const first = hashes.get(k);
  await page.evaluate(([i, fps, s, url, ts]) => window.__gargantua.renderFrame(i, fps, s, url, ts), [k, FPS, SAMPLES, `${sink}?probe=1`, timeScale]);
  determinism = { frame: k, first, second: hashes.get(k), identical: first === hashes.get(k) };
}
await browser.close();
enc.stdin.end();
await new Promise((r) => enc.on("close", r));
server.close();
const secs = (Date.now() - t0) / 1000;
console.log(`\n[export] rendered in ${secs.toFixed(1)} s (${(N / secs).toFixed(2)} frames/s)${errors.length ? ` PAGE ERRORS: ${errors.join(" | ")}` : ""}`);
const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames:format=duration,size",
  "-of", "json", out]).toString();
const decodeErrors = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
console.log(JSON.stringify({ out, frames_sent: N, bytes_piped: frameBytes, determinism, probe: JSON.parse(probe), decode_errors: decodeErrors || "none" }, null, 1));
