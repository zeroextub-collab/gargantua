// Dev/preview server plugin: the browser hands a dropped video to the local Python pipeline and gets the
// built .gvol back. Localhost only (Vite's default host). No network access beyond this machine.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin, Connect } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const VOLUMES = join(ROOT, "work", "volumes");
const UPLOADS = join(ROOT, "work", "uploads");
const PYTHON = join(ROOT, "pipeline", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const MAX_UPLOAD = 6 * 1024 ** 3;

interface Job {
  id: string;
  events: string[];
  listeners: Set<ServerResponse>;
  done: boolean;
}
const jobs = new Map<string, Job>();

function headerOf(file: string): Record<string, unknown> | null {
  try {
    const fd = openSync(file, "r");
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    if (head.toString("latin1", 0, 4) !== "GVOL") return null;
    const len = head.readUInt32LE(8);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 12);
    closeSync(fd);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function slug(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "clip";
}

function push(job: Job, line: string) {
  job.events.push(line);
  for (const r of job.listeners) r.write(`data: ${line}\n\n`);
}

const handler: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/api/health") return json(res, 200, { ok: true, python: existsSync(PYTHON) });
  if (path === "/api/volumes") {
    if (!existsSync(VOLUMES)) return json(res, 200, []);
    const list = readdirSync(VOLUMES)
      .filter((f) => f.endsWith(".gvol"))
      .map((f) => {
        const full = join(VOLUMES, f);
        const h = headerOf(full) as { analysis?: { quality?: { grade?: string }; category?: string }; plan?: { frames?: number } } | null;
        return { name: f, url: `/volumes/${encodeURIComponent(f)}`, bytes: statSync(full).size, mtime: statSync(full).mtimeMs,
          quality: h?.analysis?.quality?.grade, category: h?.analysis?.category, frames: h?.plan?.frames };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, list);
  }
  if (path.startsWith("/volumes/")) {
    const name = decodeURIComponent(path.slice("/volumes/".length));
    if (!/^[\w.-]+\.gvol$/.test(name)) return json(res, 400, { error: "bad name" });
    const full = join(VOLUMES, name);
    if (!existsSync(full)) return json(res, 404, { error: "not found" });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(statSync(full).size));
    res.setHeader("Cache-Control", "no-store");
    return void createReadStream(full).pipe(res);
  }
  if (path === "/api/ingest" && req.method === "POST") {
    if (!existsSync(PYTHON)) return json(res, 503, { error: "pipeline venv not found (pipeline/.venv)" });
    const name = url.searchParams.get("name") ?? "clip.mp4";
    const ext = (name.match(/\.[a-zA-Z0-9]{1,5}$/)?.[0] ?? ".mp4").toLowerCase();
    const id = `${slug(name)}-${Date.now().toString(36)}`;
    mkdirSync(UPLOADS, { recursive: true });
    mkdirSync(VOLUMES, { recursive: true });
    const upload = join(UPLOADS, id + ext);
    const out = createWriteStream(upload);
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
      }
    });
    req.pipe(out);
    out.on("finish", () => {
      const job: Job = { id, events: [], listeners: new Set(), done: false };
      jobs.set(id, job);
      const args = ["-m", "gargantua", "build", upload, "-o", join(VOLUMES, `${id}.gvol`), "--json-progress"];
      const start = Number(url.searchParams.get("start") ?? 0);
      if (start > 0) args.push("--start", String(start));
      const tier = url.searchParams.get("tier");
      if (tier && /^(auto|S|M|L)$/.test(tier)) args.push("--tier", tier);
      const proc = spawn(PYTHON, args, { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
      let buf = "";
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith("{")) push(job, line);
        }
      });
      let err = "";
      proc.stderr.on("data", (d: Buffer) => (err += d.toString()).slice(-4000));
      proc.on("close", (code) => {
        job.done = true;
        if (code !== 0 && !job.events.some((e) => e.includes('"stage": "error"') || e.includes('"stage":"error"')))
          push(job, JSON.stringify({ stage: "error", message: `pipeline exited ${code}: ${err.split("\n").filter(Boolean).slice(-1)[0] ?? ""}` }));
        for (const r of job.listeners) r.end();
      });
      json(res, 200, { id });
    });
    out.on("error", () => json(res, 500, { error: "upload failed" }));
    return;
  }
  const m = path.match(/^\/api\/jobs\/([\w-]+)\/events$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: "no such job" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of job.events) res.write(`data: ${e}\n\n`);
    if (job.done) return void res.end();
    job.listeners.add(res);
    req.on("close", () => job.listeners.delete(res));
    return;
  }
  next();
};

export function gargantua(): Plugin {
  return {
    name: "gargantua-pipeline",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
