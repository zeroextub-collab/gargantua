import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGvol, GvolError } from "../src/io/gvol.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PY = join(ROOT, "pipeline", ".venv", "Scripts", "python.exe");

// Real bytes from the real Python writer, never a hand-made fixture.
function pythonGvol(): ArrayBuffer {
  const dir = mkdtempSync(join(tmpdir(), "gvol-"));
  const out = join(dir, "t.gvol");
  const code = [
    "import numpy as np, sys",
    "sys.path.insert(0, r'" + join(ROOT, "pipeline", "src") + "')",
    "from gargantua.pack import write_gvol",
    "v = np.arange(3*4*5*4, dtype=np.uint8).reshape(3,4,5,4)",
    "p = np.array([[0.25,0.5],[0.75,1.0]], np.float32)",
    "write_gvol(r'" + out + "', {'plan': {'frames': 3, 'width': 5, 'height': 4, 'fps': 30.0}, 'note': 'héllo'},",
    "           {'volume': v, 'track_points': p, 'track_len': np.array([2], np.uint32)})",
  ].join("\n");
  execFileSync(PY, ["-c", code]);
  const b = readFileSync(out);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test("parses header and typed sections written by the Python packer", () => {
  const g = parseGvol(pythonGvol());
  assert.equal(g.header.plan.frames, 3);
  assert.equal(g.header.note, "héllo");
  const vol = g.section("volume") as Uint8Array;
  assert.equal(vol.length, 3 * 4 * 5 * 4);
  assert.equal(vol[0], 0);
  assert.equal(vol[17], 17);
  const pts = g.section("track_points") as Float32Array;
  assert.deepEqual(Array.from(pts), [0.25, 0.5, 0.75, 1.0]);
  assert.equal((g.section("track_len") as Uint32Array)[0], 2);
  assert.equal(g.section("missing"), undefined);
});

test("rejects a buffer that is not a gvol", () => {
  const bad = new TextEncoder().encode("NOPE" + "\0".repeat(64)).buffer;
  assert.throws(() => parseGvol(bad as ArrayBuffer), GvolError);
});

test("rejects a truncated file whose sections run past the end", () => {
  const buf = pythonGvol();
  assert.throws(() => parseGvol(buf.slice(0, buf.byteLength - 40)), /truncated/);
});
