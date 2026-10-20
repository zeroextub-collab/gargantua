import type { Store } from "../app/state.ts";
import type { GvolHeader } from "../io/gvol.ts";
import { Binder, button, el, section } from "./controls.ts";

export interface PanelActions {
  cameraPreset(name: string): void;
  toggleDirector(): void;
  toggleFly(): void;
  savePreset(): void;
  loadPreset(): void;
  resetLook(): void;
  openFile(): void;
  loadVolume(url: string): void;
}

export interface PerfReadout {
  fps: number;
  gpuMs: number;
  res: string;
  steps: number;
  vramMB: number;
  mode: string;
}

export class Panel {
  readonly root: HTMLElement;
  private clip: HTMLElement;
  private perf: HTMLElement;
  private volumes: HTMLSelectElement;
  readonly bind: Binder;

  constructor(store: Store, a: PanelActions) {
    const b = (this.bind = new Binder(store));
    const p = store.params;
    this.clip = el("div", { class: "clip" }, el("p", { class: "muted" }, "No volume loaded."));
    this.perf = el("dl", { class: "perf" });
    this.volumes = el("select", { "aria-label": "Built volumes" }) as HTMLSelectElement;
    this.volumes.addEventListener("change", () => this.volumes.value && a.loadVolume(this.volumes.value));

    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.root = el(
      "aside",
      { id: "panel", "aria-label": "Controls" },
      section("Clip", true, this.clip, el("div", { class: "row" }, this.volumes, button("Open…", a.openFile, "btn ghost", "Load a video or .gvol (or drop it anywhere)"))),
      section(
        "Mode",
        true,
        b.segmented("Mode", [
          { value: "reel", label: "REEL", hint: "Raw video colour as a low-opacity volume (the reel look)" },
          { value: "sep", label: "SEPARATED", hint: "Moving things isolated from the static background" },
        ], () => (p.sep >= 0.5 ? "sep" : "reel"), (v) => store.set({ sep: v === "sep" ? 1 : 0 })),
        b.slider({ label: "Raw ↔ separated", key: "sep", min: 0, max: 1, fmt: pct, hint: "Blend the raw colour volume into the evidence field" }),
        b.segmented("Screens", [
          { value: 0, label: "keep", hint: "Animated screens stay as streaks" },
          { value: 1, label: "scenery", hint: "Treat animated screens as background" },
          { value: 2, label: "suppress", hint: "Remove animated screens" },
        ], () => p.flicker, (v) => store.set({ flicker: v as 0 | 1 | 2 })),
      ),
      section(
        "Density",
        true,
        el("div", { class: "row" },
          button("Solid", () => store.set({ tau: 0 }), "btn", "All voxels solid (T)"),
          button("Smoke", () => store.set({ tau: 1 }), "btn", "All voxels smoke (T)"),
          button("Cut", () => store.set({ tau: 0.85 }), "btn", "Smoke before the cut, solid after (the reel's dissolve)")),
        b.slider({ label: "Threshold τ", key: "tau", min: 0, max: 1, fmt: (v) => `${(v * 100).toFixed(0)}% of clip`, hint: "Time threshold: solid on one side, smoke on the other" }),
        b.segmented("Solid part", [
          { value: 1, label: "later", hint: "Voxels after τ are solid (reel)" },
          { value: -1, label: "earlier", hint: "Voxels before τ are solid" },
        ], () => p.tauDir, (v) => store.set({ tauDir: v as 1 | -1 })),
        b.slider({ label: "Smoke density", key: "densityScale", min: 0.1, max: 10, log: true, fmt: (v) => `×${v.toFixed(2)}`, hint: "Multiplier on the auto density ([ / ])" }),
        b.toggle("Auto density", "autoDensity", "Match the reel's measured optical depth"),
      ),
      section(
        "Layers",
        true,
        el("div", { class: "toggles" },
          b.toggle("Smoke", "smoke", undefined, "S"),
          b.toggle("Worldlines", "worldlines", undefined, "W"),
          b.toggle("Wireframe", "wire", undefined, "B"),
          b.toggle("Guides", "guides", "Slice frame at the threshold (the reel's guide lines)", "G"),
          b.toggle("Labels", "labels", undefined, "L"),
          b.toggle("Camera path", "cameraPath", "Camera motion drawn as a worldline (hand-held clips)")),
        b.slider({ label: "Context plate", key: "plate", min: 0, max: 1, fmt: pct, hint: "Background image behind the volume (P)" }),
        b.segmented("Line colour", [
          { value: "direction", label: "direction" },
          { value: "speed", label: "speed" },
          { value: "sampled", label: "colour" },
        ], () => p.wlColor, (v) => store.set({ wlColor: v })),
        b.slider({ label: "Line count", key: "wlCount", min: 10, max: 1500, step: 1, log: true, fmt: (v) => String(Math.round(v)) }),
        b.toggle("Trail window", "wlWindow", "Only show the last second of worldlines behind the playback cursor"),
      ),
      section(
        "Look",
        false,
        b.slider({ label: "Exposure", key: "exposure", min: 0.2, max: 3, log: true, fmt: (v) => v.toFixed(2) }),
        b.slider({ label: "Saturation", key: "saturation", min: 0, max: 2, fmt: (v) => v.toFixed(2) }),
        b.slider({ label: "Glow", key: "bloom", min: 0, max: 2, fmt: (v) => v.toFixed(2) }),
        b.slider({ label: "Emissive", key: "emissiveGain", min: 0, max: 6, fmt: (v) => v.toFixed(1), hint: "How much bright pixels feed the glow" }),
        b.slider({ label: "Grain", key: "grain", min: 0, max: 0.15, fmt: (v) => v.toFixed(3) }),
        b.slider({ label: "Vignette", key: "vignette", min: 0, max: 1, fmt: (v) => v.toFixed(2) }),
        b.slider({ label: "Box depth", key: "depthRatio", min: 0.4, max: 2, fmt: (v) => `${v.toFixed(2)} × width`, hint: "Time-axis length (reel: 1.04)" }),
        el("div", { class: "row" }, button("Save preset", a.savePreset), button("Load preset", a.loadPreset), button("Auto", a.resetLook, "btn ghost", "Back to the Look Director's choice")),
      ),
      section(
        "Camera",
        false,
        el("div", { class: "grid3" }, ...["reel", "front", "side", "top", "back", "inside"].map((n, i) => button(`${i + 1} ${n}`, () => a.cameraPreset(n), "btn"))),
        el("div", { class: "row" }, button("▶ Reel sequence", a.toggleDirector, "btn accent", "Play the reel's camera sequence (D)"), button("Fly", a.toggleFly, "btn ghost", "Free fly: WASD + mouse, Esc to exit (F)")),
      ),
      section("Performance", false, this.perf),
    );
  }

