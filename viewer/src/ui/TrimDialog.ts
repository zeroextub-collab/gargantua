// Trim dialog: a dropped clip longer than 15 s gets a preview and a 15 s window slider (default: the first 15 s).
import { el } from "./controls.ts";
import { trimWindow } from "./trimWindow.ts";

const MAX = 15;

function readDuration(url: string): Promise<{ video: HTMLVideoElement; duration: number } | null> {
  const video = el("video", { muted: true, playsinline: true, preload: "auto", class: "trim-video" }) as HTMLVideoElement;
  video.muted = true;
  return new Promise((res) => {
    const t = setTimeout(() => res(null), 8000);
    video.onloadedmetadata = () => { clearTimeout(t); res(Number.isFinite(video.duration) ? { video, duration: video.duration } : null); };
    video.onerror = () => { clearTimeout(t); res(null); };
    video.src = url;
  });
}

const fmt = (s: number) => `${s.toFixed(1)} s`;

/**
 * Resolve the ingest start time for `file`: 0 for clips of up to 15 s; the user's choice for longer ones;
 * null if the user cancels. `previewable` is false when the browser cannot read the file's duration, in which
 * case the pipeline trims to the first 15 s on its own (CLI: --start).
 */
export async function askTrim(file: File): Promise<{ start: number | null; previewable: boolean; duration?: number }> {
  const url = URL.createObjectURL(file);
  const meta = await readDuration(url);
  if (!meta) {
    URL.revokeObjectURL(url);
    return { start: 0, previewable: false };
  }
  const { video, duration } = meta;
  if (!trimWindow(duration, 0, MAX).needsTrim) {
    URL.revokeObjectURL(url);
    return { start: 0, previewable: true, duration };
  }
  const max = trimWindow(duration, 0, MAX).maxStart;
  const range = el("input", { type: "range", min: 0, max: max.toFixed(1), step: 0.1, value: 0, "aria-label": "window start" }) as HTMLInputElement;
  const win = el("div", { class: "trim-win" });
  const label = el("span", { class: "trim-val" });
  const build = el("button", { class: "btn accent", type: "button", value: "build" }, "Build cube");
  const cancel = el("button", { class: "btn ghost", type: "button", value: "cancel" }, "Cancel");
  const dlg = el("dialog", { id: "trim", "aria-label": "Choose a 15 second window" },
    el("form", { method: "dialog", class: "card" },
      el("h2", {}, "Choose 15 seconds"),
      el("p", { class: "trim-note" }, `${file.name} runs ${fmt(duration)}. The cube holds at most ${MAX} s; slide the window to the part you want.`),
      video,
      el("div", { class: "trim-track" }, win),
      el("div", { class: "ctl slider" }, el("span", { class: "lbl" }, "window"), label, range),
      el("div", { class: "row" }, cancel, build))) as HTMLDialogElement;

  const update = () => {
    const w = trimWindow(duration, Number(range.value), MAX);
    label.textContent = `${fmt(w.start)} – ${fmt(w.end)}`;
    win.style.left = `${(w.start / duration) * 100}%`;
    win.style.width = `${((w.end - w.start) / duration) * 100}%`;
    range.style.setProperty("--fill", `${max ? (w.start / max) * 100 : 0}%`);
    if (Math.abs(video.currentTime - w.start) > 0.05) video.currentTime = w.start + 1e-3;
  };
  range.addEventListener("input", update);
  document.body.append(dlg);
  update();
  try {
    return await new Promise((res) => {
      build.addEventListener("click", () => { res({ start: trimWindow(duration, Number(range.value), MAX).start, previewable: true, duration }); dlg.close(); });
      cancel.addEventListener("click", () => { res({ start: null, previewable: true, duration }); dlg.close(); });
      dlg.addEventListener("cancel", () => res({ start: null, previewable: true, duration })); // Escape
      dlg.showModal();
      range.focus();
    });
  } finally {
    dlg.remove();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
