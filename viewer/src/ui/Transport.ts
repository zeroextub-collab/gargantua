import type { Store } from "../app/state.ts";
import { el } from "./controls.ts";

/** Bottom bar: playback cursor scrubber + director timeline with keyframe ticks. */
export class Transport {
  readonly root: HTMLElement;
  private store: Store;
  private scrub: HTMLInputElement;
  private time: HTMLElement;
  private play: HTMLButtonElement;
  private dirBar: HTMLElement;
  private dirHead: HTMLElement;
  private dirTime: HTMLElement;
  private dirPlay: HTMLButtonElement;
  duration = 1;
  fps = 30;
  directorDuration = 1;

  constructor(store: Store, onDirectorToggle: () => void, onDirectorSeek: (t: number) => void) {
    this.store = store;
    this.play = el("button", { class: "icon", type: "button", title: "Play / pause (Space)", "aria-label": "Play" }, "▶") as HTMLButtonElement;
    this.play.addEventListener("click", () => store.set({ playing: !store.params.playing, showCursor: true }));
    this.scrub = el("input", { type: "range", min: 0, max: 10000, step: 1, class: "scrub", "aria-label": "Time" }) as HTMLInputElement;
    this.scrub.addEventListener("input", () => store.set({ time: Number(this.scrub.value) / 10000, showCursor: true }));
    this.time = el("span", { class: "tc" });
    const speed = el("select", { "aria-label": "Playback speed", title: "Playback speed" },
      ...[0.25, 0.5, 1, 2].map((s) => el("option", { value: s, selected: s === 1 }, `${s}×`))) as HTMLSelectElement;
    speed.addEventListener("change", () => store.set({ speed: Number(speed.value) }));
    const reveal = el("button", { class: "toggle small", type: "button", title: "The cube grows as the clip plays" }, el("span", { class: "dot" }), "reveal") as HTMLButtonElement;
    reveal.addEventListener("click", () => store.set({ reveal: !store.params.reveal, showCursor: true }));

    this.dirPlay = el("button", { class: "icon accent", type: "button", title: "Play the reel sequence (D)" }, "▶") as HTMLButtonElement;
    this.dirPlay.addEventListener("click", onDirectorToggle);
    this.dirBar = el("div", { class: "dirbar", title: "Director timeline (click to seek)" });
    this.dirHead = el("div", { class: "head" });
    this.dirBar.append(this.dirHead);
    this.dirBar.addEventListener("pointerdown", (e) => {
      const r = this.dirBar.getBoundingClientRect();
      onDirectorSeek(((e.clientX - r.left) / r.width) * this.directorDuration);
    });
    this.dirTime = el("span", { class: "tc" });

    this.root = el("footer", { id: "transport" },
      el("div", { class: "lane" }, el("span", { class: "k" }, "clip"), this.play, this.scrub, this.time, speed, reveal),
      el("div", { class: "lane" }, el("span", { class: "k" }, "director"), this.dirPlay, this.dirBar, this.dirTime));
    store.on(() => this.refresh());
  }

  setKeys(times: number[], duration: number) {
    this.directorDuration = duration;
    this.dirBar.querySelectorAll(".tick").forEach((t) => t.remove());
    for (const t of times) {
      const tick = el("i", { class: "tick" });
      tick.style.left = `${(t / duration) * 100}%`;
      this.dirBar.append(tick);
    }
    this.refresh();
  }

  refresh() {
    const p = this.store.params;
    if (document.activeElement !== this.scrub) this.scrub.value = String(Math.round(p.time * 10000));
    this.scrub.style.setProperty("--fill", `${p.time * 100}%`);
    const t = p.time * this.duration;
    this.time.textContent = `${t.toFixed(2).padStart(5, "0")} / ${this.duration.toFixed(2)} s · f ${String(Math.round(p.time * (this.duration * this.fps - 1))).padStart(3, "0")}`;
    this.play.textContent = p.playing ? "❚❚" : "▶";
    this.play.setAttribute("aria-label", p.playing ? "Pause" : "Play");
    this.root.querySelector(".toggle.small")?.setAttribute("aria-pressed", String(p.reveal));
    this.dirHead.style.left = `${(p.directorTime / this.directorDuration) * 100}%`;
    this.dirTime.textContent = `${p.directorTime.toFixed(2).padStart(5, "0")} / ${this.directorDuration.toFixed(2)} s`;
    this.dirPlay.textContent = p.directorPlaying ? "❚❚" : "▶";
  }
}
