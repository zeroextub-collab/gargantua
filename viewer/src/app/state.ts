// Single source of truth for every user-facing parameter. Panels, shortcuts, the director and presets all
// write here; the render loop reads from here.
import type { WorldlineColor } from "../render/Worldlines.ts";

export interface Params {
  // mode
  sep: number; // RAW (0) <-> SEPARATED (1)
  flicker: 0 | 1 | 2; // keep | scenery | suppress
  // density
  autoDensity: boolean;
  densityScale: number;
  tau: number; // time threshold
  tauDir: 1 | -1; // 1: later part solid (reel); -1: earlier part solid
  // layers
  smoke: boolean;
  worldlines: boolean;
  wire: boolean;
  guides: boolean;
  labels: boolean;
  plate: number; // context plate opacity
  cameraPath: boolean;
  wlColor: WorldlineColor;
  wlCount: number;
  wlWindow: boolean; // only show worldlines near the playback cursor
  // look
  exposure: number;
  saturation: number;
  bloom: number;
  grain: number;
  vignette: number;
  depthRatio: number;
  emissiveGain: number;
  edgeSoft: number; // explicit smoke fade near the faces, fraction of the smallest box side
  displayBlend: boolean; // composite in display space (the reel's measured behaviour) or linear light
  // playback
  playing: boolean;
  speed: number;
  time: number; // 0..1 playback cursor
  reveal: boolean; // cube grows with playback
  showCursor: boolean;
  // director
  directorPlaying: boolean;
  directorTime: number;
  guideOpacity: number; // driven by the director's "guides" channel
}

export const DEFAULTS: Params = {
  sep: 0,
  flicker: 0,
  autoDensity: true,
  densityScale: 1,
  tau: 0,
  tauDir: 1,
  smoke: true,
  worldlines: false,
  wire: true,
  guides: true,
  labels: false,
  plate: 0,
  cameraPath: false,
  wlColor: "direction",
  wlCount: 1500,
  wlWindow: false,
  exposure: 0.7565, // fitted: docs/evidence/p3/calibration.json
  saturation: 1,
  bloom: 0.15,
  grain: 0.035,
  vignette: 0.35,
  depthRatio: 1.04,
  emissiveGain: 1.0,
  edgeSoft: 0.05,
  displayBlend: false, // linear light: fits the reel better than display-space blending (docs/REEL_ANALYSIS.md s.8)
  playing: false,
  speed: 1,
  time: 0,
  reveal: false,
  showCursor: false,
  directorPlaying: false,
  directorTime: 0,
  guideOpacity: 0,
};

/** Parameters that only affect UI/timing, not the rendered image (no accumulation reset). */
const UI_ONLY = new Set<keyof Params>(["playing", "speed", "directorPlaying"]);

/** Parameters saved in a look preset. */
export const PRESET_KEYS: (keyof Params)[] = [
  "sep", "flicker", "autoDensity", "densityScale", "tau", "tauDir", "smoke", "worldlines", "wire", "guides", "labels",
  "plate", "cameraPath", "wlColor", "wlCount", "wlWindow", "exposure", "saturation", "bloom", "grain", "vignette",
  "depthRatio", "emissiveGain", "edgeSoft", "displayBlend",
];

type Listener = (changed: Set<keyof Params>, source: string) => void;

export class Store {
  params: Params = { ...DEFAULTS };
  private listeners: Listener[] = [];
  version = 0; // bumps on any visual change

  set(patch: Partial<Params>, source = "ui") {
    const changed = new Set<keyof Params>();
    for (const [k, v] of Object.entries(patch) as [keyof Params, unknown][]) {
      if (this.params[k] !== v) {
        (this.params as unknown as Record<string, unknown>)[k] = v;
        changed.add(k);
      }
    }
    if (!changed.size) return;
    if ([...changed].some((k) => !UI_ONLY.has(k))) this.version++;
    for (const l of this.listeners) l(changed, source);
  }

  on(l: Listener) {
    this.listeners.push(l);
  }

  preset(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of PRESET_KEYS) out[k] = this.params[k];
    return out;
  }

  applyPreset(p: Record<string, unknown>) {
    const patch: Partial<Params> = {};
    for (const k of PRESET_KEYS) if (k in p) (patch as Record<string, unknown>)[k] = p[k];
    this.set(patch, "preset");
  }
}
