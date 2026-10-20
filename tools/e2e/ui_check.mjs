// UI check: every control is exercised in the built viewer and its effect asserted on the app state.
//   node tools/e2e/ui_check.mjs [volume.gvol]
// Writes work/e2e/report.json and screenshots work/e2e/*.png. Exit code 1 if any check fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, launch, serve } from "../lib/serve.mjs";

const VOL = process.argv[2] ?? join(ROOT, "work", "bench", "volumes", "sparse_overhead.gvol");
const OUT = join(ROOT, "work", "e2e");
mkdirSync(OUT, { recursive: true });
const srv = await serve({ "ui.gvol": VOL });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${srv.url}/?vol=/volumes/ui.gvol`);
await page.waitForFunction(() => window.gargantua?.layer, null, { timeout: 120000 });
await page.waitForTimeout(800);

const results = [];
const P = () => page.evaluate(() => ({ ...window.gargantua.store.params }));
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.message ?? e) });
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const shot = (n) => page.screenshot({ path: join(OUT, `${n}.png`) });
await shot("01_loaded");

// ---- panel toggles ----------------------------------------------------------------------------------------
const toggles = { Smoke: "smoke", Worldlines: "worldlines", Wireframe: "wire", Guides: "guides", Labels: "labels", "Camera path": "cameraPath",
  "Auto density": "autoDensity", "Trail window": "wlWindow" };
await page.evaluate(() => document.querySelectorAll("details.sec").forEach((d) => (d.open = true)));
for (const [label, key] of Object.entries(toggles)) {
  await check(`toggle: ${label}`, async () => {
    const before = (await P())[key];
    await page.locator("#panel button.toggle", { hasText: label }).first().click();
    const after = (await P())[key];
    expect(after === !before, `${key}: ${before} -> ${after}`);
    await page.locator("#panel button.toggle", { hasText: label }).first().click();
    return `${key} ${before} -> ${after} -> ${(await P())[key]}`;
  });
}
// ---- segmented controls -----------------------------------------------------------------------------------
const segs = [["SEPARATED", "sep", 1], ["REEL", "sep", 0], ["scenery", "flicker", 1], ["suppress", "flicker", 2], ["keep", "flicker", 0],
  ["earlier", "tauDir", -1], ["later", "tauDir", 1], ["speed", "wlColor", "speed"], ["colour", "wlColor", "sampled"], ["direction", "wlColor", "direction"]];
for (const [label, key, val] of segs) {
  await check(`segmented: ${label}`, async () => {
    await page.locator("#panel .seg button", { hasText: new RegExp(`^${label}$`) }).first().click();
    const v = (await P())[key];
    expect(v === val, `${key} = ${v}, expected ${val}`);
    return `${key} = ${v}`;
  });
}
// ---- buttons ----------------------------------------------------------------------------------------------
for (const [label, tau] of [["Solid", 0], ["Smoke", 1], ["Cut", 0.85]]) {
  await check(`button: ${label}`, async () => {
    await page.locator("#panel .btn", { hasText: new RegExp(`^${label}$`) }).first().click();
    const v = (await P()).tau;
    expect(Math.abs(v - tau) < 1e-9, `tau = ${v}`);
    return `tau = ${v}`;
  });
}
await shot("02_cut_state");
// ---- sliders (set through the real input element) ----------------------------------------------------------
const sliders = ["Raw ↔ separated", "Threshold τ", "Smoke density", "Context plate", "Line count", "Exposure", "Saturation", "Glow", "Emissive", "Grain", "Vignette", "Box depth"];
for (const label of sliders) {
  await check(`slider: ${label}`, async () => {
    const before = await P();
    const changed = await page.evaluate((lbl) => {
      const row = [...document.querySelectorAll("#panel label.slider")].find((r) => r.querySelector(".lbl")?.textContent === lbl);
      if (!row) return null;
      const input = row.querySelector("input");
      input.value = String(Number(input.value) > 500 ? 200 : 800);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return row.querySelector(".val").textContent;
    }, label);
    expect(changed !== null, "slider not found");
    const after = await P();
    const diff = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    expect(diff.length > 0, "no parameter changed");
    return `${diff.join(",")} -> ${changed}`;
  });
}
await page.locator("#panel .btn", { hasText: "Auto" }).first().click(); // back to the Look Director's choice
// ---- camera presets -----------------------------------------------------------------------------------------
for (const [i, name] of ["reel", "front", "side", "top", "back", "inside"].entries()) {
  await check(`camera preset ${i + 1} ${name}`, async () => {
    const before = await page.evaluate(() => window.gargantua.camera.position.toArray());
    await page.locator("#panel .grid3 .btn").nth(i).click();
    await page.waitForTimeout(1300);
    const after = await page.evaluate(() => window.gargantua.camera.position.toArray());
    const moved = Math.hypot(...after.map((v, k) => v - before[k]));
    expect(i === 0 || moved > 0.05, `camera moved ${moved.toFixed(3)}`);
    return `moved ${moved.toFixed(2)}`;
  });
}
await shot("03_inside_preset");
// ---- director -----------------------------------------------------------------------------------------------
await check("director: play from transport", async () => {
  await page.locator("#transport .icon.accent").click();
  await page.waitForTimeout(1500);
  const p = await P();
  expect(p.directorPlaying && p.directorTime > 0.5, `playing ${p.directorPlaying} t=${p.directorTime}`);
  await page.locator("#transport .icon.accent").click();
  return `t = ${p.directorTime.toFixed(2)} s`;
});
await check("director: seek on the timeline", async () => {
  const bar = page.locator("#transport .dirbar");
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  const p = await P();
  expect(p.directorTime > 0.5 * 11 && p.directorTime < 0.7 * 11.3, `t=${p.directorTime}`);
  return `t = ${p.directorTime.toFixed(2)} s, tau ${p.tau.toFixed(2)}`;
});
await shot("04_director_seek");
// ---- transport ----------------------------------------------------------------------------------------------
await check("transport: scrub", async () => {
  await page.evaluate(() => {
    const s = document.querySelector("#transport .scrub");
    s.value = "5000";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const p = await P();
  expect(Math.abs(p.time - 0.5) < 1e-6 && p.showCursor, `time ${p.time}`);
  return `time ${p.time}`;
});
await check("transport: play/pause", async () => {
  await page.locator("#transport .lane").first().locator(".icon").click();
  await page.waitForTimeout(600);
  const p = await P();
  await page.locator("#transport .lane").first().locator(".icon").click();
  expect(p.playing && p.time !== 0.5, `playing ${p.playing} time ${p.time}`);
  return `time advanced to ${p.time.toFixed(3)}`;
});
await check("transport: speed", async () => {
  await page.locator("#transport select").selectOption("2");
  const p = await P();
  expect(p.speed === 2, `speed ${p.speed}`);
  return "2x";
});
await check("transport: reveal", async () => {
  const b = (await P()).reveal;
  await page.locator("#transport .toggle.small").click();
  expect((await P()).reveal === !b, "reveal did not toggle");
  return `reveal ${!b}`;
});
await shot("05_reveal_cursor");
// ---- keyboard shortcuts -------------------------------------------------------------------------------------
await page.mouse.click(500, 400); // focus the canvas (stops the director)
const keys = [["m", "sep"], ["s", "smoke"], ["w", "worldlines"], ["b", "wire"], ["g", "guides"], ["l", "labels"], ["p", "plate"], ["t", "tau"], ["]", "densityScale"], ["[", "densityScale"], [" ", "playing"], ["ArrowRight", "time"]];
for (const [k, key] of keys) {
  await check(`shortcut: ${k === " " ? "Space" : k}`, async () => {
    const before = (await P())[key];
    await page.keyboard.press(k === " " ? "Space" : k);
    const after = (await P())[key];
    expect(JSON.stringify(after) !== JSON.stringify(before), `${key} unchanged (${before})`);
    return `${key}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
  });
}
await page.keyboard.press("Space"); // stop playback again
await check("shortcut: D (director)", async () => {
  await page.keyboard.press("d");
  const on = (await P()).directorPlaying;
  await page.keyboard.press("d");
  expect(on, "director did not start");
  return "toggled";
});
await check("shortcut: 1-6 camera presets", async () => {
  await page.keyboard.press("3");
  await page.waitForTimeout(1100);
  const c = await page.evaluate(() => window.gargantua.currentCam());
  expect(Math.abs(((c.az % 360) + 360) % 360 - 90) < 2, `az ${c.az}`);
  return `side view az ${c.az.toFixed(1)}`;
});
await check("shortcut: H hides the interface", async () => {
  await page.keyboard.press("h");
  const hidden = await page.evaluate(() => document.body.classList.contains("ui-hidden"));
  await shot("06_ui_hidden");
  await page.keyboard.press("h");
  expect(hidden, "ui-hidden not set");
  return "hidden and restored";
});
await check("shortcut: ? help overlay", async () => {
  await page.keyboard.press("?");
  const on = await page.evaluate(() => document.getElementById("help").classList.contains("on"));
  await shot("07_help");
  await page.keyboard.press("Escape");
  expect(on, "help not shown");
  return "shown and closed";
});
// ---- fly mode (headless refuses pointer lock, so this exercises the drag-to-look fallback) -------------------
await check("fly mode: F enters, held W moves, drag turns, Esc exits", async () => {
  await page.mouse.click(500, 400);
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  const mode = await page.evaluate(() => window.gargantua.fly.mode);
  expect(mode === "drag" || mode === "locked", `mode ${mode}`);
  const p0 = await page.evaluate(() => window.gargantua.camera.position.toArray());
  const q0 = await page.evaluate(() => window.gargantua.camera.quaternion.toArray());
  const wl0 = (await P()).worldlines;
  await page.keyboard.down("w");
  await page.waitForTimeout(1200);
  await page.keyboard.up("w");
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(620, 380, { steps: 10 });
  await page.mouse.up();
  const p1 = await page.evaluate(() => window.gargantua.camera.position.toArray());
  const q1 = await page.evaluate(() => window.gargantua.camera.quaternion.toArray());
  const moved = Math.hypot(...p1.map((v, k) => v - p0[k]));
  const turned = Math.hypot(...q1.map((v, k) => v - q0[k]));
  expect((await P()).worldlines === wl0, "W toggled worldlines while flying");
  await page.keyboard.press("Escape");
  const after = await page.evaluate(() => ({ mode: window.gargantua.fly.mode, orbit: window.gargantua.controls.enabled }));
  expect(moved > 0.3 && turned > 0.02 && after.mode === "off" && after.orbit, `moved ${moved} turned ${turned} ${JSON.stringify(after)}`);
  return `mode ${mode}, moved ${moved.toFixed(2)}, turned ${turned.toFixed(3)}, exited`;
});
// ---- presets: save (download) and load (file chooser + drag-and-drop handler) -------------------------------
await check("preset: save downloads JSON", async () => {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#panel .btn", { hasText: "Save preset" }).click()]);
  const path = join(OUT, "saved.preset.json");
  await dl.saveAs(path);
  const j = JSON.parse((await import("node:fs")).readFileSync(path, "utf8"));
  expect(j.gargantua_preset === 1 && "tau" in j.params, "bad preset file");
  return `${Object.keys(j.params).length} params`;
});
await check("preset: load through the file chooser", async () => {
  const preset = join(OUT, "load.preset.json");
  writeFileSync(preset, JSON.stringify({ gargantua_preset: 1, params: { tau: 0.42, sep: 0.73, exposure: 1.3 } }));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#panel .btn", { hasText: "Load preset" }).click()]);
  await chooser.setFiles(preset);
  await page.waitForTimeout(400);
  const p = await P();
  expect(Math.abs(p.tau - 0.42) < 1e-9 && Math.abs(p.sep - 0.73) < 1e-9, `tau ${p.tau} sep ${p.sep}`);
  return "tau 0.42, sep 0.73 applied";
});
await check("drag-and-drop handler", async () => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify({ params: { tau: 0.66 } })], "drop.preset.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt }));
  });
  await page.waitForTimeout(400);
  const p = await P();
  expect(Math.abs(p.tau - 0.66) < 1e-9, `tau ${p.tau}`);
  return "dropped preset applied";
});
// ---- compositing regression: worldlines once wiped the cube (autoClear cleared the composite target) ---------
await check("worldlines on keeps the volume visible (cube pixel share unchanged within 10%)", async () => {
  const fresh = await ctx.newPage(); // default state: earlier checks changed presets and layers on the main page
  try {
    await fresh.goto(`${srv.url}/?vol=/volumes/ui.gvol`);
    await fresh.waitForFunction(() => window.gargantua?.layer, null, { timeout: 120000 });
    const off = await fresh.evaluate(() => window.__gargantua.directorLuma(0, { worldlines: false }, 4, 12));
    const on = await fresh.evaluate(() => window.__gargantua.directorLuma(0, { worldlines: true }, 4, 12));
    expect(off.frac > 0.05, `cube not visible at all: ${JSON.stringify(off)}`);
    expect(on.frac > 0.9 * off.frac, `worldlines removed the cube: share ${off.frac.toFixed(3)} -> ${on.frac.toFixed(3)}`);
    // occlusion: inside a solid box the lines are hidden; in smoke they show
    expect(Math.abs(on.mean - off.mean) < 1.5, `worldlines show through the solid box: mean ${off.mean.toFixed(1)} -> ${on.mean.toFixed(1)}`);
    const sOff = await fresh.evaluate(() => window.__gargantua.directorLuma(3.5, { worldlines: false, tau: 1, sep: 0 }, 4, 12));
    const sOn = await fresh.evaluate(() => window.__gargantua.directorLuma(3.5, { worldlines: true, tau: 1, sep: 0 }, 4, 12));
    expect(sOn.mean > sOff.mean + 5, `worldlines invisible in smoke: mean ${sOff.mean.toFixed(1)} -> ${sOn.mean.toFixed(1)}`);
    return `solid: share ${off.frac.toFixed(3)}/${on.frac.toFixed(3)}, mean ${off.mean.toFixed(1)}/${on.mean.toFixed(1)}; smoke mean ${sOff.mean.toFixed(1)} -> ${sOn.mean.toFixed(1)}`;
  } finally {
    await fresh.close();
  }
});
// ---- in-browser quick ingest (this static server reports no Python pipeline) ----------------------------------
await check("quick ingest: a dropped video decodes in the browser when no pipeline server exists", async () => {
  const clip = join(ROOT, "work", "testmedia", "plain.mp4");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#panel .btn", { hasText: "Open" }).first().click()]);
  await chooser.setFiles(clip);
  await page.waitForFunction(() => window.gargantua?.gvol?.header?.plan?.tier === "browser", null, { timeout: 120000 });
  const info = await page.evaluate(() => ({ plan: window.gargantua.gvol.header.plan, dims: window.gargantua.layer.stats.dims }));
  expect(info.plan.frames >= 80 && info.dims[2] === info.plan.frames, JSON.stringify(info));
  await shot("09_quick_ingest");
  return `${info.dims.join("x")} @ ${info.plan.fps} fps, ${info.plan.duration.toFixed(2)} s`;
});
await check("trim dialog: a 20 s clip asks for a 15 s window; Cancel keeps the current cube, Build uses the window", async () => {
  const clip = join(ROOT, "work", "testmedia", "long_20s.mp4");
  const open = async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#panel .btn", { hasText: "Open" }).first().click()]);
    await chooser.setFiles(clip);
    await page.waitForSelector("#trim[open]", { timeout: 15000 });
  };
  const before = await page.evaluate(() => window.gargantua.gvol.header.plan.duration);
  await open();
  const note = await page.locator("#trim .trim-note").textContent();
  expect(/20\.0 s/.test(note), `note: ${note}`);
  await page.locator("#trim button", { hasText: "Cancel" }).click();
  await page.waitForSelector("#trim", { state: "detached", timeout: 5000 });
  const afterCancel = await page.evaluate(() => window.gargantua.gvol.header.plan.duration);
  expect(afterCancel === before, `cancel changed the cube: ${before} -> ${afterCancel}`);
  await open();
  const range = page.locator("#trim input[type=range]");
  for (let i = 0; i < 35; i++) await range.press("ArrowRight"); // 35 x 0.1 s
  const label = await page.locator("#trim .trim-val").textContent();
  expect(label.startsWith("3.5 s"), `label: ${label}`);
  await shot("09b_trim_dialog");
  await page.locator("#trim button", { hasText: "Build cube" }).click();
  // the progress bar and status line report the decode while it runs
  await page.waitForFunction(() => /decoding in the browser ([4-9]\d|\d{3})\//.test(document.getElementById("status").textContent), null, { timeout: 60000 });
  await page.waitForTimeout(400); // let the bar's opacity transition settle
  const bar = await page.evaluate(() => ({ status: document.getElementById("status").textContent, width: document.getElementById("progress").style.width,
    opacity: getComputedStyle(document.getElementById("progress")).opacity }));
  expect(Number(bar.opacity) > 0.95 && parseInt(bar.width, 10) > 0, `progress bar: ${JSON.stringify(bar)}`);
  await page.waitForFunction(() => window.gargantua?.gvol?.header?.plan?.start > 0, null, { timeout: 240000 });
  const plan = await page.evaluate(() => window.gargantua.gvol.header.plan);
  expect(Math.abs(plan.start - 3.5) < 1e-6 && Math.abs(plan.duration - 15) < 1e-6 && plan.frames === 450, JSON.stringify(plan));
  return `cancel kept the ${before.toFixed(2)} s cube; progress "${bar.status}" at ${bar.width}; built ${plan.start}-${plan.start + plan.duration} s, ${plan.frames} frames`;
});
// ---- mouse orbit + touch-ready canvas -------------------------------------------------------------------------
await check("mouse orbit (drag) moves the camera", async () => {
  const before = await page.evaluate(() => window.gargantua.camera.position.toArray());
  await page.mouse.move(600, 450);
  await page.mouse.down();
  await page.mouse.move(760, 420, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.gargantua.camera.position.toArray());
  const moved = Math.hypot(...after.map((v, k) => v - before[k]));
  expect(moved > 0.1, `moved ${moved}`);
  return `moved ${moved.toFixed(2)}`;
});
await check("canvas declares touch-action none (touch orbit/zoom via OrbitControls)", async () => {
  const ta = await page.evaluate(() => getComputedStyle(document.querySelector("#stage canvas")).touchAction);
  expect(ta === "none", ta);
  return ta;
});
await check("touch: one-finger drag orbits, two-finger pinch zooms (real touch events, touch-enabled page)", async () => {
  const tctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const tp = await tctx.newPage();
  try {
    await tp.goto(`${srv.url}/?vol=/volumes/ui.gvol`);
    await tp.waitForFunction(() => window.gargantua?.layer, null, { timeout: 120000 });
    await tp.waitForTimeout(600);
    const cdp = await tctx.newCDPSession(tp);
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const cam = () => tp.evaluate(() => {
      const g = window.gargantua;
      return { pos: g.camera.position.toArray(), dist: g.camera.position.distanceTo(g.controls.target) };
    });
    const c0 = await cam();
    await touch("touchStart", [[380, 450]]);
    for (let k = 1; k <= 10; k++) await touch("touchMove", [[380 + k * 16, 450 - k * 3]]);
    await touch("touchEnd", []);
    await tp.waitForTimeout(500);
    const c1 = await cam();
    const orbit = Math.hypot(...c1.pos.map((v, k) => v - c0.pos[k]));
    expect(orbit > 0.1 && Math.abs(c1.dist - c0.dist) / c0.dist < 0.05, `orbit moved ${orbit}, dist ${c0.dist} -> ${c1.dist}`);
    await touch("touchStart", [[420, 450], [480, 450]]);
    for (let k = 1; k <= 10; k++) await touch("touchMove", [[420 - k * 14, 450], [480 + k * 14, 450]]);
    await touch("touchEnd", []);
    await tp.waitForTimeout(500);
    const c2 = await cam();
    expect(c2.dist < c1.dist * 0.9, `pinch-out should zoom in: dist ${c1.dist} -> ${c2.dist}`);
    return `orbit moved ${orbit.toFixed(2)} at constant distance; pinch dist ${c1.dist.toFixed(2)} -> ${c2.dist.toFixed(2)}`;
  } finally {
    await tctx.close();
  }
});
// ---- mobile layout --------------------------------------------------------------------------------------------
await check("mobile layout: menu button toggles the panel", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const visible = await page.locator("#menu-btn").isVisible();
  await page.locator("#menu-btn").click();
  const open = await page.evaluate(() => document.body.classList.contains("panel-open"));
  await page.waitForTimeout(600);
  await shot("08_mobile_panel");
  expect(visible && open, `menu ${visible} open ${open}`);
  return "panel opens on mobile";
});
await browser.close();
srv.close();
const failed = results.filter((r) => !r.ok);
const report = { volume: VOL, checks: results.length, passed: results.length - failed.length, failed: failed.length, console_errors: errors, results };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
console.log(`\n${report.passed}/${report.checks} passed, console errors: ${errors.length}`);
process.exit(failed.length || errors.length ? 1 : 0);