  setVolumes(list: { name: string; url: string; quality?: string }[], current?: string) {
    this.volumes.replaceChildren(el("option", { value: "" }, list.length ? "Built volumes…" : "No built volumes"),
      ...list.map((v) => el("option", { value: v.url, selected: v.url === current }, `${v.name}${v.quality ? ` · ${v.quality}` : ""}`)));
  }

  setClip(h: GvolHeader, name: string) {
    const q = h.analysis?.quality ?? { grade: "—", reasons: [] };
    const plan = h.plan;
    const grade = String(q.grade);
    const kids: (Node | null)[] = [
      el("div", { class: `grade g-${grade.toLowerCase()}` }, el("span", { class: "k" }, "Clip quality"), el("strong", {}, grade)),
      el("ul", { class: "reasons" }, ...q.reasons.map((r: string) => el("li", {}, r))),
      el("dl", { class: "facts" },
        el("dt", {}, "file"), el("dd", {}, name),
        el("dt", {}, "volume"), el("dd", {}, `${plan.width}×${plan.height}×${plan.frames} · tier ${plan.tier}`),
        el("dt", {}, "rate"), el("dd", {}, `${plan.fps.toFixed(3).replace(/\.?0+$/, "")} fps · ${plan.duration.toFixed(2)} s`),
        el("dt", {}, "category"), el("dd", {}, `${h.analysis?.category ?? "—"}${h.analysis?.tags?.length > 1 ? ` (+${h.analysis.tags.slice(1).join(", ")})` : ""}`),
        el("dt", {}, "camera"), el("dd", {}, `${h.camera?.class ?? "—"}${h.camera?.stabilization?.applied ? " · stabilised" : ""}`)),
      plan.notes?.length ? el("details", { class: "notes" }, el("summary", {}, `${plan.notes.length} ingest note(s)`), el("ul", {}, ...plan.notes.map((n: string) => el("li", {}, n)))) : null,
    ];
    this.clip.replaceChildren(...kids.filter((k): k is Node => k !== null));
  }

  setPerf(p: PerfReadout) {
    const rows: [string, string][] = [
      ["frame rate", `${p.fps.toFixed(0)} fps`],
      ["volume pass", p.gpuMs > 0 ? `${p.gpuMs.toFixed(2)} ms GPU` : "n/a"],
      ["render size", p.res],
      ["max steps/ray", String(p.steps)],
      ["VRAM (est.)", `${p.vramMB.toFixed(0)} MB`],
      ["quality", p.mode],
    ];
    this.perf.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  }
}
