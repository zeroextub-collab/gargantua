import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { accumFrag, copyFrag, finalFrag, fsVert, saturateFrag } from "./shaders.ts";

function rt(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function fsMaterial(frag: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: fsVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
}

/** GPU timer around the volume pass (EXT_disjoint_timer_query_webgl2). Results arrive a few frames late. */
class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  lastMs = 0;
  samples: number[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  get available() {
    return !!this.ext;
  }

  begin() {
    if (!this.ext || this.active || this.pending.length > 4) return;
    this.active = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active!);
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
      this.pending.shift();
      if (!disjoint) {
        this.lastMs = ns / 1e6;
        this.samples.push(this.lastMs);
        if (this.samples.length > 600) this.samples.shift();
      }
    }
  }
}

export interface FrameOptions {
  moving: boolean;
  maxAccum: number;
  bloom: number;
  exposure: number;
  vignette: number;
  grain: number;
  frameIndex: number;
}

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly timer: GpuTimer;
  private vol!: THREE.WebGLRenderTarget;
  private accA!: THREE.WebGLRenderTarget;
  private accB!: THREE.WebGLRenderTarget;
  private comp!: THREE.WebGLRenderTarget;
  private lines!: THREE.WebGLRenderTarget;
  private bloom: UnrealBloomPass;
  private quad = new FullScreenQuad();
  private accumMat = fsMaterial(accumFrag, { tPrev: { value: null }, tCur: { value: null }, uBlend: { value: 1 } });
  private copyMat = fsMaterial(copyFrag, { tSrc: { value: null } });
  private satMat = Object.assign(fsMaterial(saturateFrag, { tLines: { value: null } }), {
    transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  private finalMat = fsMaterial(finalFrag, {
    tColor: { value: null },
    uExposure: { value: 1 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.03 },
    uFrame: { value: 0 },
  });
  accumulated = 0;
  width = 1;
  height = 1;
  volumeScale = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.timer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.15, 0.32, 1.0);
    this.resize(2, 2, 1);
  }

  resize(w: number, h: number, volumeScale: number) {
    if (w === this.width && h === this.height && volumeScale === this.volumeScale && this.vol) return;
    this.width = w;
    this.height = h;
    this.volumeScale = volumeScale;
    [this.vol, this.accA, this.accB, this.comp, this.lines].forEach((t) => t?.dispose());
    const vw = Math.max(1, Math.round(w * volumeScale)), vh = Math.max(1, Math.round(h * volumeScale));
    this.vol = rt(vw, vh);
    this.accA = rt(vw, vh);
    this.accB = rt(vw, vh);
    this.comp = rt(w, h);
    this.lines = rt(w, h);
    this.bloom.setSize(w, h);
    this.accumulated = 0;
  }

  resetAccumulation() {
    this.accumulated = 0;
  }

  /** Bytes held by the pipeline's own render targets (half-float RGBA = 8 bytes / pixel). */
  get targetBytes() {
    const v = this.vol.width * this.vol.height * 8;
    return v * 3 + this.width * this.height * 8 * 4; // comp + worldline target + bloom mips (approx. two full-res targets)
  }

  /** Volume pass + accumulation. Returns false when the volume did not need re-rendering. */
  renderVolume(scene: THREE.Scene, camera: THREE.Camera, o: FrameOptions): boolean {
    const r = this.renderer;
    if (!o.moving && this.accumulated >= o.maxAccum) return false;
    this.timer.poll();
    this.timer.begin();
    r.setRenderTarget(this.vol);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(scene, camera);
    this.timer.end();
    if (o.moving || this.accumulated === 0) {
      this.copyMat.uniforms.tSrc.value = this.vol.texture;
      this.quad.material = this.copyMat;
      r.setRenderTarget(this.accA);
      this.quad.render(r);
      this.accumulated = o.moving ? 0 : 1;
    } else {
      this.accumMat.uniforms.tPrev.value = this.accA.texture;
      this.accumMat.uniforms.tCur.value = this.vol.texture;
      this.accumMat.uniforms.uBlend.value = 1 / (this.accumulated + 1);
      this.quad.material = this.accumMat;
      r.setRenderTarget(this.accB);
      this.quad.render(r);
      [this.accA, this.accB] = [this.accB, this.accA];
      this.accumulated++;
    }
    return true;
  }

  /** Composite accumulated volume + overlays, bloom, then the final tone-mapped pass to the canvas. */
  composite(overlay: THREE.Scene, camera: THREE.Camera, o: FrameOptions, target: THREE.WebGLRenderTarget | null = null, worldlines: THREE.Scene | null = null) {
    const r = this.renderer;
    if (worldlines && worldlines.children.some((c) => c.visible)) {
      r.setRenderTarget(this.lines);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.render(worldlines, camera);
    }
    this.copyMat.uniforms.tSrc.value = this.accA.texture;
    this.quad.material = this.copyMat;
    r.setRenderTarget(this.comp);
    this.quad.render(r);
    // everything below draws ON TOP of the copied volume: with autoClear on, three.js would clear the target
    // first and wipe the cube (it did: worldlines on left only lines and wireframe)
    r.autoClear = false;
    if (worldlines && worldlines.children.some((c) => c.visible)) {
      this.satMat.uniforms.tLines.value = this.lines.texture;
      this.quad.material = this.satMat;
      this.quad.render(r);
    }
    r.render(overlay, camera);
    r.autoClear = true;
    if (o.bloom > 0.001) {
      this.bloom.strength = o.bloom;
      this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.comp, 0, false);
    }
    const u = this.finalMat.uniforms;
    u.tColor.value = this.comp.texture;
    u.uExposure.value = o.exposure;
    u.uVignette.value = o.vignette;
    u.uGrain.value = o.grain;
    u.uFrame.value = o.frameIndex;
    this.quad.material = this.finalMat;
    r.setRenderTarget(target);
    this.quad.render(r);
  }
}
