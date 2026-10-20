// Pure trim arithmetic for clips longer than the 15 s cube limit (kept DOM-free so node --test can cover it).

export interface TrimWindow {
  start: number;
  end: number;
  needsTrim: boolean;
  maxStart: number;
}

/** The [start, end) window GARGANTUA will ingest. Clips up to `max` (+ one frame of slack) are used whole. */
export function trimWindow(duration: number, start: number, max = 15): TrimWindow {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const needsTrim = d > max + 1 / 30;
  const maxStart = needsTrim ? Math.max(0, d - max) : 0;
  const s = Math.min(maxStart, Math.max(0, Number.isFinite(start) ? start : 0));
  const snapped = Math.round(s * 10) / 10; // the slider and the pipeline both work in 0.1 s steps
  const st = Math.min(maxStart, snapped);
  return { start: st, end: Math.min(d, st + max), needsTrim, maxStart };
}
