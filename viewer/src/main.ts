import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./ui/styles.css";
import { Store, DEFAULTS, type Params } from "./app/state.ts";
import { fetchGvol, ingestOnServer, listVolumes, readFileGvol, serverInfo, type ServerInfo } from "./io/loader.ts";
import { quickIngest } from "./io/quickIngest.ts";
import type { Gvol } from "./io/gvol.ts";
import { VolumeLayer } from "./render/VolumeLayer.ts";
import { FlyControls } from "./render/FlyControls.ts";
import { Overlays } from "./render/Overlays.ts";
import { Worldlines } from "./render/Worldlines.ts";
import { Pipeline } from "./render/Pipeline.ts";
import { MAX_STEPS } from "./render/shaders.ts";
import type { DensityProfile } from "./render/transmittance.ts";
import { Director, camPosition, type CamKey } from "./director/Director.ts";
import { framingFit, reelSequence } from "./director/reelSequence.ts";
import { REEL, autoDensity, boxDims, evidenceGain, lookFromHeader, type LookParams } from "./look/LookDirector.ts";
import { Panel } from "./ui/Panel.ts";
import { Transport } from "./ui/Transport.ts";
import { el, toast } from "./ui/controls.ts";
import { installAutomation } from "./export/automation.ts";
import { askTrim } from "./ui/TrimDialog.ts";

type V3 = [number, number, number];
const qs = new URLSearchParams(location.search);
const EXPORT = qs.has("export");
const R2 = [0.7548776662466927, 0.5698402909980532];

export class App {
  readonly store = new Store();
  readonly renderer: THREE.WebGLRenderer;
  readonly pipeline: Pipeline;
  readonly camera = new THREE.PerspectiveCamera(REEL.fovDeg, 1, 0.005, 200);
  readonly controls: OrbitControls;
  readonly fly: FlyControls;
  readonly volScene = new THREE.Scene();
  readonly overlayScene = new THREE.Scene();
  readonly worldlineScene = new THREE.Scene();
  readonly overlays = new Overlays();
  readonly panel: Panel;
  readonly transport: Transport;
  gvol: Gvol | null = null;
  layer: VolumeLayer | null = null;
  worldlines: Worldlines | null = null;
  look: LookParams | null = null;
  box: V3 = [2, 1.125, 2.08];
  director: Director | null = null;
  tween: { d: Director; t: number } | null = null;
  clipName = "";
  gainA = 1;
  server: ServerInfo | null = null;
  frameIndex = 0;
  fixedSize: [number, number] | null = null;
  stepScaleOverride: number | null = null;
  dirtyOverlay = true;
  paused = false; // automation drives frames itself
  private interacting = false;
  private lastMatrix = new THREE.Matrix4();
  private lastVersion = -1;
  private lastTime = performance.now();
  private fpsAcc: number[] = [];
  private keys = new Set<string>();

