// Loading: .gvol over HTTP (streamed into one preallocated buffer, with progress), local files, and video
// ingest through the dev server's Python pipeline (upload + server-sent progress events).
import { parseGvol, type Gvol } from "./gvol.ts";

export type Progress = (fraction: number, label: string) => void;

export async function fetchGvol(url: string, onProgress: Progress): Promise<Gvol> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  if (!res.body || !total) return parseGvol(await res.arrayBuffer());
  const buf = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.byteLength;
    onProgress(got / total, `loading volume ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
  }
  return parseGvol(buf.buffer);
}

export async function readFileGvol(file: File, onProgress: Progress): Promise<Gvol> {
  const buf = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.byteLength;
    onProgress(got / file.size, `reading ${file.name}`);
  }
  return parseGvol(buf.buffer);
}

export interface ServerInfo {
  ok: boolean;
  python: boolean;
}

export async function serverInfo(): Promise<ServerInfo | null> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok ? ((await r.json()) as ServerInfo) : null;
  } catch {
    return null;
  }
}

export interface VolumeEntry {
  name: string;
  url: string;
  bytes: number;
  quality?: string;
  category?: string;
  frames?: number;
}

export async function listVolumes(): Promise<VolumeEntry[]> {
  try {
    const r = await fetch("/api/volumes", { cache: "no-store" });
    return r.ok ? ((await r.json()) as VolumeEntry[]) : [];
  } catch {
    return [];
  }
}

export interface IngestOptions {
  start?: number;
  tier?: string;
}

/** Upload a video to the local pipeline; resolves with the URL of the built .gvol. */
export function ingestOnServer(file: File, opts: IngestOptions, onProgress: Progress): Promise<string> {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: file.name, start: String(opts.start ?? 0), tier: opts.tier ?? "auto" });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/ingest?${q}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((0.15 * e.loaded) / e.total, `uploading ${file.name}`);
    xhr.onerror = () => reject(new Error("upload failed (is the dev server running?)"));
    xhr.onload = () => {
      if (xhr.status !== 200) return reject(new Error(`ingest refused: ${xhr.responseText}`));
      const { id } = JSON.parse(xhr.responseText) as { id: string };
      const es = new EventSource(`/api/jobs/${id}/events`);
      const weights: Record<string, [number, number]> = {
        probe: [0.15, 0.17], plan: [0.17, 0.18], decode: [0.18, 0.28], camera: [0.28, 0.33], analyze: [0.33, 0.38],
        background: [0.38, 0.7], motion: [0.7, 0.8], evidence: [0.8, 0.88], worldlines: [0.88, 0.95], pack: [0.95, 0.99],
      };
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as { stage: string; progress?: number; msg?: string; message?: string; out?: string };
        if (ev.stage === "error") {
          es.close();
          reject(new Error(ev.message || "pipeline error"));
        } else if (ev.stage === "done") {
          es.close();
          resolve(`/volumes/${id}.gvol`);
        } else {
          const [a, b] = weights[ev.stage] ?? [0.15, 0.99];
          onProgress(a + (b - a) * (ev.progress ?? 0), ev.msg || ev.stage);
        }
      };
      es.onerror = () => {
        es.close();
        reject(new Error("lost connection to the pipeline job"));
      };
    };
    xhr.send(file);
  });
}
