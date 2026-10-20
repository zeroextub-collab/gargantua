import { test } from "node:test";
import assert from "node:assert/strict";
import { trimWindow } from "../src/ui/trimWindow.ts";

test("clips up to 15 s (plus one frame of slack) are used whole, no dialog", () => {
  for (const d of [0.5, 9.309, 14.067, 15, 15.03]) {
    const w = trimWindow(d, 3);
    assert.equal(w.needsTrim, false, `duration ${d}`);
    assert.equal(w.start, 0);
    assert.equal(w.end, Math.min(d, 15)); // the pipeline caps at 15 s as well (ingest.plan_ingest)
  }
});

test("long clips get a 15 s window whose start is clamped to [0, duration - 15]", () => {
  const d = 42.3;
  assert.deepEqual(trimWindow(d, 0), { start: 0, end: 15, needsTrim: true, maxStart: d - 15 });
  const mid = trimWindow(d, 12.04);
  assert.equal(mid.start, 12);
  assert.equal(mid.end, 27);
  const late = trimWindow(d, 999);
  assert.ok(Math.abs(late.start - (d - 15)) < 1e-9, String(late.start));
  assert.ok(Math.abs(late.end - d) < 1e-9);
  assert.equal(trimWindow(d, -5).start, 0);
  assert.equal(trimWindow(d, Number.NaN).start, 0);
});

test("every window is exactly 15 s long and inside the clip", () => {
  for (const d of [15.5, 20, 33.33, 61.7]) {
    for (let s = -1; s <= d + 1; s += 0.37) {
      const w = trimWindow(d, s);
      assert.ok(w.start >= 0 && w.end <= d + 1e-9, `${d} ${s} -> ${w.start}-${w.end}`);
      assert.ok(Math.abs(w.end - w.start - 15) < 1e-9, `${d} ${s} -> length ${w.end - w.start}`);
    }
  }
});

test("an unreadable duration yields no trim and a zero window", () => {
  for (const d of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const w = trimWindow(d, 4);
    assert.equal(w.needsTrim, false);
    assert.equal(w.start, 0);
  }
});