  constructor() {
    const stage = document.getElementById("stage")!;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(EXPORT ? 1 : Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the final pass encodes sRGB itself
    this.renderer.toneMapping = THREE.NoToneMapping;
    stage.append(this.renderer.domElement);
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      toast("The GPU context was lost (out of video memory?). Reload, or rebuild the clip with --tier S.", "error", 12000);
    });
    this.pipeline = new Pipeline(this.renderer);
    this.overlayScene.add(this.overlays.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.085, rotateSpeed: 0.55, zoomSpeed: 0.8, panSpeed: 0.7, minDistance: 0.04, maxDistance: 40, screenSpacePanning: true });
    this.controls.addEventListener("start", () => {
      this.interacting = true;
      if (this.store.params.directorPlaying) this.store.set({ directorPlaying: false });
      this.tween = null;
    });
    this.controls.addEventListener("end", () => (this.interacting = false));
    this.fly = new FlyControls(this.camera, this.renderer.domElement, (mode) => {
      if (mode === "off") {
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        this.controls.target.copy(this.camera.position).addScaledVector(fwd, 0.3 * Math.hypot(...this.box));
        this.controls.enabled = true;
        return;
      }
      this.controls.enabled = false;
      toast(mode === "locked" ? "Fly mode: W A S D to move, Q / E down / up, Shift faster, Esc to exit"
        : "Fly mode (pointer lock unavailable here): drag to look, W A S D to move, Q / E down / up, Esc or F to exit", "info", 6000);
    });

    this.panel = new Panel(this.store, {
      cameraPreset: (n) => this.cameraPreset(n),
      toggleDirector: () => this.toggleDirector(),
      toggleFly: () => this.toggleFly(),
      savePreset: () => this.savePreset(),
      loadPreset: () => this.pickFile(".json"),
      resetLook: () => this.applyLookDefaults(),
      openFile: () => this.pickFile(),
      loadVolume: (url) => this.loadUrl(url),
    });
    this.transport = new Transport(this.store, () => this.toggleDirector(), (t) => this.seekDirector(t));
    document.body.append(this.panel.root, this.transport.root);

    this.store.on((changed, source) => {
      this.dirtyOverlay = true;
      if (changed.has("depthRatio") && this.gvol) this.applyBox();
      if (changed.has("wlColor")) this.worldlines?.setColor(this.store.params.wlColor);
      if (source === "ui" && (changed.has("tau") || changed.has("guides")) && this.store.params.directorPlaying) this.store.set({ directorPlaying: false });
    });
    this.installInput();
    this.installHelp();
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.applyCam({ az: 34, el: 23, dist: 7, target: [0, 0, 0], fov: REEL.fovDeg });
    if (EXPORT) document.body.classList.add("export");
    requestAnimationFrame((t) => this.loop(t));
  }

  // ------------------------------------------------------------------------------------------ loading
  async start() {
    this.server = await serverInfo();
    const vols = this.server ? await listVolumes() : [];
    const want = qs.get("vol") ?? vols[0]?.url;
    this.panel.setVolumes(vols, want ?? undefined);
    if (want) await this.loadUrl(want);
  }

  async loadUrl(url: string) {
    try {
      const g = await fetchGvol(url, (f, l) => this.progress(f, l));
      this.setVolume(g, decodeURIComponent(url.split("/").pop() || url));
    } catch (e) {
      this.progress(1, "");
      toast(String((e as Error).message ?? e), "error", 9000);
    }
  }

  async loadFile(file: File) {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".json")) {
        this.store.applyPreset(JSON.parse(await file.text()).params ?? {});
        toast(`Preset loaded: ${file.name}`);
        return;
      }
      if (name.endsWith(".gvol")) {
        this.setVolume(await readFileGvol(file, (f, l) => this.progress(f, l)), file.name);
        return;
      }
      if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|wmv|flv|3gp)$/i.test(name)) {
        toast(`${file.name} is not a video or .gvol file`, "warn");
        return;
      }
      const trim = await askTrim(file);
      if (trim.start === null) return; // cancelled in the trim dialog
      if (!trim.previewable) toast(`This browser cannot preview ${file.name}; the pipeline will use its first 15 s (CLI: --start to pick another window).`, "warn", 8000);
      if (this.server?.python) {
        const url = await ingestOnServer(file, { start: trim.start }, (f, l) => this.progress(f, l));
        await this.loadUrl(url);
        this.panel.setVolumes(await listVolumes(), url);
      } else {
        toast("No pipeline server: quick in-browser ingest (REEL mode only). Run `npm run dev` for the full pipeline.", "warn", 7000);
        this.setVolume(await quickIngest(file, (f, l) => this.progress(f, l), trim.start), file.name);
      }
    } catch (e) {
      this.progress(1, "");
      toast(String((e as Error).message ?? e), "error", 10000);
    }
  }

  setVolume(g: Gvol, name: string) {
    this.layer?.dispose();
    this.worldlines?.dispose();
    if (this.layer) this.volScene.remove(this.layer.mesh);
    if (this.worldlines) this.worldlineScene.remove(this.worldlines.lines.mesh);
    this.gvol = g;
    this.clipName = name;
    this.look = lookFromHeader(g.header);
    const plan = g.header.plan;
    this.progress(0.995, "uploading the volume to the GPU");
    this.layer = new VolumeLayer(g, this.box);
    this.volScene.add(this.layer.mesh);
    try {
      // upload every texture now: the CPU copies are released right after
      for (const k of ["uVolume", "uBricks", "uFlicker", "uPlate", "uNoise"]) this.renderer.initTexture(this.layer.u[k].value as THREE.Texture);
      const gl = this.renderer.getContext();
      const err = gl.getError();
      if (err === gl.OUT_OF_MEMORY) throw new Error("GPU out of memory while uploading the volume; rebuild with --tier S");
    } catch (e) {
      toast(String((e as Error).message ?? e), "error", 12000);
    }
    this.layer.dropCpuData();
    if (g.section("track_points")) {
      this.worldlines = new Worldlines(g, this.box);
      this.worldlineScene.add(this.worldlines.lines.mesh);
    } else this.worldlines = null;
    this.gainA = evidenceGain(g.header.evidence?.mean ?? g.header.look?.mean_evidence ?? 0.1);
    this.applyLookDefaults();
    this.applyBox();
    this.transport.duration = plan.duration;
    this.transport.fps = plan.fps;
    this.panel.setClip(g.header, name);
    document.getElementById("clipname")!.textContent = name;
    const q = g.header.analysis?.quality?.grade ?? "—";
    document.getElementById("chip")!.replaceChildren(
      el("span", { class: `q g-${String(q).toLowerCase()}` }, String(q)),
      el("span", {}, `${g.header.analysis?.category ?? ""} · ${g.header.camera?.class ?? ""}`));
    document.getElementById("empty")!.style.display = "none";
    this.cameraPreset("reel", 0);
    this.progress(1, "");
    if (g.header.camera?.class === "handheld" || g.header.camera?.class === "pan")
      toast(`Camera moves a lot (${g.header.camera.class}): frames are shown raw; the camera path is drawn as a worldline. Parallax cannot be corrected.`, "warn", 9000);
  }

  applyLookDefaults() {
    if (!this.look || !this.gvol) return;
    const l = this.look;
    const d = this.gvol.header.look?.preset_defaults ?? {};
    const patch: Partial<Params> = {
      ...DEFAULTS,
      sep: l.sep,
      flicker: l.flicker,
      bloom: l.bloom,
      exposure: l.exposure,
      emissiveGain: l.emissiveGain,
      worldlines: l.worldlines && !!this.worldlines,
      cameraPath: l.cameraPath,
      // dense scenes start with the 400 most significant tracks (sorted by length x speed in the pipeline)
      wlCount: Math.min(d.mode === "separated" || (this.gvol.header.analysis?.stats?.moving_frac ?? 0) > 0.05 ? 400 : 1500, this.worldlines?.trackCount ?? 0) || 400,
      plate: d.mode === "separated" ? 0.25 : 0,
      playing: false,
      directorPlaying: false,
      time: 0,
    };
    this.store.set(patch, "look");
  }

  applyBox() {
    if (!this.gvol || !this.layer) return;
    const plan = this.gvol.header.plan;
    const src = this.gvol.header.source ?? {};
    const aspect = (src.display_width ?? plan.width) / (src.display_height ?? plan.height);
    this.box = boxDims(aspect, this.store.params.depthRatio, 2);
    this.layer.setBox(this.box);
    this.overlays.setBox(this.box, REEL.wireInset, plan.duration);
    this.overlays.setCameraPath(this.gvol.section("camera_path") as Float32Array | undefined, plan.frames, this.store.params.cameraPath);
    if (this.worldlines) {
      this.worldlineScene.remove(this.worldlines.lines.mesh);
      this.worldlines.dispose();
      this.worldlines = new Worldlines(this.gvol, this.box);
      this.worldlines.setColor(this.store.params.wlColor);
      this.worldlineScene.add(this.worldlines.lines.mesh);
    }
    this.resize();
  }

  /** The reel sequence framed for the current output aspect (portrait outputs pull outside shots back). */
  rebuildDirector() {
    this.director = new Director(reelSequence(this.box, this.camera.aspect));
    this.transport.setKeys(this.director.keys.map((k) => k.t), this.director.duration);
  }

  // ------------------------------------------------------------------------------------------ camera
  applyCam(c: CamKey) {
    const p = camPosition(c);
    this.camera.position.set(...p);
    const roll = ((c.roll ?? 0) * Math.PI) / 180;
    this.camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    this.camera.lookAt(...c.target);
    if (Math.abs(this.camera.fov - c.fov) > 1e-6) {
      this.camera.fov = c.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.target.set(...c.target);
  }

  currentCam(): CamKey {
    const t = this.controls.target;
    const d = new THREE.Vector3().subVectors(this.camera.position, t);
    const dist = d.length();
    return { az: (Math.atan2(d.x, d.z) * 180) / Math.PI, el: (Math.asin(d.y / Math.max(dist, 1e-9)) * 180) / Math.PI, dist, target: [t.x, t.y, t.z], fov: this.camera.fov };
  }

  presetCam(name: string): CamKey {
    const [W, H, D] = this.box;
    const diag = Math.hypot(W, H, D);
    const fit = framingFit(this.camera.aspect); // same framing rule as reelSequence
    const far = 1.68 * diag * fit;
    switch (name) {
      case "front": return { az: 0, el: 0, dist: 1.5 * diag * fit, target: [0, 0, 0], fov: REEL.fovDeg };
      case "side": return { az: 90, el: 6, dist: far, target: [0, 0, 0], fov: REEL.fovDeg };
      case "top": return { az: 20, el: 84, dist: 1.45 * diag * fit, target: [0, 0, 0], fov: REEL.fovDeg };
      case "back": return { az: 205, el: 20, dist: far, target: [0, 0, 0], fov: REEL.fovDeg };
      case "inside": return { az: 4, el: 2, dist: 0.3 * D, target: [0, 0, -0.1 * D], fov: REEL.fovDeg };
      default: return { ...(reelSequence(this.box, this.camera.aspect)[0].cam as CamKey) };
    }
  }

  cameraPreset(name: string, seconds = 0.9) {
    this.store.set({ directorPlaying: false });
    const to = this.presetCam(name);
    if (seconds <= 0) {
      this.applyCam(to);
      return;
    }
    this.tween = { d: new Director([{ t: 0, cam: this.currentCam() }, { t: seconds, cam: to, ease: "inOut" }]), t: 0 };
  }

  toggleDirector() {
    if (!this.director) return;
    const p = this.store.params;
    const restart = p.directorTime >= this.director.duration - 1e-3;
    this.store.set({ directorPlaying: !p.directorPlaying, directorTime: restart ? 0 : p.directorTime });
  }

  seekDirector(t: number) {
    if (!this.director) return;
    const tt = Math.max(0, Math.min(this.director.duration, t));
    this.store.set({ directorTime: tt });
    this.applyDirector(tt);
  }

  applyDirector(t: number) {
    if (!this.director) return;
    const e = this.director.evaluate(t);
    this.applyCam(e.cam);
    this.store.set({ tau: e.params.tau ?? 0, guideOpacity: e.params.guides ?? 0 }, "director");
  }

  toggleFly() {
    if (this.fly.active) {
      this.fly.exit();
      return;
    }
    this.store.set({ directorPlaying: false });
    this.tween = null;
    this.fly.enter();
  }


  // ------------------------------------------------------------------------------------------ frame
  resize() {
    const [w, h] = this.fixedSize ?? [window.innerWidth, window.innerHeight];
    this.renderer.setSize(w, h, !this.fixedSize);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.gvol) this.rebuildDirector();
    const pr = this.renderer.getPixelRatio();
    this.overlays.setResolution(w * pr, h * pr);
    this.worldlines?.lines.setResolution(w * pr, h * pr);
    this.pipeline.resetAccumulation();
    this.dirtyOverlay = true;
  }

  densityProfile(): DensityProfile {
    const p = this.store.params;
    const [, , D] = this.box;
    const sigma = (p.autoDensity ? autoDensity(this.look?.tauTarget ?? REEL.tauTarget, D, 1) : 1 / D) * p.densityScale;
    return { box: this.box, sigmaSmoke: sigma * (p.smoke ? 1 : 0), sigmaSolid: (REEL.sigmaSolidPerDepth / D) * (p.smoke ? 1 : 0),
      tau: p.tau, tauDir: p.tauDir, field: 1, reveal: p.reveal ? p.time : undefined };
  }

  updateUniforms(moving: boolean) {
    if (!this.layer || !this.look) return;
    const p = this.store.params;
    const u = this.layer.u;
    const [W, H, D] = this.box;
    const frames = this.layer.frames;
    const prof = this.densityProfile();
    const stepScale = this.stepScaleOverride ?? (moving ? 2.0 : 1.0);
    (u.uCam.value as THREE.Vector3).copy(this.camera.position);
    u.uStep.value = (D / frames) * stepScale;
    u.uSigma.value = prof.sigmaSmoke;
    u.uSigmaSolid.value = prof.sigmaSolid;
    u.uTau.value = p.tau;
    u.uTauDir.value = p.tauDir;
    u.uTauSoft.value = 0.6 / frames;
    u.uSep.value = p.sep;
    u.uGainA.value = this.gainA;
    u.uFlickerMode.value = p.flicker;
    u.uEdgeSoft.value = Math.max(1e-4, p.edgeSoft * Math.min(W, H, D));
    u.uReveal.value = p.reveal ? p.time : 2;
    u.uPlateOpacity.value = p.plate;
    (u.uStretch.value as THREE.Vector2).set(this.look.stretch[0], this.look.stretch[1]);
    u.uSaturation.value = p.saturation;
    u.uEmissiveLuma.value = this.look.emissiveLuma;
    u.uEmissiveGain.value = p.emissiveGain;
    u.uSmokeOn.value = p.smoke ? 1 : 0;
    u.uDisplayBlend.value = p.displayBlend ? 1 : 0;
    const k = this.pipeline.accumulated + this.frameIndex * 61;
    (u.uNoiseOffset.value as THREE.Vector2).set(((k * R2[0]) % 1) * 64, ((k * R2[1]) % 1) * 64);
    return stepScale;
  }

  updateOverlays() {
    const p = this.store.params;
    const cam = this.camera.position;
    const prof = this.densityProfile();
    this.overlays.update({
      cam: [cam.x, cam.y, cam.z],
      prof,
      wire: p.wire,
      guides: p.guides ? p.guideOpacity : 0,
      cursor: p.showCursor ? p.time : null,
      wireAlpha: 0.85,
    });
    this.overlays.labels.visible = p.labels;
    this.overlays.camPath.mesh.visible = p.cameraPath && this.overlays.camPath.count > 0;
    if (this.worldlines) {
      const wl = this.worldlines;
      wl.lines.mesh.visible = p.worldlines;
      const smokeFrac = p.tauDir > 0 ? p.tau : 1 - p.tau;
      // brightness per line falls with the number drawn, so overlapping crowd flows keep their direction colours
      const drawn = Math.min(p.wlCount, wl.trackCount);
      wl.lines.material.uniforms.uIntensity.value = 1.4 * (0.05 + 0.95 * smokeFrac) * Math.min(1, Math.sqrt(120 / Math.max(drawn, 1)));
      const wu = wl.lines.material.uniforms;
      wu.uOcclude.value = 1; // lines inside the solid part of the cube are hidden, as the voxels in front would hide them
      (wu.uBoxHalf.value as THREE.Vector3).set(prof.box[0] / 2, prof.box[1] / 2, prof.box[2] / 2);
      (wu.uDensity.value as THREE.Vector4).set(prof.sigmaSmoke * prof.field, prof.sigmaSolid * prof.field, prof.tau, prof.tauDir);
      wu.uRevealT.value = prof.reveal ?? 2;
      const win = wl.lines.material.uniforms.uWindow.value as THREE.Vector4;
      const dur = this.gvol?.header.plan.duration ?? 1;
      win.set(p.wlWindow ? 1 : 0, p.time - 1 / dur, p.time + 1e-3, 0.25 / dur);
    }
  }

  renderFrame(moving: boolean, maxAccum: number, composite = true) {
    const p = this.store.params;
    const volumeScale = EXPORT ? 1 : moving ? 0.7 : 1; // export is always full resolution
    const dw = this.renderer.domElement.width, dh = this.renderer.domElement.height;
    this.pipeline.resize(dw, dh, volumeScale);
    if (this.worldlines) this.worldlines.setLimit(moving ? Math.max(10, p.wlCount * 0.45) : p.wlCount);
    const stepScale = this.updateUniforms(moving) ?? 1;
    if (this.dirtyOverlay) this.updateOverlays();
    const opts = { moving, maxAccum, bloom: p.bloom, exposure: p.exposure, vignette: p.vignette, grain: p.grain, frameIndex: this.frameIndex };
    const rendered = this.layer ? this.pipeline.renderVolume(this.volScene, this.camera, opts) : false;
    if (composite && (rendered || this.dirtyOverlay || !this.layer)) {
      this.pipeline.composite(this.overlayScene, this.camera, opts, null, this.worldlineScene);
      this.dirtyOverlay = false;
    }
    return { stepScale, volumeScale, rendered };
  }

  loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    if (EXPORT || this.paused) return; // export / automation drive frames themselves
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const p = this.store.params;
    if (p.playing && this.gvol) this.store.set({ time: (p.time + (dt * p.speed) / this.gvol.header.plan.duration) % 1 }, "playback");
    if (p.directorPlaying && this.director) {
      const t = Math.min(this.director.duration, p.directorTime + dt);
      this.store.set({ directorTime: t }, "director");
      this.applyDirector(t);
      if (t >= this.director.duration) this.store.set({ directorPlaying: false });
    } else if (this.tween) {
      this.tween.t = Math.min(this.tween.d.duration, this.tween.t + dt);
      this.applyCam(this.tween.d.evaluate(this.tween.t).cam);
      if (this.tween.t >= this.tween.d.duration) this.tween = null;
    } else if (this.fly.active) {
      this.fly.update(dt, this.keys, 0.45 * Math.hypot(...this.box));
    } else this.controls.update();

    this.camera.updateMatrixWorld();
    const camMoved = !this.camera.matrixWorld.equals(this.lastMatrix) || this.camera.projectionMatrix.elements[0] !== this.lastProj;
    this.lastMatrix.copy(this.camera.matrixWorld);
    this.lastProj = this.camera.projectionMatrix.elements[0];
    const visual = this.store.version !== this.lastVersion;
    this.lastVersion = this.store.version;
    if (camMoved || visual) {
      this.pipeline.resetAccumulation();
      this.dirtyOverlay = true;
    }
    const moving = camMoved || this.interacting || p.directorPlaying || !!this.tween || (p.playing && p.reveal);
    const r = this.renderFrame(moving, 48);
    this.frameIndex++;
    this.fpsAcc.push(dt);
    if (this.fpsAcc.length > 30) this.fpsAcc.shift();
    if (this.frameIndex % 15 === 0) this.updateHud(moving, r.stepScale, r.volumeScale);
  }

  private lastProj = 0;

  vramMB() {
    const wl = this.worldlines ? this.worldlines.lines.capacity * 72 : 0;
    return ((this.layer?.stats.bytesGPU ?? 0) + this.pipeline.targetBytes + wl) / 1e6;
  }

  updateHud(moving: boolean, stepScale: number, volumeScale: number) {
    const avg = this.fpsAcc.reduce((a, b) => a + b, 0) / Math.max(1, this.fpsAcc.length);
    const fps = avg > 0 ? 1 / avg : 0;
    const gpu = this.pipeline.timer.lastMs;
    const dw = this.renderer.domElement.width, dh = this.renderer.domElement.height;
    const mode = moving ? "interactive" : this.pipeline.accumulated >= 48 ? "refined (idle)" : `refining ${this.pipeline.accumulated}/48`;
    document.getElementById("hud")!.textContent = `${fps.toFixed(0)} fps · vol ${gpu > 0 ? gpu.toFixed(1) + " ms" : "—"} · ${mode}`;
    const frames = this.layer?.frames ?? 1;
    const diag = Math.hypot(...this.box);
    this.panel.setPerf({ fps, gpuMs: gpu, res: `${dw}×${dh} · vol ${Math.round(volumeScale * 100)}%`, steps: Math.min(MAX_STEPS, Math.ceil(diag / ((this.box[2] / frames) * stepScale))), vramMB: this.vramMB(), mode });
  }

  progress(f: number, label: string) {
    const bar = document.getElementById("progress")!;
    bar.style.width = `${Math.round(f * 100)}%`;
    bar.style.opacity = f >= 1 ? "0" : "1";
    document.getElementById("status")!.textContent = f >= 1 ? "" : label;
  }

  // ------------------------------------------------------------------------------------------ input
  pickFile(accept = "video/*,.gvol,.json") {
    const input = document.getElementById("file") as HTMLInputElement;
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) this.loadFile(f);
      input.value = "";
    };
    input.click();
  }

  savePreset() {
    const name = this.clipName.replace(/\.[^.]+$/, "") || "gargantua";
    const data = { gargantua_preset: 1, name, created: new Date().toISOString(), params: this.store.preset() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${name}.preset.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL((a as HTMLAnchorElement).href), 2000);
    try {
      const saved = JSON.parse(localStorage.getItem("gargantua.presets") || "[]");
      saved.unshift(data);
      localStorage.setItem("gargantua.presets", JSON.stringify(saved.slice(0, 20)));
    } catch {
      /* storage may be unavailable; the download is the durable copy */
    }
    toast(`Preset saved as ${name}.preset.json`);
  }

  installInput() {
    const drop = document.getElementById("drop")!;
    let depth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; drop.classList.add("on"); });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.classList.remove("on"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove("on");
      const f = e.dataTransfer?.files?.[0];
      if (f) this.loadFile(f);
    });
    document.getElementById("menu-btn")!.addEventListener("click", () => document.body.classList.toggle("panel-open"));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (document.querySelector("dialog[open]")) return; // the trim dialog owns the keyboard while open
      if (this.fly.active && "wasdqe".includes(k)) return;
      const s = this.store;
      const p = s.params;
      const step = (n: number) => this.gvol && s.set({ time: Math.max(0, Math.min(1, p.time + n / Math.max(1, this.gvol.header.plan.frames - 1))), showCursor: true });
      const presets = ["reel", "front", "side", "top", "back", "inside"];
      switch (k) {
        case " ": e.preventDefault(); s.set({ playing: !p.playing, showCursor: true }); break;
        case "arrowright": step(e.shiftKey ? 10 : 1); break;
        case "arrowleft": step(e.shiftKey ? -10 : -1); break;
        case "d": this.toggleDirector(); break;
        case "m": s.set({ sep: p.sep >= 0.5 ? 0 : 1 }); break;
        case "s": s.set({ smoke: !p.smoke }); break;
        case "w": s.set({ worldlines: !p.worldlines }); break;
        case "b": s.set({ wire: !p.wire }); break;
        case "g": s.set({ guides: !p.guides, guideOpacity: p.guideOpacity || 1 }); break;
        case "l": s.set({ labels: !p.labels }); break;
        case "p": s.set({ plate: p.plate > 0 ? 0 : 0.35 }); break;
        case "t": s.set({ tau: p.tau > 0.5 ? 0 : 0.85, guideOpacity: 1 }); break;
        case "[": s.set({ densityScale: Math.max(0.1, p.densityScale / 1.25) }); break;
        case "]": s.set({ densityScale: Math.min(10, p.densityScale * 1.25) }); break;
        case "f": this.toggleFly(); break;
        case "r": this.cameraPreset("reel"); break;
        case "o": this.pickFile(); break;
        case "h": document.body.classList.toggle("ui-hidden"); break;
        case "?": document.getElementById("help")!.classList.toggle("on"); break;
        case "escape": document.getElementById("help")!.classList.remove("on"); if (this.fly.active) this.fly.exit(); break;
        default:
          if (/^[1-6]$/.test(k)) this.cameraPreset(presets[Number(k) - 1]);
      }
    });
  }

  installHelp() {
    const rows: [string, string][] = [
      ["Space", "play / pause the clip cursor"], ["← →", "step one frame (Shift: 10)"], ["D", "play the reel camera sequence"],
      ["1-6", "camera presets: reel, front, side, top, back, inside"], ["drag", "orbit · right-drag pan · wheel zoom"],
      ["F", "free fly (WASD, Q/E, Esc)"], ["M", "REEL / SEPARATED"], ["T", "solid / dissolved"], ["[ ]", "smoke density"],
      ["S W B G L P", "smoke, worldlines, wireframe, guides, labels, context plate"], ["O", "open a video or .gvol"], ["H", "hide the interface"], ["?", "this help"],
    ];
    const help = document.getElementById("help")!;
    help.append(el("div", { class: "card" }, el("h2", {}, "Keyboard"), el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))));
    help.addEventListener("click", () => help.classList.remove("on"));
  }
}

const app = new App();
(window as unknown as { gargantua: App }).gargantua = app;
installAutomation(app);
app.start();
