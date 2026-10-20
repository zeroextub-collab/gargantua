// Look Director: turns clip measurements + the reel target into renderer parameters.
import type { GvolHeader } from "../io/gvol.ts";

/** Constants measured from the reel (docs/REEL_ANALYSIS.md); tauTarget and the exposure are fitted by rendering
 *  the synthetic overhead crossing at the reel's framing (tools/bench/calibrate.mjs -> docs/evidence/p3/calibration.json). */
export const REEL = {
  depthRatio: 1.04, // D / W, mean of three PnP fits
  fovDeg: 35,
  tauTarget: 0.2791, // full-time-axis optical depth, linear-light blending; joint fit to two reel measurements at the reel's poses (top-down haze +2%, 1.7 s band -2%; calibration.json)
  exposure: 0.7565, // makes the solid front face reproduce the source frame's mean brightness
  smokeRatioTarget: 0.253, // displayed smoke / pavement luma at the measured pose
  sigmaSolidPerDepth: 900, // optical depth of the solid region per box depth: the first texel is opaque
  wireInset: 1.012, // the wire box sits slightly outside the content (8-10 px at reel framing)
  edgeSoftness: 0.05, // x min(W,H,D): small explicit fade; most of the reel's soft edge is geometric (short rays)
};

export function boxDims(aspect: number, depthRatio: number, size = 2): [number, number, number] {
  // the long side of the front face is `size`; depth is relative to the front-face width
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  return [w, h, depthRatio * w];
}

export function autoDensity(tauTarget: number, depth: number, meanField = 1): number {
  return tauTarget / (depth * Math.max(meanField, 1e-6));
}

/** Dark clips (night scenes) get a measured exposure lift so their smoke stays visible: the clip's median luma
 *  is pulled part-way toward the calibration scene's (0.45), at most 2.2x; ACES keeps the highlights. */
export function autoExposure(base: number, lumaP50: number | undefined): number {
  if (!lumaP50 || lumaP50 <= 0) return base;
  return base * Math.min(2.2, Math.max(1, Math.sqrt(0.45 / (lumaP50 / 255))));
}

export function evidenceGain(meanA: number): number {
  return Math.min(20, 1 / Math.max(meanA, 1e-6));
}

export type FlickerMode = 0 | 1 | 2; // keep | scenery | suppress

export interface LookParams {
  depthRatio: number;
  tauTarget: number;
  densityScale: number; // user multiplier on the auto density
  autoDensity: boolean;
  exposure: number;
  saturation: number;
  stretch: [number, number];
  emissiveLuma: number;
  emissiveGain: number;
  bloom: number;
  grain: number;
  vignette: number;
  sep: number;
  flicker: FlickerMode;
  worldlines: boolean;
  cameraPath: boolean;
}

const FLICKER: Record<string, FlickerMode> = { keep: 0, scenery: 1, suppress: 2 };

/** Night scenes: lights are small. When bright pixels cover more than ~3.5% of the frame (measured: the user's
 * night crossing 3.0%; a time-lapse with clipped sky 9.8%, Times Square billboards 10.3%) they are areas, not
 * light sources, and a full boost floods the bloom, so the boost falls in proportion. */
export function emissiveGainFor(emissiveFrac: number | undefined): number {
  return Math.min(1, 0.035 / Math.max(emissiveFrac ?? 0, 1e-4));
}

export function lookFromHeader(h: GvolHeader): LookParams {
  const look = h.look ?? {};
  const night = (h.analysis?.stats?.luma_p50 ?? 128) < 70;
  const d = look.preset_defaults ?? {};
  return {
    depthRatio: REEL.depthRatio,
    tauTarget: REEL.tauTarget,
    densityScale: 1,
    autoDensity: true,
    exposure: autoExposure(REEL.exposure, h.analysis?.stats?.luma_p50),
    saturation: 1.0,
    stretch: [look.stretch_black ?? 0, look.stretch_white ?? 1],
    emissiveLuma: look.emissive_luma ?? 0.92,
    // emissive boost + bloom only for night scenes, where the brightest pixels are light sources; in daylight
    // the brightest pixels are white paint and the reel shows no glow (docs/REEL_ANALYSIS.md, H4)
    emissiveGain: night ? emissiveGainFor(h.analysis?.stats?.emissive_frac) : 0,
    // the night exposure lift pushes plain white above the bloom threshold too, so bloom follows the same rule
    bloom: night ? Math.max(0.03, Math.min(d.bloom ?? 0.15, 0.25) * emissiveGainFor(h.analysis?.stats?.emissive_frac)) : 0.03,
    grain: 0.035,
    vignette: 0.35,
    sep: d.sep ?? 0,
    flicker: FLICKER[d.flicker ?? "keep"] ?? 0,
    worldlines: !!d.worldlines,
    cameraPath: !!d.camera_path,
  };
}
